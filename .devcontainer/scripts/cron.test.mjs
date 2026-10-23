import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { loadSchedules, parseCron, Scheduler, trigger } from './cron.mjs';
import { viteCommand, wranglerCommand } from './dev-servers.mjs';

async function workspace(t) {
  const root = await mkdtemp(join(tmpdir(), 'dev-cron-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return {
    root,
    async write(path, value) {
      const target = join(root, path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(
        target,
        typeof value === 'string' ? value : JSON.stringify(value),
      );
    },
  };
}

function worker(port, crons = ['* * * * *']) {
  return { dev: { port }, triggers: { crons } };
}

test('Cloudflare cron weekdays, UTC, calendar modifiers, and DOM/DOW OR semantics', () => {
  for (const [expression, yes, no] of [
    ['0 17 * * 1', '2026-09-20T17:00:00Z', '2026-09-21T17:00:00Z'],
    ['10 7 * * 2-6', '2026-09-21T07:10:00Z', '2026-09-20T07:10:00Z'],
    ['0 18 * * friL', '2026-09-25T18:00:00Z', '2026-09-18T18:00:00Z'],
    ['0 18 * * 6L', '2026-09-25T18:00:00Z', '2026-09-24T18:00:00Z'],
    ['59 23 LW * *', '2026-10-30T23:59:00Z', '2026-10-31T23:59:00Z'],
    ['0 9 15W * *', '2026-08-14T09:00:00Z', '2026-08-15T09:00:00Z'],
    ['0 0 * * 2#1', '2026-09-07T00:00:00Z', '2026-09-14T00:00:00Z'],
    ['0 0 1 * MON', '2026-09-01T00:00:00Z', '2026-09-02T00:00:00Z'],
    ['*/5 * * * *', '2026-09-20T00:10:00Z', '2026-09-20T00:11:00Z'],
  ]) {
    const cron = parseCron(expression);
    assert.equal(cron.match(new Date(yes)), true, expression);
    assert.equal(cron.match(new Date(no)), false, expression);
  }
  assert.throws(() => parseCron('* * * * * *'), /five-field/);
  assert.throws(() => parseCron('0 0 * * 0'));
  assert.throws(() => parseCron('60 * * * *'));
});

test('discovers monorepo JSONC, ignores generated directories and symlinks', async t => {
  const { root, write } = await workspace(t);
  await write(
    'apps/api/wrangler.jsonc',
    '{ // comment\n "dev": {"port": 8788}, "triggers": {"crons": ["* * * * *",]}, }',
  );
  await write(
    'apps/jobs/wrangler.jsonc',
    worker(8789, ['0 * * * *', '0 * * * *']),
  );
  for (const directory of [
    'node_modules/x',
    '.wrangler',
    '.git',
    'dist',
    'build',
  ]) {
    await write(`${directory}/wrangler.jsonc`, worker(8788));
  }
  await symlink(join(root, 'apps'), join(root, 'linked-apps'));
  await write('.devcontainer/cron-targets.jsonc', {
    workers: {
      'apps/api/wrangler.jsonc': { url: 'http://127.0.0.1:8788' },
      'apps/jobs/wrangler.jsonc': { url: 'http://127.0.0.1:8789' },
    },
  });
  const { jobs, diagnostics } = await loadSchedules(root, { servers: [] });
  assert.equal(jobs.length, 2);
  assert.deepEqual(
    jobs.map(job => job.url),
    ['http://127.0.0.1:8788', 'http://127.0.0.1:8789'],
  );
  assert.deepEqual(diagnostics, []);
});

test('stopped servers never fall back to Vite or Wrangler configured ports', async t => {
  const { root, write } = await workspace(t);
  await write('apps/web/package.json', { type: 'module' });
  await write('apps/web/wrangler.jsonc', worker(8787));
  await write('apps/web/vite.config.ts', 'export default {}');
  const resolveVite = async () => {
    throw new Error('Must not evaluate a stopped Vite app');
  };
  let result = await loadSchedules(root, { resolveVite, servers: [] });
  assert.equal(result.jobs.length, 0);
  assert.match(result.diagnostics[0], /waiting for a running dev server/);
  await write('apps/api/wrangler.jsonc', worker(8787));
  result = await loadSchedules(root, { resolveVite, servers: [] });
  assert.equal(result.jobs.length, 0);
  assert.equal(result.diagnostics.length, 2);
  await write('.devcontainer/cron-targets.jsonc', {
    workers: {
      'apps/web/wrangler.jsonc': { url: 'http://localhost:3000' },
    },
  });
  result = await loadSchedules(root, {
    servers: [],
    resolveVite: async () => {
      throw new Error('Must not load Vite');
    },
  });
  assert.equal(result.jobs[0].url, 'http://localhost:3000');
});

test('CLI parsing handles vite dev --port 3000 --host and equals syntax', () => {
  assert.deepEqual(
    viteCommand(
      [
        'node',
        '/app/node_modules/vite/bin/vite.js',
        'dev',
        '--port',
        '3000',
        '--host',
      ],
      '/app',
    ),
    {
      kind: 'vite',
      root: '/app',
      port: '3000',
      config: undefined,
      base: undefined,
    },
  );
  assert.equal(
    viteCommand(['node', '/bin/vite.js', '--port=3001'], '/app').port,
    '3001',
  );
  assert.equal(viteCommand(['node', '/bin/vite.js', 'preview'], '/app'), null);
  assert.equal(viteCommand(['node', 'other.js'], '/app'), null);
});

test('Wrangler CLI parsing matches explicit config, port and environment', () => {
  const command = wranglerCommand(
    [
      'node',
      '/tools/wrangler/wrangler-dist/cli.js',
      'dev',
      '-c',
      'apps/api/wrangler.jsonc',
      '--port=8788',
      '-e',
      'development',
    ],
    '/workspace',
  );
  assert.equal(command.kind, 'wrangler');
  assert.equal(command.config, '/workspace/apps/api/wrangler.jsonc');
  assert.equal(command.port, '8788');
  assert.equal(command.environment, 'development');
  assert.equal(
    wranglerCommand(
      ['node', '/bin/wrangler.js', 'dev', '--remote=true'],
      '/workspace',
    ),
    null,
  );
  assert.equal(
    wranglerCommand(['node', '/bin/wrangler.js', 'deploy'], '/workspace'),
    null,
  );
});

test('uses the running Vite HTTP port even when CLI and config ports differ', async t => {
  const { root, write } = await workspace(t);
  await write('package.json', { type: 'module' });
  await write('wrangler.jsonc', worker(8787));
  await write('vite.config.ts', 'export default {}');
  const server = createServer((request, response) => {
    assert.equal(request.url, '/@vite/client');
    response.end('export function createHotContext() {}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const servers = [
    {
      kind: 'vite',
      root,
      port: '3000',
      pid: 'test',
      listeners: [{ host: '127.0.0.1', port: server.address().port }],
    },
  ];
  const result = await loadSchedules(root, {
    servers,
    resolveVite: async () => {
      throw new Error('Runtime discovery should win');
    },
  });
  assert.equal(result.jobs[0].url, `http://127.0.0.1:${server.address().port}`);
  const ambiguous = await loadSchedules(root, {
    servers: [...servers, ...servers],
  });
  assert.equal(ambiguous.jobs.length, 0);
  assert.match(ambiguous.diagnostics[0], /Multiple dev servers/);
});

test('overrides select environments, disable workers, and reject URL collisions', async t => {
  const { root, write } = await workspace(t);
  await write('apps/a/wrangler.jsonc', {
    ...worker(8787),
    env: { development: { triggers: { crons: ['0 * * * *'] } } },
  });
  await write('apps/b/wrangler.jsonc', worker(8787));
  await write('.devcontainer/cron-targets.jsonc', {
    workers: {
      'apps/a/wrangler.jsonc': { url: 'http://127.0.0.1:8787' },
      'apps/b/wrangler.jsonc': { url: 'http://localhost:8787' },
    },
  });
  let result = await loadSchedules(root, { servers: [] });
  assert.equal(result.jobs.length, 0);
  assert.equal(result.diagnostics.length, 2);
  await write('.devcontainer/cron-targets.jsonc', {
    workers: {
      'apps/a/wrangler.jsonc': {
        environment: 'development',
        url: 'http://127.0.0.1:8788',
      },
      'apps/b/wrangler.jsonc': { enabled: false },
    },
  });
  result = await loadSchedules(root, { servers: [] });
  assert.equal(result.jobs.length, 1);
  assert.equal(result.jobs[0].cron, '0 * * * *');
  assert.deepEqual(result.diagnostics, []);
});

test('bad configs are isolated; malformed targets stop all dispatch', async t => {
  const { root, write } = await workspace(t);
  await write('good/wrangler.jsonc', worker(8788));
  await write('bad/wrangler.jsonc', '{ broken');
  await write('.devcontainer/cron-targets.jsonc', {
    workers: {
      'good/wrangler.jsonc': { url: 'http://127.0.0.1:8788' },
    },
  });
  let result = await loadSchedules(root, { servers: [] });
  assert.equal(result.jobs.length, 1);
  assert.match(result.diagnostics[0], /bad\/wrangler.jsonc/);
  await write('.devcontainer/cron-targets.jsonc', '{ broken');
  result = await loadSchedules(root, { servers: [] });
  assert.equal(result.jobs.length, 0);
  assert.match(result.diagnostics[0], /cron-targets.jsonc/);
});

test('one request per minute, no replay/retry, and configuration reload', async t => {
  const { root, write } = await workspace(t);
  await write('wrangler.jsonc', worker(8788));
  await write('.devcontainer/cron-targets.jsonc', {
    workers: {
      'wrangler.jsonc': { url: 'http://127.0.0.1:8788' },
    },
  });
  const requests = [];
  const logs = [];
  const scheduler = new Scheduler(root, {
    now: 0,
    request: async url => {
      requests.push(url);
      return new Response('failed', { status: 500 });
    },
    log: message => logs.push(message),
  });
  await scheduler.tick(30_000);
  assert.equal(requests.length, 0);
  await scheduler.tick(60_000);
  await scheduler.tick(65_000);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].searchParams.get('time'), '60000');
  assert.equal(requests[0].searchParams.get('cron'), '* * * * *');
  assert.match(logs.at(-1), /no retry/);
  await scheduler.tick(600_000);
  assert.equal(requests.length, 2);
  await write('wrangler.jsonc', worker(8788, []));
  await scheduler.tick(660_000);
  assert.equal(requests.length, 2);
});

test('scheduled request encodes cron/time, and rejects non-scheduled HTTP 200 responses', async t => {
  let received;
  const server = createServer((request, response) => {
    received = new URL(request.url, 'http://localhost');
    response.end('ok');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const job = {
    url: `http://127.0.0.1:${server.address().port}`,
    cron: '0 0 * * 2#1',
  };
  await trigger(job, 123_000);
  assert.equal(received.pathname, '/cdn-cgi/local/scheduled');
  assert.equal(received.searchParams.get('cron'), job.cron);
  assert.equal(received.searchParams.get('time'), '123000');
  await assert.rejects(
    trigger(job, 0, async () => new Response('<html>app</html>')),
    /HTTP 200/,
  );
});
