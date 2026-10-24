import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Every workspace package is its own Vitest project, configured by its
    // vitest.config.ts; apps/web also has a project that runs in workerd.
    projects: [
      'apps/*',
      'apps/web/vitest.workerd.config.ts',
      'packages/*',
      'templates/*',
    ],
  },
});
