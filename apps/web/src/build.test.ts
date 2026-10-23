import { execFile } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { apiErrorSchema } from '@pdf-generator/contract';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { unstable_startWorker } from 'wrangler';

const exec = promisify(execFile);
const webRoot = fileURLToPath(new URL('..', import.meta.url));
const serverRoot = resolve(webRoot, 'dist/server');
const commandOptions = {
  cwd: webRoot,
  // Vitest sets NODE_ENV=test; a production CLI build normally sets this itself.
  env: {
    ...process.env,
    NODE_ENV: 'production',
    WRANGLER_SEND_METRICS: 'false',
  },
  timeout: 120_000,
  maxBuffer: 10 * 1024 * 1024,
};
type BuiltWorker = Awaited<ReturnType<typeof unstable_startWorker>>;
let worker: BuiltWorker | undefined;

beforeAll(async () => {
  await exec(
    'pnpm',
    ['--filter', '@pdf-generator/web', 'build'],
    commandOptions,
  );
  worker = await unstable_startWorker({
    config: resolve(serverRoot, 'wrangler.json'),
    // The print Worker isn't running here, and a service binding to a Worker
    // that isn't running stops the runtime from starting. Nothing in these
    // tests prints.
    bindings: { PRINT: { type: 'plain_text', value: 'not used' } },
    dev: {
      remote: false,
      persist: false,
      server: { port: 0 },
      inspector: false,
      watch: false,
    },
  });
  await worker.ready;
}, 120_000);

afterAll(async () => {
  await worker?.dispose();
}, 30_000);

function request(path: string, init?: Parameters<BuiltWorker['fetch']>[1]) {
  if (!worker) throw new Error('Built Worker has not started');
  return worker.fetch(`https://web.example.test${path}`, init);
}

// Keep these independent of the dev module: importing it into this test must
// not obscure whether the actual production artifact includes the stand-in.
const localToken = {
  'CF-Access-Client-Id': 'local-dev.access',
  'CF-Access-Client-Secret': 'local-dev-secret',
};

describe('production Worker with unconfigured Cloudflare Access', () => {
  test('keeps GET /health public while the rest of the site is closed', async () => {
    const response = await request('/health');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok', service: 'web' });
  });

  test.each([
    { path: '/api/status', headers: {} },
    { path: '/api/templates', headers: localToken },
    { path: '/api/unknown', headers: localToken },
  ])(
    'refuses $path before routing, even with dev credentials: $headers',
    async ({ path, headers }) => {
      const response = await request(path, { headers });
      expect(response.status).toBe(503);
      expect(response.headers.get('content-type')).toMatch(
        /^application\/json\b/i,
      );
      expect(apiErrorSchema.parse(await response.json()).error.code).toBe(
        'access_not_configured',
      );
    },
  );

  test.each([
    { path: '/', method: 'GET', headers: {} },
    { path: '/', method: 'GET', headers: localToken },
    { path: '/health', method: 'POST', headers: {} },
    { path: '/missing', method: 'GET', headers: {} },
  ])(
    'does not serve pages or extend the health exception to $method $path ($headers)',
    async ({ path, method, headers }) => {
      const response = await request(path, { method, headers });
      expect(response.status).toBe(503);
      expect(response.headers.get('set-cookie') ?? '').not.toMatch(
        /CF_Authorization=/i,
      );
    },
  );

  test.each(['GET', 'POST'])(
    'cannot sign anyone in through the dev-only %s /__access/login',
    async method => {
      const response = await request('/__access/login', {
        method,
        redirect: 'manual',
        ...(method === 'POST'
          ? { body: new URLSearchParams({ email: 'outsider@example.test' }) }
          : {}),
      });
      expect(response.status).toBe(503);
      expect(response.headers.get('set-cookie') ?? '').not.toMatch(
        /CF_Authorization=/i,
      );
      expect(await response.text()).not.toMatch(/<form\b/i);
    },
  );
});

test('Wrangler follows the generated deploy redirect and accepts the built Worker without Cloudflare', async () => {
  const { stdout } = await exec(
    'pnpm',
    ['exec', 'wrangler', 'deploy', '--dry-run'],
    commandOptions,
  );
  expect(stdout).toContain('--dry-run: exiting now.');
}, 120_000);

test('excludes the local Access stand-in from every production JavaScript chunk', async () => {
  const entries = await readdir(serverRoot, { recursive: true });
  const scripts = entries.filter(path => path.endsWith('.js'));
  expect(scripts).toContain('index.js');
  for (const path of scripts) {
    const source = await readFile(resolve(serverRoot, path), 'utf8');
    expect(
      source.match(
        /local-dev-secret|local-dev\.access|access\.localhost|\/__access\/login/,
      )?.[0],
      path,
    ).toBeUndefined();
  }
});
