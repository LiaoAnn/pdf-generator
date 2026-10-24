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
import {
  type CheckResult,
  checkPack,
  fill,
  type PackFiles,
  type PackIssue,
  TemplateError,
} from './index.ts';

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

const templateFile = 'templates/report.hbs';

function pack(template: string): PackFiles {
  const manifest = JSON.parse(
    readFileSync(join(join(fixtures, 'valid'), 'manifest.json'), 'utf8'),
  );
  const files: PackFiles = {};
  for (const file of [
    'manifest.json',
    templateFile,
    ...manifest.files.styles,
    manifest.files.rules,
    manifest.files.sample,
    ...manifest.files.assets,
  ]) {
    files[file] = readFileSync(join(join(fixtures, 'valid'), file));
  }
  files[templateFile] = template;
  const rules = JSON.parse(
    readFileSync(join(join(fixtures, 'valid'), 'data/rules.json'), 'utf8'),
  );
  rules.fields.date = { type: 'date', min: '2024-01-01', max: '2024-12-31' };
  files['data/rules.json'] = JSON.stringify(rules);
  const sample = JSON.parse(
    readFileSync(join(join(fixtures, 'valid'), 'data/sample.json'), 'utf8'),
  );
  sample.date = '2024-05-07';
  files['data/sample.json'] = JSON.stringify(sample);
  return files;
}

function renderIssue(template: string, data: unknown, code: string) {
  let caught: unknown;
  try {
    fill(template, data, { file: templateFile });
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(TemplateError);
  expect((caught as TemplateError).issues).toEqual([
    expect.objectContaining({
      code,
      file: templateFile,
      line: 2,
      column: 3,
      message: expect.any(String),
    }),
  ]);
}

describe('ROC dates for Taiwanese template packs', () => {
  it('lets the CLI validate a pack using every format and fills its printed dates', () => {
    const template =
      '<p data-gt="field">' +
      [
        '{{rocDate date}}',
        '{{rocDate date format="text"}}',
        '{{rocDate date format="full"}}',
        '{{rocDate date format="slash"}}',
        '{{rocDate date format="dot"}}',
        '{{rocDate date format="year"}}',
        '{{rocDate date format="month"}}',
        '{{rocDate date format="day"}}',
      ].join('|') +
      '</p>';
    const files = pack(template);
    const directory = mkdtempSync(join(tmpdir(), 'roc-date-pack-'));
    temporary.push(directory);
    cpSync(join(fixtures, 'valid'), directory, { recursive: true });
    for (const [file, contents] of Object.entries(files)) {
      writeFileSync(join(directory, file), contents);
    }
    const result = spawnSync(
      process.execPath,
      ['src/cli.ts', directory, '--json'],
      {
        cwd: packageDir,
        encoding: 'utf8',
        timeout: 15_000,
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe('{"ok":true,"issues":[]}\n');
    expect(result.status).toBe(0);
    expect(checkPack(files).ok).toBe(true);
    expect(fill(template, { date: '2024-05-07' })).toBe(
      '<p data-gt="field">民國113年5月7日|民國113年5月7日|中華民國113年5月7日|113/05/07|113.05.07|113|5|7</p>',
    );
  });

  it.each([
    ['1912-01-01', 'text', '民國1年1月1日'],
    ['2010-01-02', 'slash', '99/01/02'],
    ['2010-01-02', 'dot', '99.01.02'],
    ['2024-02-29', 'text', '民國113年2月29日'],
    ['2024-12-31', 'text', '民國113年12月31日'],
    ['2025-01-01', 'text', '民國114年1月1日'],
    ['2000-02-29', 'slash', '89/02/29'],
  ])(
    'preserves calendar components for %s in %s format',
    (date, format, expected) => {
      const previous = process.env.TZ;
      try {
        for (const timezone of ['Pacific/Honolulu', 'Pacific/Kiritimati']) {
          process.env.TZ = timezone;
          expect(fill(`{{rocDate date format="${format}"}}`, { date })).toBe(
            expected,
          );
        }
      } finally {
        if (previous === undefined) delete process.env.TZ;
        else process.env.TZ = previous;
      }
    },
  );

  it('prints null literals and null date fields as empty text', () => {
    expect(
      fill('A{{rocDate null}}B{{rocDate date format="slash"}}C', {
        date: null,
      }),
    ).toBe('ABC');
  });

  it('returns a string from nested subexpressions even with a same-named data field', () => {
    expect(
      fill(
        '{{rocDate date}}|{{#if (eq (rocDate date format="year") "113")}}match{{else}}wrong type{{/if}}',
        {
          date: '2024-05-07',
          rocDate: 'shadow',
        },
      ),
    ).toBe('民國113年5月7日|match');
  });

  it.each([
    { kind: 'number', value: 20240507 },
    { kind: 'boolean', value: true },
    { kind: 'array', value: ['2024-05-07'] },
    { kind: 'object', value: { date: '2024-05-07' } },
    ...[
      '2024-5-7',
      '2024-05-07T00:00:00Z',
      ' 2024-05-07',
      '2024-05-07 ',
      '2024-05-07\n',
      '20240507',
      '2023-02-29',
      '2024-13-01',
      '2024-04-31',
      '2024-00-10',
      '2024-01-00',
      '1900-02-29',
      '2100-02-29',
      '1911-12-31',
    ].map(value => ({ kind: value, value })),
  ])(
    'reports invalid date $kind as a render error at the calling statement',
    ({ value }) => {
      renderIssue(
        '<p data-gt="field">\n  {{rocDate date}}</p>',
        { date: value },
        'template-render',
      );
    },
  );

  it.each([
    ['unknown format', '{{rocDate date format="iso"}}'],
    ['dynamic format', '{{rocDate date format=style}}'],
    ['numeric format', '{{rocDate date format=1}}'],
    ['unexpected hash', '{{rocDate date padding="yes"}}'],
    ['missing argument', '{{rocDate}}'],
    ['extra argument', '{{rocDate date date}}'],
    [
      'invalid nested format',
      '{{#if (eq (rocDate date format="iso") "113")}}bad{{/if}}',
    ],
  ])(
    'rejects %s statically in an unreachable branch through fill and checkPack',
    (_name, statement) => {
      const template = `{{#if false}}\n  ${statement}\n{{/if}}`;
      renderIssue(
        template,
        { date: '2024-05-07', style: 'text' },
        'template-unsupported',
      );
      const result = checkPack(pack(`<p data-gt="field">${template}</p>`));
      expect(result.ok).toBe(false);
      expect(result.issues).toEqual([
        expect.objectContaining({
          code: 'template-unsupported',
          file: templateFile,
          line: 2,
          column: 3,
        }),
      ]);
    },
  );
});
