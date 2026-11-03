import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

const run = promisify(execFile);
const script = new URL('./post-create.sh', import.meta.url).pathname;

// Runs post-create.sh with stand-ins for sudo, pnpm, npm and playwright on
// PATH, so nothing is installed or chowned for real: each stand-in appends its
// name and arguments to a log, and the test reads what the script asked for.
// The environment matches the dev container's (HOME and
// PLAYWRIGHT_BROWSERS_PATH from docker-compose.yml), not the machine's.
async function postCreate(t) {
  const root = await mkdtemp(join(tmpdir(), 'dev-post-create-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const log = join(root, 'calls.log');
  const stub = async (name, extra = '') => {
    const path = join(root, name);
    await writeFile(
      path,
      `#!/bin/sh\necho "${name} $*" >> "${log}"\n${extra}exit 0\n`,
    );
    await chmod(path, 0o755);
  };
  await stub('sudo');
  await stub('pnpm');
  await stub('npm');
  // The installed version, so the script skips its global npm install.
  await stub(
    'playwright',
    'if [ "$1" = "--version" ]; then echo "Version 1.63.0"; fi\n',
  );
  await writeFile(log, '');
  await run('bash', [script], {
    env: {
      PATH: `${root}:${process.env.PATH}`,
      HOME: '/home/node',
      PLAYWRIGHT_BROWSERS_PATH: '/home/node/.cache/ms-playwright',
    },
  });
  return (await readFile(log, 'utf8')).trim().split('\n');
}

test('hands ~/.cache itself to node, not recursively, besides the Playwright volume', async t => {
  const calls = await postCreate(t);
  const chowns = calls.filter(call => call.startsWith('sudo chown '));
  // Docker creates /home/node/.cache as root when it mounts the
  // playwright_browsers volume below it; wrangler's local Browser Rendering
  // then cannot create ~/.cache/.wrangler (EACCES, T07-19).
  assert.ok(
    chowns.includes('sudo chown node:node /home/node/.cache'),
    `no non-recursive chown of /home/node/.cache in:\n${chowns.join('\n')}`,
  );
  assert.ok(
    chowns.includes('sudo chown node:node /home/node/.cache/ms-playwright'),
    `the Playwright volume's chown is gone:\n${chowns.join('\n')}`,
  );
  // A recursive chown would walk the shared playwright_browsers volume that
  // every worktree's container uses.
  assert.deepEqual(
    chowns.filter(
      call => /\s-R\b|--recursive/.test(call) && call.includes('/.cache'),
    ),
    [],
  );
});
