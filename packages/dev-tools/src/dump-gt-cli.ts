// Dumps the ground truth of the repo's templates from the LOCAL stack:
// uploads each template pack to apps/web's public API, runs one batch per
// pack and writes <out>/<templateId>/<NNNN>/gt.json + check.json plus a
// summary.json:
//
//   node packages/dev-tools/src/dump-gt-cli.ts --out <dir> [--url <origin>]
//     [--seed s] [--count n] [--poll-ms ms] [pack dir…]
//
// With no pack dir, every templates/*/pack of the repo. --url must be local;
// --out must be empty or missing. Exit 0 when every fixture completed and
// passed its self-check, 1 otherwise or on any request error, 2 for usage
// errors and refusals.
import { mkdir, readdir } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { dumpGt, isLocalOrigin } from './dump-gt.ts';

const usage =
  'usage: node packages/dev-tools/src/dump-gt-cli.ts --out <dir> [--url <origin>] [--seed s] [--count n] [--poll-ms ms] [pack dir…]';

/** Usage errors and refusals exit 2. */
const refuse = (message: string): never => {
  throw new Error(message);
};

try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      url: { type: 'string', default: 'http://127.0.0.1:8787' },
      out: { type: 'string' },
      seed: { type: 'string', default: 'dump-gt' },
      count: { type: 'string', default: '10' },
      'poll-ms': { type: 'string', default: '2000' },
    },
  });
  // The local Access stand-in token grants full access to the stack: before
  // anything else, never send it anywhere but a local origin.
  if (values.url === undefined || !isLocalOrigin(values.url)) {
    refuse(
      `${usage}\nerror: --url must be a local origin (localhost, 127.0.0.0/8, [::1] or a worktree's <app>.<project>.liaoann.net)`,
    );
  }
  const url = values.url;
  if (values.out === undefined) refuse(usage);
  const out = values.out as string;
  const existing = await readdir(out).catch(() => undefined);
  if (existing !== undefined && existing.length > 0) {
    refuse(`error: output folder is not empty: ${out}`);
  }
  const count = Number(values.count);
  const pollMs = Number(values['poll-ms']);
  if (!Number.isInteger(count) || !(count > 0) || !(pollMs > 0)) {
    refuse(
      `${usage}\nerror: --count must be a positive integer, --poll-ms a positive number`,
    );
  }
  await mkdir(out, { recursive: true });
  try {
    process.exitCode = await dumpGt({
      url,
      out,
      seed: values.seed ?? 'dump-gt',
      count,
      pollMs,
      packs: positionals,
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message.includes(usage) ? message : `${message}\n${usage}`);
  process.exit(2);
}
