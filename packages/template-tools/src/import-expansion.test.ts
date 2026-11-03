import { manifestSchema, rulesSchema } from '@pdf-generator/contract';
import { recordSchema } from '@pdf-generator/fake-data';
import { describe, expect, it } from 'vitest';
import { withHead } from '../fixtures/document.ts';
import { checkPack, type PackFiles } from './index.ts';

// Chrome and Paged.js load an imported stylesheet again for every @import of
// it, so an import graph can expand far past the files in the pack: a ladder
// of 20 sheets, each importing the next twice, stalls Chrome before the print
// runtime's own cap acts (T07-29). The upload check counts the expansion.

function pack(
  sheets: Record<string, string>,
  styles = ['styles/a.css'],
  head = '',
): PackFiles {
  const rules = rulesSchema.parse({
    schemaVersion: 1,
    fields: { holder: { type: 'name' } },
  });
  const manifest = manifestSchema.parse({
    schemaVersion: 1,
    id: 'import-expansion',
    name: '引用展開測試',
    page: { size: 'A4', orientation: 'portrait' },
    files: {
      template: 'templates/report.hbs',
      styles,
      rules: 'data/rules.json',
      sample: 'data/sample.json',
      assets: Object.keys(sheets).filter(file => !styles.includes(file)),
    },
  });
  return {
    'manifest.json': JSON.stringify(manifest),
    'templates/report.hbs': withHead(
      `<head>${head}</head><p data-gt="paragraph">{{holder}}</p>`,
    ),
    'data/rules.json': JSON.stringify(rules),
    'data/sample.json': JSON.stringify(
      recordSchema(rules).parse({ holder: '王小明' }),
    ),
    ...sheets,
  };
}

/** `count` copies of `@import "<url>";`, one per line. */
const imports = (url: string, count: number) =>
  Array.from({ length: count }, () => `@import "${url}";`).join('\n');

/** Sheets s0 … s(depth-1), each importing the next twice; the last is empty. */
function ladder(depth: number): Record<string, string> {
  const sheets: Record<string, string> = {};
  for (let i = 0; i < depth; i++) {
    sheets[`styles/s${i}.css`] =
      i === depth - 1 ? 'p { margin: 0; }' : imports(`s${i + 1}.css`, 2);
  }
  return sheets;
}

function expansionIssues(files: PackFiles) {
  const result = checkPack(files);
  return {
    result,
    expansion: result.issues.filter(
      issue => issue.code === 'css-import-expansion',
    ),
  };
}

function accepts(files: PackFiles) {
  const result = checkPack(files);
  expect(result.issues).toEqual([]);
  expect(result.ok).toBe(true);
}

describe('checkPack @import expansion: stylesheet loads', () => {
  it.each([20, 40])(
    'refuses a ladder of %i sheets, each importing the next twice, naming its root stylesheet',
    depth => {
      // 40 deep is 2^40 loads: the count must come from the graph, not from
      // walking every path.
      const { result, expansion } = expansionIssues(
        pack(ladder(depth), ['styles/s0.css']),
      );
      expect(result.ok).toBe(false);
      expect(result).not.toHaveProperty('pack');
      expect(result.issues).toEqual([
        {
          code: 'css-import-expansion',
          file: 'styles/s0.css',
          message: expect.stringMatching(/\b64\b/),
        },
      ]);
      expect(expansion).toHaveLength(1);
    },
  );

  it('accepts nested imports and a repeated import while the expansion stays small', () => {
    // a → b → c → d, and a imports d twice more: 6 loads.
    accepts(
      pack({
        'styles/a.css': `${imports('b.css', 1)}\n${imports('d.css', 2)}\np { color: black; }`,
        'styles/b.css': `${imports('c.css', 1)}\nh1 { margin: 0; }`,
        'styles/c.css': `${imports('d.css', 1)}\nh2 { margin: 0; }`,
        'styles/d.css': 'h3 { margin: 0; }',
      }),
    );
  });

  it('accepts exactly 64 stylesheet loads and refuses 65, counting every repeat of an @import', () => {
    // The manifest's sheet plus 63 imports of b.css is 64 loads.
    accepts(
      pack({
        'styles/a.css': imports('b.css', 63),
        'styles/b.css': 'p { margin: 0; }',
      }),
    );
    const { result, expansion } = expansionIssues(
      pack({
        'styles/a.css': imports('b.css', 64),
        'styles/b.css': 'p { margin: 0; }',
      }),
    );
    expect(result.ok).toBe(false);
    expect(expansion).toEqual([
      {
        code: 'css-import-expansion',
        file: 'styles/a.css',
        message: expect.stringMatching(/\b64\b/),
      },
    ]);
  });

  it('counts the loads of every stylesheet the pack loads: manifest styles, template links and template @imports', () => {
    const sheets = (fromLink: number) => ({
      'styles/a.css': imports('b.css', 20), // 21 loads
      'styles/b.css': 'p { margin: 0; }',
      'styles/link.css': imports('b.css', fromLink), // fromLink + 1
      'styles/inline.css': imports('b.css', 20), // 21
    });
    const head =
      '<link rel="stylesheet" href="../styles/link.css"><style>@import "../styles/inline.css";</style>';
    // 21 + 22 + 21 = 64 loads.
    accepts(pack(sheets(21), ['styles/a.css'], head));
    // 21 + 23 + 21 = 65, and the template's link is the largest.
    const { result, expansion } = expansionIssues(
      pack(sheets(22), ['styles/a.css'], head),
    );
    expect(result.ok).toBe(false);
    expect(expansion).toEqual([
      {
        code: 'css-import-expansion',
        file: 'styles/link.css',
        message: expect.stringMatching(/\b64\b/),
      },
    ]);
  });

  it('counts a stylesheet the template itself imports over and over, with no @import between stylesheets', () => {
    const head = (count: number) =>
      `<style>${imports('../styles/b.css', count)}</style>`;
    const sheets = { 'styles/a.css': '', 'styles/b.css': 'p { margin: 0; }' };
    // a.css plus 63 template imports of b.css is 64 loads.
    accepts(pack(sheets, ['styles/a.css'], head(63)));
    const { result, expansion } = expansionIssues(
      pack(sheets, ['styles/a.css'], head(64)),
    );
    expect(result.ok).toBe(false);
    expect(expansion).toEqual([
      {
        code: 'css-import-expansion',
        file: 'styles/b.css',
        message: expect.stringMatching(/\b64\b/),
      },
    ]);
  });

  it('names the root with the largest expansion when several roots share the loads', () => {
    const { expansion } = expansionIssues(
      pack(
        {
          'styles/a.css': imports('c.css', 10),
          'styles/b.css': imports('c.css', 60),
          'styles/c.css': 'p { margin: 0; }',
        },
        ['styles/a.css', 'styles/b.css'],
      ),
    );
    expect(expansion).toEqual([
      {
        code: 'css-import-expansion',
        file: 'styles/b.css',
        message: expect.stringMatching(/\b64\b/),
      },
    ]);
  });

  it('reports a ladder that also loops once: the cycle and the expansion, and still finishes', () => {
    const sheets = ladder(30);
    sheets['styles/s29.css'] = '@import "s0.css";';
    const { result, expansion } = expansionIssues(
      pack(sheets, ['styles/s0.css']),
    );
    expect(result.ok).toBe(false);
    expect(result.issues.map(issue => issue.code)).toContain(
      'css-import-cycle',
    );
    expect(expansion).toHaveLength(1);
  });
});

