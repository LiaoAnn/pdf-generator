// scanCss's work, counted instead of timed: every stylesheet an upload reads
// goes through it, and the API tests' packs are too small for a quadratic
// scan to show (T09-7). A linear scan touches each character a few times;
// a scan that rereads or copies the rest of the text per step touches each
// one thousands of times at 64 KiB.
import { manifestSchema, rulesSchema } from '@pdf-generator/contract';
import { recordSchema } from '@pdf-generator/fake-data';
import { describe, expect, it } from 'vitest';
import { withHead } from '../fixtures/document.ts';
import { cssWork, scanCss } from './css.ts';
import { countCssWork, perCharacter } from './css-work.test-support.ts';
import { checkPack, type PackFiles } from './index.ts';

const size = 64 * 1024;
/** `unit` repeated to just under 64 KiB. */
const fill = (unit: string) => unit.repeat(Math.floor(size / unit.length));

/**
 * Most a linear scan may count per character: about 2 to 5 on these shapes
 * (each character read once by a loop, once by a one-character regex test,
 * and URLs and names copied once more). A quadratic scan counts in the
 * thousands per character here.
 */
const linear = 12;

/** A stylesheet as packs write them, with every construct scanCss reads. */
const rule = [
  '/* section header */',
  '.report > header .title, h1[data-gt="title"] {',
  '  font: bold 14pt/1.4 sans-serif;',
  '  background: url("../assets/logo.png") no-repeat, url( ../assets/logo.png );',
  '  background-image: image-set("../assets/logo.png" 1x, url(../assets/logo.png) 2x);',
  "  content: 'Page ' counter(page);",
  '  margin: calc(1em + 2px) 0;',
  '}',
  '@media print { table td:nth-child(2n) { border: 0.5pt solid #333; } }',
  '',
].join('\n');

describe('scanCss work: linear in the stylesheet', () => {
  it.each([
    ['rules as packs write them', fill(rule)],
    ['comments', fill('/* a comment */')],
    ['an unclosed comment', `a{}/*${fill('x')}`],
    ['strings', fill('a{content:"text"}')],
    ['unterminated strings', fill('a{content:"x\n')],
    ['quoted url()s', fill('a{b:url("x.png")}')],
    ['unquoted url()s', fill('a{b:url(x.png)}')],
    ['url( openings without a close', fill('url(')],
    [
      'an unquoted url() with a space run before more URL',
      `a{b:url(x${fill(' ')}x)}`,
    ],
    ['nested image-set()s', fill('image-set(')],
    ['function openings', fill('a(')],
    ['closing parentheses', fill(')')],
    ['one long identifier', fill('a')],
    ['at-rules', fill('@import ')],
    ['backslashes', fill('\\')],
  ])('scans 64 KiB of %s in linear work', (_, css) => {
    const { work } = countCssWork(() => scanCss(css));
    expect(work.scanned).toBe(css.length);
    // Every character is looked at, by a loop of scanCss or a builtin.
    expect(work.read + work.builtins).toBeGreaterThanOrEqual(css.length);
    expect(perCharacter(work)).toBeLessThanOrEqual(linear);
  });
});

describe('countCssWork', () => {
  // A scan the count can't see would pass every test above: these check
  // that copies and regex tests made during a scan are counted.
  const text = 'a'.repeat(4096);
  /** Runs `run` as if inside scanCss. */
  const scanning = (run: () => void) =>
    countCssWork(() => {
      cssWork.scanning++;
      try {
        run();
      } finally {
        cssWork.scanning--;
      }
    }).work;

  it('counts a copy of the rest of the text at each character as quadratic', () => {
    const work = scanning(() => {
      for (let i = 0; i < text.length; i++) text.slice(i).split('');
    });
    expect(work.builtins).toBeGreaterThan(text.length ** 2 / 2);
  });

  it('counts a regex test of each character once', () => {
    const letter = /[a-z]/;
    const work = scanning(() => {
      for (const c of text.split('')) letter.test(c);
    });
    expect(work.builtins).toBe(2 * text.length);
  });

  it('counts nothing outside a scan', () => {
    const { work } = countCssWork(() => text.slice(1).split(''));
    expect(work).toEqual({ scanned: 0, read: 0, builtins: 0 });
  });
});

describe('checkPack: a 64 KiB stylesheet', () => {
  const cssFile = 'styles/report.css';
  const logo = 'assets/logo.png';

  function files(css: string): PackFiles {
    const manifest = manifestSchema.parse({
      schemaVersion: 1,
      id: 'css-work',
      name: '樣式表計數',
      page: { size: 'A4', orientation: 'portrait' },
      files: {
        template: 'templates/report.hbs',
        styles: [cssFile],
        rules: 'data/rules.json',
        sample: 'data/sample.json',
        assets: [logo],
      },
    });
    const rules = rulesSchema.parse({
      schemaVersion: 1,
      fields: { holder: { type: 'name' } },
    });
    return {
      'manifest.json': JSON.stringify(manifest),
      'templates/report.hbs': withHead(
        '<h1 data-gt="title">報表</h1><p data-gt="paragraph">{{holder}}</p>',
      ),
      [cssFile]: css,
      'data/rules.json': JSON.stringify(rules),
      'data/sample.json': JSON.stringify(
        recordSchema(rules).parse({ holder: '王小明' }),
      ),
      [logo]: new Uint8Array([0x89, 0x50, 0xff]),
    };
  }

  it('passes the stylesheet to scanCss and scans it in linear work', () => {
    const css = fill(rule);
    const { result, work } = countCssWork(() => checkPack(files(css)));
    expect(result.issues).toEqual([]);
    expect(work.scanned).toBeGreaterThanOrEqual(css.length);
    expect(perCharacter(work)).toBeLessThanOrEqual(linear);
  });
});
