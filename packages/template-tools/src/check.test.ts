import { manifestSchema, rulesSchema } from '@pdf-generator/contract';
import { recordSchema } from '@pdf-generator/fake-data';
import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { checkPack, type PackFiles, type PackIssue } from './index.ts';

const manifest = () => ({
  schemaVersion: 1,
  id: 'small-report',
  name: '測試報表',
  page: { size: 'A4', orientation: 'portrait' },
  files: {
    template: 'templates/report.hbs',
    styles: ['styles/base.css', 'styles/report.css'],
    rules: 'data/rules.json',
    sample: 'data/sample.json',
    assets: ['assets/unused.bin'],
  },
});
const rules = () => ({
  schemaVersion: 1,
  fields: {
    holder: { type: 'name' },
    amount: { type: 'integer', min: 0, max: 100 },
    rows: {
      type: 'array',
      minItems: 1,
      maxItems: 2,
      items: { type: 'integer', min: 0, max: 10 },
    },
  },
});
const sample = () => ({ holder: '王小明', amount: 25, rows: [3] });
const json = (value: unknown) => JSON.stringify(value, null, 2);

function validFiles(): PackFiles {
  // Fixture mistakes must fail before invoking the missing checker behavior.
  manifestSchema.parse(manifest());
  recordSchema(rulesSchema.parse(rules())).parse(sample());
  return {
    'manifest.json': json(manifest()),
    'templates/report.hbs':
      '<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"></head><body><p data-gt="paragraph">{{holder}}</p><p data-gt="field">{{amount}}</p></body></html>',
    'styles/base.css': 'body { color: black; }',
    'styles/report.css': 'p { margin: 0; }',
    'data/rules.json': json(rules()),
    'data/sample.json': json(sample()),
    // Assets are binary and must not go through the UTF-8 decoder.
    'assets/unused.bin': new Uint8Array([0xff, 0xfe, 0x80]),
  };
}

function bytes(files: PackFiles): Record<string, Uint8Array> {
  return Object.fromEntries(
    Object.entries(files).map(([path, contents]) => [
      path,
      typeof contents === 'string' ? strToU8(contents) : contents,
    ]),
  );
}

// Locate a fixture's explicitly selected token, independently of any JSON parser.
function location(
  source: string,
  token: string,
): { line: number; column: number } {
  const offset = source.indexOf(token);
  expect(offset, `fixture must contain ${token}`).toBeGreaterThanOrEqual(0);
  const prefix = source.slice(0, offset).split('\n');
  return { line: prefix.length, column: (prefix.at(-1)?.length ?? 0) + 1 };
}

type ExpectedIssue = Omit<PackIssue, 'message'>;
function rejected(
  input: Uint8Array | PackFiles,
  expected: ExpectedIssue[],
  options?: { maxBytes?: number },
): PackIssue[] {
  const result = checkPack(input, options);
  expect(result.ok).toBe(false);
  expect(result).not.toHaveProperty('pack');
  expect(result.issues).toHaveLength(expected.length);
  expect(result.issues).toEqual(
    expect.arrayContaining(
      expected.map(issue => expect.objectContaining(issue)),
    ),
  );
  for (const issue of result.issues) {
    expect(typeof issue.message).toBe('string');
    expect(issue.message.trim().length).toBeGreaterThan(0);
  }
  return result.issues;
}

const inputs = [
  { name: 'file map', encode: (files: PackFiles) => files },
  { name: 'ZIP', encode: (files: PackFiles) => zipSync(bytes(files)) },
];

describe('checkPack public acceptance', () => {
  it('returns the same complete parsed pack for text maps, byte maps and ZIPs', () => {
    const files = validFiles();
    const expected = {
      ok: true,
      issues: [],
      pack: {
        manifest: manifest(),
        rules: rules(),
        sample: sample(),
        template: files['templates/report.hbs'],
        styles: [files['styles/base.css'], files['styles/report.css']],
        files: bytes(files),
      },
    };
    expect(checkPack(files)).toEqual(expected);
    expect(checkPack(bytes(files))).toEqual(expected);
    expect(checkPack(zipSync(bytes(files)))).toEqual(expected);
  });

  it.each([new Uint8Array(), strToU8('this is not a zip')])(
    'reports unreadable ZIP bytes instead of throwing (%#)',
    input => {
      rejected(input, [{ code: 'zip-invalid', file: '.' }]);
    },
  );

  it('uses a 100 MiB default uncompressed size limit', () => {
    const files = validFiles();
    const otherBytes = Object.entries(bytes(files)).reduce(
      (total, [path, value]) =>
        total + (path === 'assets/unused.bin' ? 0 : value.byteLength),
      0,
    );
    const asset = new Uint8Array(100 * 1024 * 1024 - otherBytes + 1);
    files['assets/unused.bin'] = asset.subarray(0, asset.length - 1);
    expect(checkPack(files).ok).toBe(true);
    files['assets/unused.bin'] = asset;
    rejected(files, [{ code: 'pack-too-large', file: '.' }]);
  });

  it('ignores ZIP directories and macOS metadata without decoding or listing them', () => {
    const files = validFiles();
    const archive = zipSync({
      ...bytes(files),
      'empty/': new Uint8Array(),
      '__MACOSX/._report.hbs': new Uint8Array([0xff]),
      '.DS_Store': new Uint8Array([0xff]),
      'templates/.DS_Store': new Uint8Array([0xff]),
    });
    const result = checkPack(archive);
    expect(result).toEqual(checkPack(files));
  });
});

