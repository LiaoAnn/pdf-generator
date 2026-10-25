/// <reference types="node" />
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import {
  type CheckResult,
  checkPack,
  fill,
  type PackIssue,
  TemplateError,
} from './index.ts';

const packageDir = fileURLToPath(new URL('../', import.meta.url));
const fixtures = join(packageDir, 'fixtures/hardening');
const slugs = readdirSync(fixtures, { withFileTypes: true })
  .filter(entry => entry.isDirectory())
  .map(entry => entry.name)
  .sort();

function readPack(directory: string): Record<string, Uint8Array> {
  return Object.fromEntries(
    readdirSync(directory, { recursive: true, withFileTypes: true })
      .filter(entry => entry.isFile())
      .map(entry => {
        const file = join(entry.parentPath, entry.name);
        return [
          relative(directory, file).split('\\').join('/'),
          readFileSync(file),
        ];
      }),
  );
}

function cli(directory: string) {
  return spawnSync(process.execPath, ['src/cli.ts', directory, '--json'], {
    cwd: packageDir,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    timeout: 15_000,
  });
}

function expectResult(
  result: CheckResult,
  issues: Omit<PackIssue, 'message'>[],
) {
  expect(result.ok).toBe(issues.length === 0);
  expect(
    result.issues.map(({ message, ...issue }) => {
      expect(message.trim().length).toBeGreaterThan(0);
      return issue;
    }),
  ).toEqual(issues);
}

describe.each(slugs)('hardening pack: %s', slug => {
  const directory = join(fixtures, slug);
  const expected = JSON.parse(
    readFileSync(join(directory, 'expected.json'), 'utf8'),
  ) as { description: string; issues: Omit<PackIssue, 'message'>[] };

  // Start at the author-facing acceptance boundary; expectations come from
  // the fixture, never from a second call to the checker under test.
  it(`CLI ${expected.description}`, () => {
    const result = cli(join(directory, 'pack'));
    expect(result.error).toBeUndefined();
    expect(result.stderr).toBe('');
    expect(result.status).toBe(expected.issues.length === 0 ? 0 : 1);
    expectResult(JSON.parse(result.stdout) as CheckResult, expected.issues);
  });

  it.each(['file map', 'zip'])(`${expected.description} via %s`, format => {
    const files = readPack(join(directory, 'pack'));
    const result = checkPack(format === 'zip' ? zipSync(files) : files);
    expectResult(result, expected.issues);
    if (result.ok) expect(result.pack).toBeDefined();
    else expect(result).not.toHaveProperty('pack');
  });
});

describe('fill lookup errors stay inside the public TemplateError boundary', () => {
  const keys: { name: string; key: unknown }[] = [
    { name: 'poisoned object', key: { toString: 'x' } },
    { name: 'ordinary object', key: {} },
    { name: 'array', key: ['x'] },
  ];
  it.each(keys)('rejects a $name key at the lookup statement', ({ key }) => {
    let caught: unknown;
    try {
      fill(
        '<p data-gt="paragraph">\n  {{lookup table key}}\n</p>',
        {
          table: { x: 'found' },
          key,
        },
        { file: 'templates/report.hbs' },
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(TemplateError);
    expect((caught as TemplateError).issues).toEqual([
      {
        code: 'template-render',
        file: 'templates/report.hbs',
        line: 2,
        column: 3,
        message: expect.any(String),
      },
    ]);
  });
});

it('locates all 20,000 missing manifest assets within ten seconds instead of reparsing JSON per issue', () => {
  const files = readPack(join(fixtures, '03-url-ascii-control/pack'));
  const manifest = JSON.parse(new TextDecoder().decode(files['manifest.json']));
  const count = 20_000;
  manifest.files.assets = [
    'assets/logo.svg',
    ...Array.from({ length: count }, (_, i) => `assets/missing-${i}.svg`),
  ];
  const source = `${JSON.stringify(manifest, null, 2)}\n`;
  files['manifest.json'] = new TextEncoder().encode(source);
  // JSON.stringify indents each asset value six spaces. Find the first
  // asset line once; the expected locations then follow from the fixture.
  const firstLine =
    source
      .split('\n')
      .findIndex(line => line.includes('"assets/missing-0.svg"')) + 1;
  const issues = Array.from({ length: count }, (_, i) => ({
    code: 'file-missing',
    file: 'manifest.json',
    path: ['files', 'assets', i + 1],
    line: firstLine + i,
    column: 7,
  }));
  const directory = mkdtempSync(join(tmpdir(), 'hardening-many-assets-'));
  try {
    for (const [file, bytes] of Object.entries(files)) {
      const target = join(directory, file);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, bytes);
    }
    // Bound even the old quadratic implementation: a timeout is RED at the
    // acceptance boundary, without leaving a minutes-long check running.
    const result = cli(directory);
    expect(
      result.error,
      'CLI must finish locating 20,000 JSON issues',
    ).toBeUndefined();
    expect(result.stderr).toBe('');
    expect(result.status).toBe(1);
    expectResult(JSON.parse(result.stdout) as CheckResult, issues);

    const zip = zipSync(files);
    for (const input of [files, zip]) {
      const start = performance.now();
      const checked = checkPack(input);
      const elapsed = performance.now() - start;
      expectResult(checked, issues);
      expect(checked).not.toHaveProperty('pack');
      expect(elapsed).toBeLessThan(10_000);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 45_000);
