import { fileURLToPath } from 'node:url';
import { apiErrorSchema, templateListSchema } from '@pdf-generator/contract';
import { drizzle } from 'drizzle-orm/d1';
import { migrate } from 'drizzle-orm/d1/migrator';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'vitest';
import { getPlatformProxy } from 'wrangler';
import { createLocalAccess, localServiceToken } from '../access/local.ts';
import { templates } from '../db/schema.ts';
import { createFetchHandler } from '../worker.ts';

const configPath = fileURLToPath(
  new URL('../../wrangler.jsonc', import.meta.url),
);
const migrationsFolder = fileURLToPath(
  new URL('../../drizzle', import.meta.url),
);
type LocalPlatform = Awaited<ReturnType<typeof getPlatformProxy<Env>>>;
let platform: LocalPlatform;
let unmigrated: LocalPlatform;

const local = createLocalAccess();
const fetch = createFetchHandler({
  pages: async () => new Response('page handler must not serve API routes'),
  access: () => local.config,
  edge: local.edge,
});

function get(path: string, env = platform.env) {
  return fetch(
    new Request(new URL(path, 'https://web.example.test'), {
      headers: {
        'CF-Access-Client-Id': localServiceToken.clientId,
        'CF-Access-Client-Secret': localServiceToken.clientSecret,
      },
    }),
    env,
  );
}

function unavailable<T extends object>(binding: T): T {
  // Fail the binding boundary without coupling the test to a probe method.
  return new Proxy(binding, {
    get(target, key) {
      const value: unknown = Reflect.get(target, key);
      if (typeof value !== 'function') return value;
      return () => {
        throw new Error('local dependency deliberately unavailable');
      };
    },
  });
}

beforeAll(async () => {
  platform = await getPlatformProxy<Env>({ configPath, persist: false });
  unmigrated = await getPlatformProxy<Env>({ configPath, persist: false });
  await migrate(drizzle(platform.env.DB), { migrationsFolder });
}, 60_000);

afterAll(async () => {
  await Promise.all([platform?.dispose(), unmigrated?.dispose()]);
}, 30_000);

beforeEach(async () => {
  await drizzle(platform.env.DB).delete(templates);
});

describe('GET /api/templates with migrated local storage', () => {
  test('lists every version in id then numeric version order with contract metadata', async () => {
    await drizzle(platform.env.DB)
      .insert(templates)
      .values([
        {
          id: 'z-report',
          version: 1,
          name: '月報',
          description: '最後一份樣板',
          pageSize: 'A4',
          orientation: 'landscape',
          packSha256: '0'.repeat(64),
          createdAt: new Date('2026-10-23T15:46:22.998Z'),
        },
        {
          id: 'a-report',
          version: 10,
          name: '月報第十版',
          description: '',
          pageSize: 'A4',
          orientation: 'landscape',
          packSha256: '0'.repeat(64),
          createdAt: new Date('2026-10-22T01:02:03.004Z'),
        },
        {
          id: 'a-report',
          version: 2,
          name: '月報第二版',
          description: null,
          pageSize: 'A4',
          orientation: 'portrait',
          packSha256: '0'.repeat(64),
          createdAt: new Date('2026-10-24T00:00:00.123Z'),
        },
      ]);

    const response = await get('/api/templates');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(
      /^application\/json\b/i,
    );
    const body = templateListSchema.parse(await response.json());
    expect(body).toEqual({
      templates: [
        {
          id: 'a-report',
          version: 2,
          name: '月報第二版',
          page: { size: 'A4', orientation: 'portrait' },
          createdAt: '2026-10-24T00:00:00.123Z',
        },
        {
          id: 'a-report',
          version: 10,
          name: '月報第十版',
          description: '',
          page: { size: 'A4', orientation: 'landscape' },
          createdAt: '2026-10-22T01:02:03.004Z',
        },
        {
          id: 'z-report',
          version: 1,
          name: '月報',
          description: '最後一份樣板',
          page: { size: 'A4', orientation: 'landscape' },
          createdAt: '2026-10-23T15:46:22.998Z',
        },
      ],
    });
  });

  test('returns an empty contract list when no templates have been uploaded', async () => {
    const response = await get('/api/templates');
    expect(response.status).toBe(200);
    expect(templateListSchema.parse(await response.json())).toEqual({
      templates: [],
    });
  });

  test('returns a sanitized database_error when migrations have not been applied', async () => {
    const response = await get('/api/templates', unmigrated.env);
    expect(response.status).toBe(500);
    const body = apiErrorSchema.parse(await response.json());
    expect(body.error.code).toBe('database_error');
    expect(body.error.message).not.toMatch(
      /no such table|D1_ERROR|SQLITE_ERROR|select\b.*\bfrom/i,
    );
  });
});

describe('GET /api/status dependency checks', () => {
  test('reports both real local bindings healthy', async () => {
    const response = await get('/api/status');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: 'ok',
      checks: { d1: 'ok', r2: 'ok' },
    });
  });

  test.each<{ failed: ('d1' | 'r2')[] }>([
    { failed: ['d1'] },
    { failed: ['r2'] },
    { failed: ['d1', 'r2'] },
  ])('reports exactly the failed checks: $failed', async ({ failed }) => {
    const response = await get('/api/status', {
      ...platform.env,
      DB: failed.includes('d1')
        ? unavailable(platform.env.DB)
        : platform.env.DB,
      FILES: failed.includes('r2')
        ? unavailable(platform.env.FILES)
        : platform.env.FILES,
    });
    expect(response.status).toBe(503);
    const body = apiErrorSchema.parse(await response.json());
    expect(body.error.code).toBe('dependency_unavailable');
    expect(body.error.details).toHaveLength(failed.length);
    for (const name of failed) {
      expect(
        body.error.details?.filter(detail => detail.message.startsWith(name)),
      ).toHaveLength(1);
    }
  });
});
