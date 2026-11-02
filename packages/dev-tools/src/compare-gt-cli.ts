// Compares two dump-gt output folders and prints every changed fixture,
// block, table cell and self-check, then the counts:
//
//   node packages/dev-tools/src/compare-gt-cli.ts <dump a> <dump b>
//
// Exit 0 when nothing differs, 1 when anything does, 2 for usage and input
// errors (a missing folder, a folder without summary.json).
import { parseArgs } from 'node:util';
import { compareGt } from './compare-gt.ts';

const usage =
  'usage: node packages/dev-tools/src/compare-gt-cli.ts <dump a> <dump b>';

try {
  const { positionals } = parseArgs({ allowPositionals: true });
  const [a, b] = positionals;
  if (a === undefined || b === undefined || positionals.length !== 2) {
    throw new Error(usage);
  }
  const result = await compareGt(a, b);
  console.log(result.lines.join('\n'));
  process.exitCode = result.different ? 1 : 0;
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message.includes(usage) ? message : `${message}\n${usage}`);
  process.exit(2);
}
