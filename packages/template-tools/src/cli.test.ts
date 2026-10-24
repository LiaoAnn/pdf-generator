import { spawnSync } from 'node:child_process';
import {
  cpSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync } from 'fflate';
import { afterEach, describe, expect, it } from 'vitest';
import { type CheckResult, checkPack, type PackIssue } from './index.ts';

const packageDir = fileURLToPath(new URL('../', import.meta.url));
const fixtures = join(packageDir, 'fixtures');
const broken = readdirSync(join(fixtures, 'broken')).sort();
const temporary: string[] = [];

afterEach(() => {
  for (const directory of temporary.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function tempDirectory() {
  const directory = mkdtempSync(join(tmpdir(), 'check-pack-'));
  temporary.push(directory);
  return directory;
}

function filesIn(directory: string): Record<string, Uint8Array> {
  return Object.fromEntries(
    readdirSync(directory, { recursive: true, withFileTypes: true })
      .filter(entry => entry.isFile())
      .map(entry => {
        const absolute = join(entry.parentPath, entry.name);
        const relative = absolute
          .slice(directory.length + 1)
          .replaceAll('\\', '/');
        return [relative, readFileSync(absolute)];
      }),
  );
}

function run(args: string[], initCwd: string | null = packageDir) {
  const env = { ...process.env };
  if (initCwd === null) delete env.INIT_CWD;
  else env.INIT_CWD = initCwd;
  return spawnSync(process.execPath, ['src/cli.ts', ...args], {
    cwd: packageDir,
    env,
    encoding: 'utf8',
    timeout: 15_000,
  });
}

function textOutput(issues: PackIssue[]): string {
  const sorted = [...issues].sort(
    (a, b) =>
      a.file.localeCompare(b.file) ||
      (a.line ?? 0) - (b.line ?? 0) ||
      (a.column ?? 0) - (b.column ?? 0),
  );
  return sorted
    .map(issue => {
      const location =
        issue.line === undefined ? '' : `:${issue.line}:${issue.column}`;
      const path = issue.path
        ?.map((key, index) =>
          typeof key === 'number' ? `[${key}]` : `${index ? '.' : ''}${key}`,
        )
        .join('');
      return `${issue.file}${location}: ${issue.code}: ${issue.message}${path === undefined ? '' : ` (at ${path})`}\n`;
    })
    .join('');
}

function expectJson(args: string[], expected: CheckResult) {
  const result = run([...args, '--json']);
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(expected.ok ? 0 : 1);
  expect(result.stderr).toBe('');
  expect(result.stdout).toBe(
    `${JSON.stringify({ ok: expected.ok, issues: expected.issues })}\n`,
  );
}

describe('Node check-pack CLI for local pack authors', () => {
  it('prints the manifest id and exits zero for a recursively read valid directory', () => {
    const result = run([join(fixtures, 'valid')]);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('ok: taiwan-monthly-report\n');
    expect(result.stderr).toBe('');
  });

  it.each(broken)(
    'prints actionable source locations and exits one for %s',
    slug => {
      const directory = join(fixtures, 'broken', slug, 'pack');
      const expected = checkPack(filesIn(directory));
      expect(expected.ok).toBe(false);
      const result = run([directory]);
      expect(result.status).toBe(1);
      expect(result.stderr).toBe('');
      expect(result.stdout).toBe(textOutput(expected.issues));
    },
  );

  it.each(['valid', 'broken/01-missing-stylesheet/pack'])(
    'emits only the JSON check result without pack bytes for %s',
    relative => {
      const directory = join(fixtures, relative);
      expectJson([directory], checkPack(filesIn(directory)));
    },
  );

  it.each(['valid', 'broken/06-field-typo/pack'])(
    'reads zip file bytes and preserves the exit status for %s',
    relative => {
      const zip = zipSync(filesIn(join(fixtures, relative)));
      const filename = join(tempDirectory(), 'monthly report.zip');
      writeFileSync(filename, zip);
      expectJson([filename], checkPack(zip));
    },
  );

  it('resolves a relative pack against INIT_CWD when pnpm changes the process cwd', () => {
    const directory = tempDirectory();
    cpSync(join(fixtures, 'valid'), join(directory, 'monthly report'), {
      recursive: true,
    });
    const result = run(['monthly report'], directory);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('ok: taiwan-monthly-report\n');
    expect(result.stderr).toBe('');
  });

  it('falls back to process cwd when INIT_CWD is absent', () => {
    const result = run(['fixtures/valid'], null);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('ok: taiwan-monthly-report\n');
  });

  it('sorts multiple issues by file, line and column and omits absent locations', () => {
    const directory = join(tempDirectory(), 'pack');
    cpSync(join(fixtures, 'valid'), directory, { recursive: true });
    writeFileSync(join(directory, 'z-extra.txt'), 'accidentally included');
    writeFileSync(
      join(directory, 'templates/report.hbs'),
      '<p data-gt="field">{{missing}}</p>\n<p data-gt="field">{{otherMissing}}</p><p>unmarked<span>also unmarked</span></p>\n',
    );
    const expected = checkPack(filesIn(directory));
    expect(expected.issues.length).toBeGreaterThan(3);
    const result = run([directory]);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe(textOutput(expected.issues));
    expect(result.stderr).toBe('');
  });

  it.each([
    { name: 'missing argument', args: [] },
    { name: 'nonexistent input', args: [join(fixtures, 'does-not-exist')] },
  ])('reports $name on stderr with usage exit code two', ({ args }) => {
    const result = run(args);
    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr.trim().length).toBeGreaterThan(0);
    expect(result.stderr).not.toContain('not implemented');
  });
});
