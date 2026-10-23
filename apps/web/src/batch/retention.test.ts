import { fileURLToPath } from 'node:url';
import { apiErrorSchema } from '@pdf-generator/contract';
import { drizzle } from 'drizzle-orm/d1';
import { migrate } from 'drizzle-orm/d1/migrator';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { getPlatformProxy } from 'wrangler';
import { createLocalAccess, localServiceToken } from '../access/local.ts';
import { batches, fixtures } from '../db/schema.ts';
import { createFetchHandler } from '../worker.ts';
import { type FixtureFile, fixtureKey } from './fixture.ts';
import { deleteExpiredBatches } from './retention.ts';

const configPath = fileURLToPath(
  new URL('../../wrangler.jsonc', import.meta.url),
);
const migrationsFolder = fileURLToPath(
  new URL('../../drizzle', import.meta.url),
);
type LocalPlatform = Awaited<ReturnType<typeof getPlatformProxy<Env>>>;
let platform: LocalPlatform;
const now = new Date('2026-10-24T12:34:56.789Z');
const day = 24 * 60 * 60 * 1000;
const local = createLocalAccess();
const fetch = createFetchHandler({
  pages: async () =>
    new Response('API unexpectedly reached pages', { status: 599 }),
  access: () => local.config,
  edge: local.edge,
});
const files: FixtureFile[] = ['fixture.pdf', 'gt.json', 'data.json'];

function request(id: string, suffix = '') {
  return fetch(
    new Request(`https://web.example.test/api/batches/${id}${suffix}`, {
      headers: {
        'CF-Access-Client-Id': localServiceToken.clientId,
        'CF-Access-Client-Secret': localServiceToken.clientSecret,
      },
    }),
    platform.env,
  );
}

async function seedBatch(
  id: string,
  status: typeof batches.$inferInsert.status,
  createdAt: Date,
  count = 1,
) {
  const db = drizzle(platform.env.DB);
  await db.insert(batches).values({
    id,
    templateId: 'fixture-report',
    templateVersion: 1,
    seed: 'retention-seed',
    count,
    status,
    createdAt,
    // Recent completion must not override expiration based on creation.
    finishedAt: status === 'completed' || status === 'failed' ? now : null,
  });
  const rows = Array.from({ length: count }, (_, index) => ({
    batchId: id,
    index,
    status: 'completed' as const,
    attempts: 1,
  }));
  // Each row has nine columns: keep every statement below D1's 100 binds.
  for (let offset = 0; offset < rows.length; offset += 10) {
    await db.insert(fixtures).values(rows.slice(offset, offset + 10));
  }
  const keys = rows.flatMap(row =>
    files.map(file => fixtureKey(id, row.index, file)),
  );
  for (let offset = 0; offset < keys.length; offset += 25) {
    await Promise.all(
      keys
        .slice(offset, offset + 25)
        .map(key => platform.env.FILES.put(key, key)),
    );
  }
  return keys;
}

