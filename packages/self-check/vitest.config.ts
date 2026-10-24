import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    include: ['src/**/*.test.ts'],
    // Chromium launches and PDF prints.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
