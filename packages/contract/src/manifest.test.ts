import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { manifestSchema, relativePathSchema, slugSchema } from './index.ts';

function validManifest() {
  return {
    schemaVersion: 1,
    id: 'company-monthly-report',
    name: ' 公司月報 ',
    page: { size: 'A4', orientation: 'portrait' },
    files: {
      template: 'report.hbs',
      styles: ['base.css', 'report.css'],
      rules: 'rules.json',
      sample: 'sample.json',
      assets: ['logo.png'],
    },
  };
}

describe('manifest validation', () => {
  test('parse preserves whitespace and leaves absent optional fields absent', () => {
    const input = validManifest();
    expect(manifestSchema.parse(input)).toEqual(input);
    const minimal = validManifest();
    Reflect.deleteProperty(minimal.files, 'assets');
    minimal.files.styles = [];
    minimal.page.orientation = 'landscape';
    expect(manifestSchema.parse(minimal)).toEqual(minimal);
  });

  test('invalid fixture has only the template extension defect', () => {
    const invalid: unknown = JSON.parse(
      readFileSync(
        new URL('../examples/manifest.invalid.json', import.meta.url),
        'utf8',
      ),
    );
    const result = manifestSchema.safeParse(invalid);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map(issue => issue.path)).toEqual([
        ['files', 'template'],
      ]);
    }
  });

  test.each(['root', 'page', 'files'] as const)(
    'rejects unknown keys at %s rather than silently dropping pack typos',
    level => {
      const input = validManifest();
      const target = level === 'root' ? input : input[level];
      Object.assign(target, { typo: true });
      expect(manifestSchema.safeParse(input).success).toBe(false);
    },
  );

  test.each(['styles', 'rules', 'sample', 'assets'] as const)(
    'rejects duplicate paths involving %s with a files issue',
    field => {
      const input = validManifest();
      if (field === 'styles')
        input.files.styles.push(input.files.styles[0] ?? '');
      if (field === 'rules') input.files.rules = input.files.sample;
      if (field === 'sample') input.files.sample = input.files.rules;
      if (field === 'assets') input.files.assets.push(input.files.template);
      const result = manifestSchema.safeParse(input);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(
          result.error.issues.some(issue => issue.path[0] === 'files'),
        ).toBe(true);
      }
    },
  );

  test.each([
    ['schemaVersion', { schemaVersion: '1' }],
    ['unsupported version', { schemaVersion: 2 }],
    ['blank name', { name: ' \t\n ' }],
    ['empty name', { name: '' }],
    ['oversized name', { name: '字'.repeat(201) }],
    ['oversized description', { description: '字'.repeat(2001) }],
    [
      'unsupported paper',
      { page: { size: 'Letter', orientation: 'portrait' } },
    ],
    ['missing orientation', { page: { size: 'A4' } }],
  ])('rejects %s before a pack reaches the renderer', (_label, patch) => {
    expect(
      manifestSchema.safeParse({ ...validManifest(), ...patch }).success,
    ).toBe(false);
  });

  test.each([
    { template: 'report.html' },
    { styles: ['report.scss'] },
    { rules: 'rules.yaml' },
    { sample: 'sample.txt' },
  ])('rejects unsupported file extensions: %j', patch => {
    const input = validManifest();
    Object.assign(input.files, patch);
    expect(manifestSchema.safeParse(input).success).toBe(false);
  });
});

describe('paths stay inside the template pack', () => {
  test.each([
    '',
    '../x.css',
    '/abs.css',
    'a//b.css',
    'a\\b.css',
    './a.css',
    'a/../b.css',
    'a/./b.css',
    'a/',
    'a\u0000b.css',
    'a\nb.css',
    'a\u007fb.css',
    'a'.repeat(256),
  ])('rejects unsafe or out-of-range path %j', path => {
    expect(relativePathSchema.safeParse(path).success).toBe(false);
  });

  test.each(['assets/logo.png', 'assets/公司商標.png', 'a'.repeat(255)])(
    'preserves valid relative path %j',
    path => {
      expect(relativePathSchema.parse(path)).toBe(path);
    },
  );
});

describe('portable pack identifiers', () => {
  test.each([
    '',
    'Monthly',
    '-a',
    'a-',
    'a--b',
    'a_b',
    'a/b',
    '公司',
    'a'.repeat(65),
  ])('rejects slug %j that cannot identify a portable pack', slug => {
    expect(slugSchema.safeParse(slug).success).toBe(false);
  });

  test.each(['a', 'company-monthly-report', 'a0-b1', 'a'.repeat(64)])(
    'preserves valid slug %j',
    slug => {
      expect(slugSchema.parse(slug)).toBe(slug);
    },
  );
});
