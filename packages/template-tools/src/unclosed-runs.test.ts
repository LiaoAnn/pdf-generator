// Readers on the upload path whose regexes retried an unclosed run from
// every opening, quadratic in the run (T06-15): in stylesheets `@font-face{`
// without `}`, a selector's `(` or `[` without its close, `element(` without
// `)` (or cut short by `|`, `^` or `#`); in the template a data-gt-id's `{{`
// without `}}`. Each reader's results around unclosed openings are pinned,
// so a linear rewrite changes no check result, and it reads 64 KiB of
// openings about as fast as plain input. Backtracking inside one regex call
// is invisible to a work count (css-work.test-support.ts), so these compare
// times taken in the same run.
import { manifestSchema, rulesSchema } from '@pdf-generator/contract';
import { recordSchema } from '@pdf-generator/fake-data';
import { describe, expect, it } from 'vitest';
import { withHead } from '../fixtures/document.ts';
import { fontFaces, fontRequests, usedFamilies } from './css.ts';
import { parseTemplate } from './fill.ts';
import { templateHtml } from './html.ts';
import { checkPack, type PackFiles } from './index.ts';
import { markIssues } from './marks.ts';
import { pageBoxProblems } from './page-box.ts';
import { pagedImports } from './paged-imports.ts';

describe('@font-face rules around unclosed ones', () => {
  const faces = (css: string) =>
    fontFaces(css).map(({ family, offset }) => ({ family, offset }));

  it.each([
    [
      'a closed face, then an unclosed one',
      '@font-face{font-family:A}@font-face{font-family:B',
      [{ family: 'a', offset: 0 }],
    ],
    [
      'an unclosed opening inside a closed face',
      '@font-face{@font-face{font-family:B}',
      [{ family: 'b', offset: 0 }],
    ],
    [
      'any case, with whitespace before the brace',
      'p{} @FONT-Face \n {font-family:A}',
      [{ family: 'a', offset: 4 }],
    ],
    ['only an unclosed face', 'p{} @font-face{font-family:A', []],
    [
      'something between the name and the brace',
      '@font-face x{font-family:A}',
      [],
    ],
  ])('finds %s', (_, css, expected) => {
    expect(faces(css)).toEqual(expected);
  });

  it('counts families in an unclosed face as used, not a closed one', () => {
    const { families } = usedFamilies(
      '@font-face{font-family:A} p{font-family:B} @font-face{font-family:C',
    );
    expect([...families].sort()).toEqual(['b', 'c']);
  });

  it('reads requests in an unclosed face, not a closed one', () => {
    expect(fontRequests('@font-face{font-weight:bold}').bold).toBe(false);
    expect(fontRequests('@font-face{font-weight:bold').bold).toBe(true);
  });
});

describe('root-box selectors around unclosed ( and [', () => {
  const offsets = (css: string) =>
    pageBoxProblems(css).map(problem => problem.offset);

  it.each([
    // An unclosed ( or [ stays: the space after it separates compounds.
    ['an unclosed (', 'div:not(.a body {margin:1px}'],
    ['an unclosed [', 'div[title=a body {margin:1px}'],
    ['a ( inside [ …]', 'div[a=(] body {margin:1px}'],
    ['a [ inside ( …)', 'div:is(a[b) body] {margin:1px}'],
  ])('reads body as the subject after %s', (_, css) => {
    expect(offsets(css)).toEqual([css.indexOf('margin')]);
  });

  it('reads div as the subject when body is inside (…)', () => {
    expect(offsets('div:not(body) {margin:1px}')).toEqual([]);
  });
});

describe('element() rewrites around unclosed ones', () => {
  /** The offset just past the first quote before `written`. */
  const after = (css: string, written: string) => css.indexOf(written) + 1;

  it.each<[string, string, [string, string][]]>([
    [
      'an unclosed element(',
      '@import "element(a.css";',
      [['element(a.css', '"element(']],
    ],
    [
      'element( inside an argument it closes',
      '@import "element(a element(b).css"; @import "c.css";',
      [
        ['element-ident(a element(b).css', '"element('],
        ['c.css', '"c.css"'],
      ],
    ],
    [
      'element( cut short by #, then a closed one',
      '@import "element(#a) element(b).css"; @import "c.css";',
      [
        ['element(#a) element-ident(b).css', '"element('],
        ['c.css', '"c.css"'],
      ],
    ],
    [
      'element( cut short by |, then a closed one',
      '@import "element(a|b) element(c).css";',
      [['element(a|b) element-ident(c).css', '"element(']],
    ],
  ])('loads what Paged.js loads for %s', (_, css, loads) => {
    expect(pagedImports(css)).toEqual(
      loads.map(([url, written]) => ({
        url,
        offset: after(css, written),
        loads: 1,
      })),
    );
  });
});

