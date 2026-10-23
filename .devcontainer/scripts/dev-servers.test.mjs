import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { loadSchedules, trigger } from './cron.mjs';

test('Wrangler discovery uses its live workerd port, skips the occupied config port, and forgets stopped servers', {
  timeout: 30_000,
}, async t => {
  const root = await mkdtemp(join(tmpdir(), 'dev-cron-wrangler-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let unrelatedRequests = 0;
  const unrelated = createServer((_request, response) => {
    unrelatedRequests++;
    response.end('unrelated service');
  });
  await new Promise(resolve => unrelated.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => unrelated.close(resolve)));
  await writeFile(
    join(root, 'wrangler.jsonc'),
    JSON.stringify({
      name: 'cron-live-port-test',
      main: 'index.js',
      compatibility_date: '2026-09-20',
      dev: { port: unrelated.address().port },
      triggers: { crons: ['0 0 * * *'] },
      env: { development: { triggers: { crons: ['* * * * *'] } } },
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
  const child = spawn(
    process.execPath,
    [
      cli,
      'dev',
      '--local',
      '--env',
      'development',
      '--config',
      join(root, 'wrangler.jsonc'),
      '--port',
      '0',
      '--inspector-port',
      '0',
    ],
    {
      cwd: root,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
    },
  );
  let output = '';
  child.stdout.on('data', data => {
    output += data;
  });
  child.stderr.on('data', data => {
    output += data;
  });
  const exited = once(child, 'exit');
  async function stop() {
    if (child.exitCode === null && child.signalCode === null) {
      process.kill(-child.pid, 'SIGTERM');
      await exited;
    }
  }
  t.after(stop);
  for (let i = 0; i < 80 && !output.includes('Ready on'); i++) {
    assert.equal(child.exitCode, null, output);
    await delay(100);
  }
  const ready = /Ready on (https?:\/\/[^\s]+)/.exec(output)?.[1];
  assert.ok(ready, output);
  const result = await loadSchedules(root);
  assert.equal(result.jobs.length, 1, JSON.stringify(result.diagnostics));
  const job = result.jobs[0];
  assert.equal(new URL(job.url).port, new URL(ready).port);
  assert.notEqual(Number(new URL(job.url).port), unrelated.address().port);
  assert.equal(
    unrelatedRequests,
    0,
    'Discovery must not probe the occupied config port',
  );
  assert.deepEqual(
    await (await fetch(job.url)).json(),
    [],
    'Discovery must not trigger a scheduled event',
  );
  await trigger(job, 1789913100000);
  assert.deepEqual(await (await fetch(job.url)).json(), [
    { cron: '* * * * *', time: 1789913100000 },
  ]);
  await stop();
  const stopped = await loadSchedules(root);
  assert.equal(stopped.jobs.length, 0);
  assert.match(stopped.diagnostics[0], /waiting for a running dev server/);
  assert.equal(unrelatedRequests, 0);
});
