import { fileURLToPath } from 'node:url';
import { defineProject } from 'vitest/config';

// wrangler's local Browser Rendering downloads Chrome to
// $XDG_CACHE_HOME/.wrangler/chrome and needs CI set to run it without a
// sandbox in a container (docs/findings/T03.md §7). Only this package's
// processes get them: other packages' Playwright also reads XDG_CACHE_HOME.
export const browserEnv = {
  CI: '1',
  XDG_CACHE_HOME: fileURLToPath(
    new URL('../../.wrangler/xdg', import.meta.url),
  ),
};

export default defineProject({
  test: {
    include: ['src/**/*.test.ts'],
    env: browserEnv,
    // Installs Chrome once before the test files start (see the file).
    globalSetup: ['src/test-browser-setup.ts'],
    // One test file at a time: each file's Worker keeps local R2 state in the
    // same .wrangler/state, whose store fails writes ("put: Unspecified
    // error") when several workerd processes use it at once. It also keeps a
    // single local Chrome running.
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
