import { defineProject } from 'vitest/config';

export default defineProject({
  resolve: { tsconfigPaths: true },
  test: {
    include: ['src/**/*.test.{ts,tsx}', 'scripts/**/*.test.ts'],
    // Run inside workerd by vitest.workerd.config.ts.
    exclude: ['src/**/*.workerd.test.ts'],
    setupFiles: ['src/test-setup.ts'],
    // Tests against local D1 and R2 make many round trips to workerd and
    // wait on no clock. Under one full `pnpm verify` the slowest on the
    // default 5 s took 2.3-2.9 s (retention, batches, queue, fixture-files),
    // and 5 s ran out on the VM shared by several worktrees (T07-13, T09-3).
    testTimeout: 30_000,
  },
});
