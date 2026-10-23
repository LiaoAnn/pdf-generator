import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { loadSchedules, parseCron, Scheduler, trigger } from './cron.mjs';

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
    'coverage',
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
  const { jobs, diagnostics } = await loadSchedules(root);
  assert.equal(jobs.length, 2);
  assert.deepEqual(
    jobs.map(job => job.url),
    ['http://127.0.0.1:8788', 'http://127.0.0.1:8789'],
  );
  assert.deepEqual(diagnostics, []);
});

test('unlisted crons get one actionable hint; silent workers stay silent', async t => {
  const { root, write } = await workspace(t);
  await write('missing/wrangler.jsonc', worker(8787));
  await write('empty/wrangler.jsonc', worker(8788, []));
  await write('env-only/wrangler.jsonc', {
    env: { development: { triggers: { crons: ['* * * * *'] } } },
  });
  const result = await loadSchedules(root);
  assert.deepEqual(result.jobs, []);
  assert.equal(result.diagnostics.length, 1);
  assert.match(result.diagnostics[0], /missing\/wrangler.jsonc/);
  assert.match(result.diagnostics[0], /not scheduled/);
  assert.match(result.diagnostics[0], /cron-targets\.jsonc/);
});

test('selected environment without a URL still gets the missing-target hint', async t => {
  const { root, write } = await workspace(t);
  await write('wrangler.jsonc', {
    env: { development: { triggers: { crons: ['* * * * *'] } } },
  });
  await write('.devcontainer/cron-targets.jsonc', {
    workers: { 'wrangler.jsonc': { environment: 'development' } },
  });
  const result = await loadSchedules(root);
  assert.deepEqual(result.jobs, []);
  assert.equal(result.diagnostics.length, 1);
  assert.match(
    result.diagnostics[0],
    /wrangler\.jsonc.*not scheduled.*cron-targets\.jsonc/,
  );
});

for (const url of [
  'http://localhost:8787',
  'http://host.docker.internal:8787',
  'http://192.0.2.1:8787',
  'ftp://127.0.0.1:8787',
  'http://127.0.0.1:8787/path',
  'http://127.0.0.1:8787/?query=1',
  'http://127.0.0.1:8787/#hash',
  'http://user:password@127.0.0.1:8787',
]) {
  test(`rejects unsafe target ${url} without dropping a valid worker`, async t => {
    const { root, write } = await workspace(t);
    await write('bad/wrangler.jsonc', worker(8787));
    await write('good/wrangler.jsonc', worker(8788));
    await write('.devcontainer/cron-targets.jsonc', {
      workers: {
        'bad/wrangler.jsonc': { url },
        'good/wrangler.jsonc': { url: 'http://127.0.0.1:8788' },
      },
    });
    const result = await loadSchedules(root);
    assert.deepEqual(
      result.jobs.map(job => job.label),
      ['good/wrangler.jsonc'],
    );
    assert.equal(result.diagnostics.length, 1);
    assert.match(result.diagnostics[0], /bad\/wrangler.jsonc/);
  });
}

test('accepts literal IPv4 loopback range and IPv6 as distinct origins', async t => {
  const { root, write } = await workspace(t);
  const workers = {};
  for (const [name, url] of Object.entries({
    ipv4: 'http://127.0.0.1:8787',
    ipv6: 'http://[::1]:8787',
    range: 'https://127.2.3.4:8788',
  })) {
    const label = `${name}/wrangler.jsonc`;
    await write(label, worker(8787));
    workers[label] = { url };
  }
  await write('.devcontainer/cron-targets.jsonc', { workers });
  const result = await loadSchedules(root);
  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(
    result.jobs.map(job => job.url).sort(),
    Object.values(workers)
      .map(target => target.url)
      .sort(),
  );
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
      'apps/b/wrangler.jsonc': { url: 'http://127.0.0.1:8787/' },
    },
  });
  let result = await loadSchedules(root);
  assert.equal(result.jobs.length, 0);
  assert.equal(result.diagnostics.length, 2);
  assert.ok(
    result.diagnostics.every(message => message.includes('shared URL')),
  );
  await write('.devcontainer/cron-targets.jsonc', {
    workers: {
      'apps/a/wrangler.jsonc': {
        environment: 'development',
        url: 'http://127.0.0.1:8788',
      },
      'apps/b/wrangler.jsonc': { enabled: false },
    },
  });
  result = await loadSchedules(root);
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
  let result = await loadSchedules(root);
  assert.equal(result.jobs.length, 1);
  assert.match(result.diagnostics[0], /bad\/wrangler.jsonc/);
  await write('.devcontainer/cron-targets.jsonc', '{ broken');
  result = await loadSchedules(root);
  assert.equal(result.jobs.length, 0);
  assert.match(result.diagnostics[0], /cron-targets.jsonc/);
});

test('environment without triggers inherits top-level crons', async t => {
  const { root, write } = await workspace(t);
  await write('wrangler.jsonc', { ...worker(8787), env: { development: {} } });
  await write('.devcontainer/cron-targets.jsonc', {
    workers: {
      'wrangler.jsonc': {
        environment: 'development',
        url: 'http://127.0.0.1:8787',
      },
    },
  });
  const result = await loadSchedules(root);
  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(
    result.jobs.map(job => job.cron),
    ['* * * * *'],
  );
});

test('invalid cron, unknown environment, and stale target keys preserve healthy jobs', async t => {
  const { root, write } = await workspace(t);
  await write('good/wrangler.jsonc', worker(8787));
  await write('cron/wrangler.jsonc', worker(8788, ['60 * * * *']));
  await write('env/wrangler.jsonc', worker(8789));
  await write('.devcontainer/cron-targets.jsonc', {
    workers: {
      'good/wrangler.jsonc': { url: 'http://127.0.0.1:8787' },
      'cron/wrangler.jsonc': { url: 'http://127.0.0.1:8788' },
      'env/wrangler.jsonc': {
        url: 'http://127.0.0.1:8789',
        environment: 'missing',
      },
      'gone/wrangler.jsonc': { url: 'http://127.0.0.1:8790' },
    },
  });
  const result = await loadSchedules(root);
  assert.deepEqual(
    result.jobs.map(job => job.label),
    ['good/wrangler.jsonc'],
  );
  assert.equal(result.diagnostics.length, 3);
  assert.ok(
    result.diagnostics.some(message => /cron\/wrangler.jsonc/.test(message)),
  );
  assert.ok(
    result.diagnostics.some(message =>
      /env\/wrangler.jsonc.*Unknown environment/.test(message),
    ),
  );
  assert.ok(
    result.diagnostics.some(message =>
      /gone\/wrangler.jsonc.*target config was not found/.test(message),
    ),
  );
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