describe('unclosed runs: linear time', () => {
  const size = 64 * 1024;
  /** `unit` repeated to just under 64 KiB. */
  const fill = (unit: string) => unit.repeat(Math.floor(size / unit.length));
  const plain = fill('a{b:c}');

  /** The fastest of five interleaved runs of `read` on each input, in ms. */
  const fastest = (read: (css: string) => unknown, ...inputs: string[]) => {
    const best = inputs.map(() => Infinity);
    for (let run = 0; run < 5; run++) {
      inputs.forEach((css, i) => {
        const start = performance.now();
        read(css);
        best[i] = Math.min(best[i] ?? Infinity, performance.now() - start);
      });
    }
    return best;
  };

  it.each<[string, (css: string) => unknown, string, string]>([
    ['fontFaces: unclosed @font-face{', fontFaces, fill('@font-face{'), plain],
    [
      'usedFamilies: unclosed @font-face{',
      usedFamilies,
      fill('@font-face{'),
      plain,
    ],
    [
      'fontRequests: unclosed @font-face{',
      fontRequests,
      fill('@font-face{'),
      plain,
    ],
    [
      'pageBoxProblems: a selector of (',
      pageBoxProblems,
      `${fill('(')}{}`,
      `${fill('a')}{}`,
    ],
    [
      'pageBoxProblems: a selector of [',
      pageBoxProblems,
      `${fill('[')}{}`,
      `${fill('a')}{}`,
    ],
    // In a comment, which the rewrite reads too and css-tree skips: parsing
    // 64 KiB of rules takes ~70 ms, which would hide the rewrite's time.
    [
      'pagedImports: unclosed element(',
      pagedImports,
      `@import "x.css";/*${fill('element(')}*/`,
      `@import "x.css";/*${fill('a')}*/`,
    ],
    [
      'pagedImports: element( cut short by |',
      pagedImports,
      `@import "x.css";/*${fill('element(')}|)*/`,
      `@import "x.css";/*${fill('a')}*/`,
    ],
  ])('%s, 64 KiB, about as fast as plain CSS', (_, read, crafted, base) => {
    const [craftedMs = 0, baseMs = 0] = fastest(read, crafted, base);
    // A linear reader stays within a few times the plain sheet; one that
    // retries the run from each opening is thousands of times slower here.
    expect(craftedMs).toBeLessThan(Math.max(baseMs, 1) * 20);
  });
});

describe('data-gt-id literals around {{ … }}', () => {
  const pack = (template: string): PackFiles => {
    const rules = rulesSchema.parse({
      schemaVersion: 1,
      fields: { x: { type: 'name' }, y: { type: 'name' } },
    });
    const manifest = manifestSchema.parse({
      schemaVersion: 1,
      id: 'gt-id',
      name: '區塊編號',
      page: { size: 'A4', orientation: 'portrait' },
      files: {
        template: 'templates/report.hbs',
        styles: [],
        rules: 'data/rules.json',
        sample: 'data/sample.json',
        assets: [],
      },
    });
    return {
      'manifest.json': JSON.stringify(manifest),
      'templates/report.hbs': withHead(template),
      'data/rules.json': JSON.stringify(rules),
      'data/sample.json': JSON.stringify(
        recordSchema(rules).parse({ x: '王小明', y: '李大華' }),
      ),
    };
  };

  it.each<[string, string, boolean]>([
    ['an expression between letters', 'a{{x}}b', true],
    ['each expression on its own, not one span', '{{x}}é{{y}}', false],
    ['60 letters after an expression', `{{x}}${'a'.repeat(60)}`, true],
    ['61 letters after an expression', `{{x}}${'a'.repeat(61)}`, false],
    ['an escaped, unclosed {{', 'a\\{{b', false],
  ])('reads %s', (_, id, valid) => {
    const { issues } = checkPack(
      pack(`<p data-gt="paragraph" data-gt-id="${id}">{{x}}{{y}}</p>`),
    );
    expect(issues.some(issue => issue.code === 'gt-id')).toBe(!valid);
  });

  it('reads a 64 KiB data-gt-id of escaped {{ about as fast as one that closes', () => {
    const escapes = '\\{{'.repeat(Math.floor((64 * 1024) / 3));
    // checkPack's own steps, timing only the marks check: Handlebars' parse
    // of 21,000 escapes takes ~60 ms, as long as the quadratic literal.
    const marks = (id: string) => {
      const source = withHead(
        `<p data-gt="paragraph" data-gt-id="${id}">{{x}}</p>`,
      );
      const { ast } = parseTemplate(source, 'report.hbs');
      if (ast === undefined) throw new Error('the template must parse');
      const html = templateHtml(source, ast);
      return () => markIssues(source, html, 'report.hbs');
    };
    const crafted = marks(escapes);
    // The same escapes closed at the end: one span, read once.
    const closed = marks(`${escapes}}}`);
    const best = [Infinity, Infinity];
    for (let run = 0; run < 5; run++) {
      [crafted, closed].forEach((read, i) => {
        const start = performance.now();
        read();
        best[i] = Math.min(best[i] ?? Infinity, performance.now() - start);
      });
    }
    const [craftedMs = 0, closedMs = 0] = best;
    expect(craftedMs).toBeLessThan(Math.max(closedMs, 1) * 20);
  });
});