async function storedKeys(prefix = '') {
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await platform.env.FILES.list({ prefix, cursor, limit: 1000 });
    keys.push(...page.objects.map(object => object.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor !== undefined);
  return keys.sort();
}

beforeEach(async () => {
  platform = await getPlatformProxy<Env>({ configPath, persist: false });
  await migrate(drizzle(platform.env.DB), { migrationsFolder });
}, 60_000);

afterEach(async () => {
  await platform?.dispose();
}, 30_000);

describe('finished batch retention with local D1 and R2', () => {
  test('removes expired completed and failed batches from HTTP, zip, D1 and R2 while preserving fresh, active and prefix-neighbor batches', async () => {
    const old = new Date(now.getTime() - 31 * day);
    const fresh = new Date(now.getTime() - day);
    const expired = ['old-completed', 'abc'] as const;
    await seedBatch(expired[0], 'completed', old);
    await seedBatch(expired[1], 'failed', old);
    const survivors = [
      { id: 'fresh-completed', status: 'completed', createdAt: fresh },
      { id: 'fresh-failed', status: 'failed', createdAt: fresh },
      { id: 'old-queued', status: 'queued', createdAt: old },
      { id: 'old-running', status: 'running', createdAt: old },
      { id: 'abcd', status: 'completed', createdAt: fresh },
    ] as const;
    const survivorKeys: string[] = [];
    for (const batch of survivors) {
      survivorKeys.push(
        ...(await seedBatch(batch.id, batch.status, batch.createdAt)),
      );
    }
    await platform.env.FILES.put('templates/keep/pack.zip', 'template pack');
    survivorKeys.push('templates/keep/pack.zip');
    for (const id of expired) {
      expect((await request(id)).status).toBe(200);
      const zip = await request(id, '/zip');
      expect(zip.status).toBe(200);
      await zip.arrayBuffer();
    }

    const deleted = await deleteExpiredBatches(
      { ...platform.env, BATCH_RETENTION_DAYS: '30' },
      now,
    );

    expect([...deleted].sort()).toEqual([...expired].sort());
    for (const id of expired) {
      for (const suffix of ['', '/zip']) {
        const response = await request(id, suffix);
        expect(response.status).toBe(404);
        expect(apiErrorSchema.parse(await response.json()).error.code).toBe(
          'batch_not_found',
        );
      }
    }
    const db = drizzle(platform.env.DB);
    const expectedIds = survivors.map(batch => batch.id).sort();
    expect((await db.select().from(batches)).map(row => row.id).sort()).toEqual(
      expectedIds,
    );
    expect(
      (await db.select().from(fixtures)).map(row => row.batchId).sort(),
    ).toEqual(expectedIds);
    expect(await storedKeys()).toEqual(survivorKeys.sort());
    for (const batch of survivors) {
      expect((await request(batch.id)).status).toBe(200);
    }
  });

  test('uses the configured day count and keeps the exact cutoff and the millisecond after it', async () => {
    const cutoff = now.getTime() - day;
    await seedBatch('just-expired', 'completed', new Date(cutoff - 1));
    const boundaryKeys = await seedBatch(
      'at-cutoff',
      'completed',
      new Date(cutoff),
    );
    const newerKeys = await seedBatch(
      'after-cutoff',
      'failed',
      new Date(cutoff + 1),
    );

    expect(
      await deleteExpiredBatches(
        { ...platform.env, BATCH_RETENTION_DAYS: '1' },
        now,
      ),
    ).toEqual(['just-expired']);

    expect(
      (await drizzle(platform.env.DB).select().from(batches))
        .map(row => row.id)
        .sort(),
    ).toEqual(['after-cutoff', 'at-cutoff']);
    expect(
      (await drizzle(platform.env.DB).select().from(fixtures))
        .map(row => row.batchId)
        .sort(),
    ).toEqual(['after-cutoff', 'at-cutoff']);
    expect(await storedKeys()).toEqual([...boundaryKeys, ...newerKeys].sort());
  });

  test.each([
    undefined,
    '',
    '0',
    '-1',
    '1.5',
    'abc',
    '1day',
    '1e1',
    ' 1',
    '1 ',
  ])(
    'fails closed for retention setting %j instead of deleting finished batches',
    async setting => {
      const keys = await seedBatch(
        'must-survive',
        'completed',
        new Date(now.getTime() - 365 * day),
      );
      const env = {
        DB: platform.env.DB,
        FILES: platform.env.FILES,
        ...(setting === undefined ? {} : { BATCH_RETENTION_DAYS: setting }),
      };

      expect(await deleteExpiredBatches(env, now)).toEqual([]);

      expect((await request('must-survive')).status).toBe(200);
      expect(
        (await drizzle(platform.env.DB).select().from(fixtures)).map(
          row => row.batchId,
        ),
      ).toEqual(['must-survive']);
      expect(await storedKeys()).toEqual(keys.sort());
    },
  );

  test('deletes all objects across R2 pages and delete limits, including files without fixture rows', async () => {
    // 335 fixtures produce 1,005 objects, crossing both R2's 1,000 limits.
    await seedBatch(
      'large-expired',
      'completed',
      new Date(now.getTime() - 31 * day),
      335,
    );
    await platform.env.FILES.put(
      'batches/large-expired/untracked/extra.bin',
      'orphan',
    );
    const survivorKeys = await seedBatch(
      'large-expired-neighbor',
      'completed',
      now,
    );
    expect((await storedKeys('batches/large-expired/')).length).toBe(1006);

    expect(
      await deleteExpiredBatches(
        { ...platform.env, BATCH_RETENTION_DAYS: '30' },
        now,
      ),
    ).toEqual(['large-expired']);

    expect(await storedKeys('batches/large-expired/')).toEqual([]);
    expect(await storedKeys()).toEqual(survivorKeys.sort());
    expect(
      (await drizzle(platform.env.DB).select().from(batches)).map(
        row => row.id,
      ),
    ).toEqual(['large-expired-neighbor']);
    expect(
      (await drizzle(platform.env.DB).select().from(fixtures)).map(
        row => row.batchId,
      ),
    ).toEqual(['large-expired-neighbor']);
  }, 60_000);
});
