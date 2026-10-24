// Starts the print Worker for a test, on a free local port.
import { fileURLToPath } from 'node:url';
import { unstable_startWorker } from 'wrangler';

export type PrintWorker = Awaited<ReturnType<typeof unstable_startWorker>>;

/**
 * `token` sets PRINT_TOKEN; omitted, the Worker runs unconfigured. `vars`
 * sets other plain-text variables, such as ASSET_ORIGIN.
 *
 * Local storage stays in memory (`persist: false`). By default every print
 * Worker keeps it in apps/print/.wrangler/state, whose SQLite files (R2,
 * cache, the observability trace store written on every request) two workerd
 * processes can't open at once: starting two failed with SQLITE_BUSY_RECOVERY
 * and then hung requests until the test timed out (T16-2).
 */
export function startPrintWorker(
  token?: string,
  vars: Record<string, string> = {},
): Promise<PrintWorker> {
  const values = token === undefined ? vars : { PRINT_TOKEN: token, ...vars };
  return unstable_startWorker({
    config: fileURLToPath(new URL('../wrangler.jsonc', import.meta.url)),
    bindings: Object.fromEntries(
      Object.entries(values).map(([name, value]) => [
        name,
        { type: 'plain_text', value },
      ]),
    ),
    dev: {
      server: { hostname: '127.0.0.1', port: 0 },
      inspector: false,
      persist: false,
    },
  });
}