const encoder = new TextEncoder();

/** `text` padded with a CSS comment to exactly `bytes` bytes of UTF-8. */
function sized(text: string, bytes: number): string {
  const open = `${text}\n/* `;
  const pad = bytes - encoder.encode(`${open} */`).byteLength;
  if (pad < 0) throw new Error(`${text.length} chars do not fit ${bytes}`);
  return `${open}${'x'.repeat(pad)} */`;
}

describe('checkPack @import expansion: bytes of CSS', () => {
  it('accepts exactly 1 MiB of CSS after expansion and refuses one byte more, counted in UTF-8 bytes', () => {
    // b.css holds Chinese text (3 bytes a character), so counting characters
    // instead of bytes lands on the wrong side of the limit.
    const b = sized('p::before { content: "中文標題"; }', 65_500);
    const loads = (aBytes: number) =>
      pack({
        'styles/a.css': sized(imports('b.css', 16), aBytes),
        'styles/b.css': b,
      });
    // 16 × 65,500 + 576 = 1,048,576 bytes in 17 loads.
    accepts(loads(576));
    const { result, expansion } = expansionIssues(loads(577));
    expect(result.ok).toBe(false);
    expect(expansion).toEqual([
      {
        code: 'css-import-expansion',
        file: 'styles/a.css',
        message: expect.stringMatching(/1 MiB/),
      },
    ]);
  });

  it('refuses a sheet repeated toward 24 MiB with one issue, though both limits are past', () => {
    const { result, expansion } = expansionIssues(
      pack({
        'styles/a.css': imports('b.css', 384),
        'styles/b.css': sized('p { margin: 0; }', 64 * 1024),
      }),
    );
    expect(result.ok).toBe(false);
    expect(expansion).toEqual([
      {
        code: 'css-import-expansion',
        file: 'styles/a.css',
        message: expect.stringMatching(/\b64\b[\s\S]*1 MiB|1 MiB[\s\S]*\b64\b/),
      },
    ]);
  });
});

describe('checkPack @import expansion: stylesheets the template repeats', () => {
  /** The pack, with a `rows` list and `body` in the template's body. */
  function repeating(body: string): PackFiles {
    const rules = rulesSchema.parse({
      schemaVersion: 1,
      fields: {
        holder: { type: 'name' },
        rows: {
          type: 'array',
          minItems: 1,
          maxItems: 1000,
          items: { type: 'integer', min: 0, max: 10 },
        },
      },
    });
    return {
      ...pack({ 'styles/a.css': '', 'styles/b.css': 'p { margin: 0; }' }),
      'templates/report.hbs': withHead(
        `<head></head><p data-gt="paragraph">{{holder}}</p>${body}`,
      ),
      'data/rules.json': JSON.stringify(rules),
      'data/sample.json': JSON.stringify(
        recordSchema(rules).parse({ holder: '王小明', rows: [1, 2] }),
      ),
    };
  }

  it.each([
    ['a <style> @import', '<style>@import "../styles/b.css";</style>'],
    ['a <link>', '<link rel="stylesheet" href="../styles/b.css">'],
  ])(
    'refuses %s inside {{#each}}: filling the template loads it once per item, without limit',
    (_, sheet) => {
      const { result, expansion } = expansionIssues(
        repeating(`{{#each rows}}${sheet}{{/each}}`),
      );
      expect(result.ok).toBe(false);
      expect(expansion).toEqual([
        {
          code: 'css-import-expansion',
          file: 'styles/b.css',
          message: expect.stringContaining('{{#each}}'),
        },
      ]);
    },
  );

  it('accepts a stylesheet inside {{#if}}, which prints at most once', () => {
    accepts(
      repeating(
        '{{#if holder}}<style>@import "../styles/b.css";</style>{{/if}}',
      ),
    );
  });
});
