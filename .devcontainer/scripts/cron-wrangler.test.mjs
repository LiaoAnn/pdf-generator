import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { loadSchedules, Scheduler } from './cron.mjs';

async function workspace(t) {
  const root = await mkdtemp(join(tmpdir(), 'cron-explicit-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function targets(root, workers) {
  await mkdir(join(root, '.devcontainer'), { recursive: true });
  await writeFile(
    join(root, '.devcontainer/cron-targets.jsonc'),
    JSON.stringify({ workers }),
  );
}

async function start(t, root, script, args) {
  const child = spawn(process.execPath, [script, ...args], {
    cwd: root,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
  });
  let output = '';
  child.stdout.on('data', data => {
    output += data;
  });
  child.stderr.on('data', data => {
    output += data;
  });
  const exited = once(child, 'exit');
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      process.kill(-child.pid, 'SIGTERM');
      await exited;
    }
  });
  for (let i = 0; i < 200; i++) {
    const ready = /Ready on (https?:\/\/[^\s]+)/.exec(output)?.[1];
    if (ready) return ready;
    assert.equal(child.exitCode, null, output);
    await delay(100);
  }
  assert.fail(`Server did not become ready: ${output}`);
}

async function wrangler(t, root, ip) {
  await writeFile(
    join(root, 'wrangler.jsonc'),
    JSON.stringify({
      name: 'cron-explicit-test',
      main: 'index.js',
      compatibility_date: '2026-09-20',
      triggers: { crons: ['* * * * *'] },
    }),
  );
  await writeFile(
    join(root, 'index.js'),
    `
    const events = [];
    export default {
      scheduled(controller) { events.push({ cron: controller.cron, time: controller.scheduledTime }); },
      fetch() { return Response.json(events); }
    };
  `,
  );
  const cli = fileURLToPath(
    new URL('../../node_modules/wrangler/bin/wrangler.js', import.meta.url),
  );
  return start(t, root, cli, [
    'dev',
    '--local',
    '--ip',
    ip,
    '--port',
    '0',
    '--inspector-port',
    '0',
  ]);
}

for (const ip of ['127.0.0.1', '::1']) {
  test(`Scheduler dispatches a listed real Wrangler Worker over ${ip}`, {
    timeout: 30_000,
  }, async t => {
    const root = await workspace(t);
    const origin = await wrangler(t, root, ip);
    await targets(root, { 'wrangler.jsonc': { url: origin } });
    const time = Date.parse('2026-09-20T12:01:00Z');
    const logs = [];
    const scheduler = new Scheduler(root, {
      now: time - 60_000,
      log: message => logs.push(message),
    });
    await scheduler.tick(time);
    assert.deepEqual(
      await (await fetch(origin)).json(),
      [{ cron: '* * * * *', time }],
      logs.join('\n'),
    );
  });
}

test('running Wrangler with no explicit target is not discovered or scheduled', {
  timeout: 30_000,
}, async t => {
  const root = await workspace(t);
  const origin = await wrangler(t, root, '127.0.0.1');
  const result = await loadSchedules(root);
  const scheduler = new Scheduler(root, { now: 0, log() {} });
  await scheduler.tick(60_000);
  const events = await (await fetch(origin)).json();
  assert.equal(
    result.jobs.length,
    0,
    'A live Worker must not become an implicit destination',
  );
  assert.equal(result.diagnostics.length, 1);
  assert.match(
    result.diagnostics[0],
    /wrangler\.jsonc.*not scheduled.*cron-targets\.jsonc/,
  );
  assert.deepEqual(events, []);
});

test('loading and a non-matching tick make zero requests even beside an unlisted live server', {
  timeout: 30_000,
}, async t => {
  const root = await workspace(t);
  // A real Vite-shaped CLI gives the old /proc discovery a listening socket to probe.
  await writeFile(
    join(root, 'vite.js'),
    `
    const { createServer } = require('node:http');
    const server = createServer((_request, response) => response.end('export function createHotContext() {}'));
    server.listen(0, '127.0.0.1', () => console.log('Ready on http://127.0.0.1:' + server.address().port));
  `,
  );
  const origin = await start(t, root, join(root, 'vite.js'), ['dev']);
  await writeFile(
    join(root, 'wrangler.jsonc'),
    JSON.stringify({ triggers: { crons: ['0 * * * *'] } }),
  );
  await writeFile(join(root, 'vite.config.ts'), 'export default {}');
  await mkdir(join(root, 'listed'));
  await writeFile(
    join(root, 'listed/wrangler.jsonc'),
    JSON.stringify({ triggers: { crons: ['0 * * * *'] } }),
  );
  // The listed destination is live too; neither load nor minute 1 should contact it.
  await targets(root, { 'listed/wrangler.jsonc': { url: origin } });
  const requests = [];
  const realFetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', (...args) => {
    requests.push(String(args[0]));
    return realFetch(...args);
  });
  await loadSchedules(root);
  const loadingRequests = requests.splice(0);
  await new Scheduler(root, { now: 0, log() {} }).tick(60_000);
  assert.deepEqual(
    { load: loadingRequests, tick: requests },
    { load: [], tick: [] },
    'Loading and non-matching ticks must not probe discovered or listed sockets',
  );
});
