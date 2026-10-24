// Thin Node wrapper for local use (pdf2tpl, agents writing packs):
//   node packages/template-tools/src/cli.ts <pack directory or .zip> [--json]
//   pnpm --filter @pdf-generator/template-tools check-pack <pack> [--json]
// The checks themselves are in checkPack, which needs no file system.
// Exit code: 0 the pack passes, 1 it has issues, 2 usage error.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { checkPack, type PackIssue } from './index.ts';

const usage = 'usage: check-pack <pack directory or .zip> [--json]';

/** Every file under `directory`, by its `/`-separated path relative to it. */
function readDirectory(directory: string): Record<string, Uint8Array> {
  return Object.fromEntries(
    readdirSync(directory, { recursive: true, withFileTypes: true })
      .filter(entry => entry.isFile())
      .map(entry => {
        const file = join(entry.parentPath, entry.name);
        return [
          relative(directory, file).split(sep).join('/'),
          readFileSync(file),
        ];
      }),
  );
}

/** `files.styles[1]` for `['files', 'styles', 1]`. */
const jsonPath = (path: (string | number)[]) =>
  path
    .map((key, i) =>
      typeof key === 'number' ? `[${key}]` : `${i === 0 ? '' : '.'}${key}`,
    )
    .join('');

const line = (issue: PackIssue) =>
  `${issue.file}${issue.line === undefined ? '' : `:${issue.line}:${issue.column}`}: ${issue.code}: ${issue.message}${issue.path === undefined ? '' : ` (at ${jsonPath(issue.path)})`}`;

const byLocation = (a: PackIssue, b: PackIssue) =>
  (a.file < b.file ? -1 : a.file > b.file ? 1 : 0) ||
  (a.line ?? 0) - (b.line ?? 0) ||
  (a.column ?? 0) - (b.column ?? 0);

function main(args: string[]): number {
  const json = args.includes('--json');
  const [target, ...extra] = args.filter(arg => arg !== '--json');
  if (target === undefined || extra.length > 0) {
    console.error(usage);
    return 2;
  }
  // pnpm runs package scripts in the package directory; INIT_CWD is where
  // the user ran pnpm, which is what a relative path means to them.
  const path = resolve(process.env.INIT_CWD ?? process.cwd(), target);
  let input: Uint8Array | Record<string, Uint8Array>;
  try {
    input = statSync(path).isDirectory()
      ? readDirectory(path)
      : new Uint8Array(readFileSync(path));
  } catch (error) {
    console.error(
      `check-pack: cannot read ${path}: ${(error as Error).message}`,
    );
    console.error(usage);
    return 2;
  }

  const { ok, issues, pack } = checkPack(input);
  if (json) console.log(JSON.stringify({ ok, issues }));
  else if (ok) console.log(`ok: ${pack?.manifest.id}`);
  else
    for (const issue of [...issues].sort(byLocation)) console.log(line(issue));
  return ok ? 0 : 1;
}

process.exitCode = main(process.argv.slice(2));
