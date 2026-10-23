// Vitest global setup: wrangler's local Browser Rendering downloads Chrome on
// its first launch. Test files start Workers in parallel, and on a fresh
// machine (CI) their launches raced on that download (spawn ETXTBSY). One
// render here installs Chrome before any test file runs.
import { fileURLToPath } from 'node:url';
import { unstable_startWorker } from 'wrangler';
import { browserEnv } from '../vitest.config.ts';

export default async function setup() {
  // The global setup runs in vitest's main process, which test.env doesn't
  // reach; set the browser variables only while it runs.
  const saved = Object.fromEntries(
    Object.keys(browserEnv).map(key => [key, process.env[key]]),
  );
  Object.assign(process.env, browserEnv);
  const token = 'browser-setup';
  const worker = await unstable_startWorker({
    config: fileURLToPath(new URL('../wrangler.jsonc', import.meta.url)),
    bindings: { PRINT_TOKEN: { type: 'plain_text', value: token } },
    dev: { server: { hostname: '127.0.0.1', port: 0 }, inspector: false },
  });
  try {
    const response = await fetch(new URL('/print', (await worker.url).href), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        html: '<!doctype html><html><body></body></html>',
        page: { size: 'A4', orientation: 'portrait' },
      }),
    });
    if (!response.ok) {
      throw new Error(
        `browser setup render failed: ${response.status} ${await response.text()}`,
      );
    }
  } finally {
    await worker.dispose();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}
