import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    include: ['src/**/*.test.{ts,tsx}', 'scripts/**/*.test.ts'],
    // Run inside workerd by vitest.workerd.config.ts.
    exclude: ['src/**/*.workerd.test.ts'],
  },
});
