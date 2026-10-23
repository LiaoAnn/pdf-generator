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
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