for (const { name, encode } of inputs) {
  describe(`checkPack structural diagnostics from ${name}`, () => {
    it.each(['../x', '/abs', 'a\\b', 'a/../x', 'a//b', './x'])(
      'rejects unsafe entry path %s using the raw path',
      path => {
        const files = validFiles();
        files[path] = '';
        rejected(encode(files), [{ code: 'path-invalid', file: path }]);
      },
    );

    it('reports a missing root manifest without cascading unlisted-file issues', () => {
      const files = validFiles();
      delete files['manifest.json'];
      rejected(encode(files), [
        { code: 'manifest-missing', file: 'manifest.json' },
      ]);
    });

    it('explains the enclosing folder when a pack is wrapped in a directory', () => {
      const files = Object.fromEntries(
        Object.entries(validFiles()).map(([path, value]) => [
          `wrapped-report/${path}`,
          value,
        ]),
      );
      const issues = rejected(encode(files), [
        { code: 'manifest-missing', file: 'manifest.json' },
      ]);
      expect(issues[0]?.message).toContain('wrapped-report');
    });

    it('enforces uncompressed UTF-8 byte size, accepts equality and stops other checks', () => {
      const files = validFiles();
      const size = Object.values(bytes(files)).reduce(
        (total, value) => total + value.byteLength,
        0,
      );
      expect(checkPack(encode(files), { maxBytes: size }).ok).toBe(true);
      rejected(encode(files), [{ code: 'pack-too-large', file: '.' }], {
        maxBytes: size - 1,
      });
      // Once oversized, even an absent manifest must not produce another issue.
      delete files['manifest.json'];
      files['assets/large.bin'] = new Uint8Array(size);
      rejected(encode(files), [{ code: 'pack-too-large', file: '.' }], {
        maxBytes: size - 1,
      });
    });

    it.each(['manifest.json', 'data/rules.json', 'data/sample.json'])(
      'locates malformed JSON in %s at the bad token',
      file => {
        const files = validFiles();
        files[file] = '{\n  "broken": @\n}';
        rejected(encode(files), [
          { code: 'json-syntax', file, line: 2, column: 13 },
        ]);
      },
    );

    it.each([
      'manifest.json',
      'data/rules.json',
      'data/sample.json',
      'templates/report.hbs',
      'styles/base.css',
      'styles/report.css',
    ])('rejects invalid UTF-8 in %s without replacement decoding', file => {
      const files = validFiles();
      files[file] = new Uint8Array([0xc3, 0x28]);
      rejected(encode(files), [{ code: 'text-encoding', file }]);
    });

    it('accepts and strips leading UTF-8 BOMs from every text file', () => {
      const files = validFiles();
      const bomFiles = Object.fromEntries(
        Object.entries(files).map(([path, value]) => [
          path,
          typeof value === 'string' ? strToU8(`\uFEFF${value}`) : value,
        ]),
      );
      const result = checkPack(encode(bomFiles));
      expect(result.ok).toBe(true);
      expect(result.issues).toEqual([]);
      expect(result.pack).toMatchObject({
        manifest: manifest(),
        rules: rules(),
        sample: sample(),
        template: files['templates/report.hbs'],
        styles: [files['styles/base.css'], files['styles/report.css']],
      });
    });

    it('locates an invalid manifest value and stops before checking listed files', () => {
      const files = validFiles();
      const text = json(manifest()).replace('"portrait"', '"sideways"');
      files['manifest.json'] = text;
      delete files['templates/report.hbs'];
      rejected(encode(files), [
        {
          code: 'manifest-invalid',
          file: 'manifest.json',
          path: ['page', 'orientation'],
          ...location(text, '"sideways"'),
        },
      ]);
    });

    it('anchors a missing manifest key at the nearest existing ancestor object', () => {
      const files = validFiles();
      const text = json(manifest()).replace('"orientation": "portrait"', '');
      files['manifest.json'] = text.replace('"size": "A4",', '"size": "A4"');
      const source = String(files['manifest.json']);
      rejected(encode(files), [
        {
          code: 'manifest-invalid',
          file: 'manifest.json',
          path: ['page', 'orientation'],
          ...location(source, '{\n    "size"'),
        },
      ]);
    });

    it('returns one located issue per manifest schema violation', () => {
      const files = validFiles();
      const text = json(manifest())
        .replace('"portrait"', '"sideways"')
        .replace('"small-report"', '"INVALID"');
      files['manifest.json'] = text;
      rejected(
        encode(files),
        [
          { path: ['page', 'orientation'], token: '"sideways"' },
          { path: ['id'], token: '"INVALID"' },
        ].map(({ path, token }) => ({
          code: 'manifest-invalid',
          file: 'manifest.json',
          path,
          ...location(text, token),
        })),
      );
    });

    it.each([
      { file: 'templates/report.hbs', path: ['files', 'template'] },
      { file: 'styles/base.css', path: ['files', 'styles', 0] },
      { file: 'styles/report.css', path: ['files', 'styles', 1] },
      { file: 'data/rules.json', path: ['files', 'rules'] },
      { file: 'data/sample.json', path: ['files', 'sample'] },
      { file: 'assets/unused.bin', path: ['files', 'assets', 0] },
    ])('locates the manifest reference to missing $file', ({ file, path }) => {
      const files = validFiles();
      delete files[file];
      rejected(encode(files), [
        {
          code: 'file-missing',
          file: 'manifest.json',
          path,
          ...location(String(files['manifest.json']), JSON.stringify(file)),
        },
      ]);
    });

    it('rejects an unlisted pack file by its own path', () => {
      const files = validFiles();
      files['notes/readme.txt'] = 'forgotten file';
      rejected(encode(files), [
        { code: 'file-unlisted', file: 'notes/readme.txt' },
      ]);
    });

    it('locates a rules refinement failure and skips invalid sample data', () => {
      const files = validFiles();
      const value = rules();
      value.fields.amount.min = 101;
      const text = json(value);
      files['data/rules.json'] = text;
      files['data/sample.json'] = json({});
      rejected(encode(files), [
        {
          code: 'rules-invalid',
          file: 'data/rules.json',
          path: ['fields', 'amount', 'min'],
          ...location(text, '101'),
        },
      ]);
    });

    it('returns each rules schema error at its own value', () => {
      const files = validFiles();
      const text = json(rules())
        .replace('"minItems": 1', '"minItems": -1')
        .replace('"min": 0', '"min": 0.5');
      files['data/rules.json'] = text;
      rejected(encode(files), [
        {
          code: 'rules-invalid',
          file: 'data/rules.json',
          path: ['fields', 'amount', 'min'],
          ...location(text, '0.5'),
        },
        {
          code: 'rules-invalid',
          file: 'data/rules.json',
          path: ['fields', 'rows', 'minItems'],
          ...location(text, '-1'),
        },
      ]);
    });

    it('validates sample constraints and locates an array item by numeric JSON path', () => {
      const files = validFiles();
      const text = json({ ...sample(), rows: [11] });
      files['data/sample.json'] = text;
      rejected(encode(files), [
        {
          code: 'sample-invalid',
          file: 'data/sample.json',
          path: ['rows', 0],
          ...location(text, '11'),
        },
      ]);
    });

    it('anchors a missing sample field at the record object', () => {
      const files = validFiles();
      files['data/sample.json'] = json({ holder: '王小明', rows: [3] });
      rejected(encode(files), [
        {
          code: 'sample-invalid',
          file: 'data/sample.json',
          path: ['amount'],
          line: 1,
          column: 1,
        },
      ]);
    });

    it('returns one issue per invalid sample field without depending on issue order', () => {
      const files = validFiles();
      const text = json({ ...sample(), holder: 42, amount: 101 });
      files['data/sample.json'] = text;
      rejected(
        encode(files),
        [
          { path: ['holder'], token: '42' },
          { path: ['amount'], token: '101' },
        ].map(({ path, token }) => ({
          code: 'sample-invalid',
          file: 'data/sample.json',
          path,
          ...location(text, token),
        })),
      );
    });
  });
}
