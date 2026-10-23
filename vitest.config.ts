import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Every workspace package is its own Vitest project, configured by its
    // vitest.config.ts.
    projects: ['apps/*', 'packages/*'],
  },
});
