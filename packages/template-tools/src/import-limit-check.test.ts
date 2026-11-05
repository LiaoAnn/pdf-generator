// The upload check reads each string's Paged.js loads only up to just past
// the 64-load limit (T06-19): a pack of deeply nested @import blocks is
// refused with css-import-expansion in work linear in its size, and every
// pack is accepted or refused exactly as when the check read every load
// (the T06-17 walk, kept in paged-imports-full.test-support.ts).
import { manifestSchema, rulesSchema } from '@pdf-generator/contract';
import { recordSchema } from '@pdf-generator/fake-data';
import { describe, expect, it, vi } from 'vitest';
import { withHead } from '../fixtures/document.ts';
import type { PackFiles } from './index.ts';
import { pagedImportWork } from './paged-imports.ts';
import { fullPagedImports } from './paged-imports-full.test-support.ts';

const current = await import('./index.ts');
// The same check with the T06-17 walk, which reads every load.
vi.resetModules();
vi.doMock('./paged-imports.ts', async importOriginal => ({
  ...(await importOriginal<typeof import('./paged-imports.ts')>()),
  pagedImports: (css: string) => fullPagedImports(css),
}));
const previous = await import('./index.ts');
vi.doUnmock('./paged-imports.ts');

function pack(
  sheets: Record<string, string>,
  styles: string[],
  head: string,
): PackFiles {
  const rules = rulesSchema.parse({
    schemaVersion: 1,
    fields: { holder: { type: 'name' } },
  });
  const manifest = manifestSchema.parse({
    schemaVersion: 1,
    id: 'import-limit',
    name: '巢狀引用上限測試',
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

/** A chain of `depth` opener blocks around `inner`. */
const chain = (depth: number, opener: string, inner = '') =>
  opener.repeat(depth) + inner + '}'.repeat(depth);

/** Most the bounded walk may count per character of CSS (paged-import-limit.test.ts). */
const linear = 6;

describe('checkPack on nested @import blocks', () => {
  // 500 deep: 9 KiB that the T06-17 walk read as 125,250 loads. Much
  // deeper, css-tree's recursive walker can run out of stack before the JIT
  // warms up, and the pack is refused as pack-too-complex instead.
  const depth = 500;

  it('refuses @import blocks nested 500 deep with css-import-expansion, in linear work', () => {
    const css = chain(depth, '@import "b.css" {');
    const before = pagedImportWork.walked;
    const result = current.checkPack(
      pack(
        { 'styles/a.css': css, 'styles/b.css': 'p { margin: 0; }' },
        ['styles/a.css'],
        '',
      ),
    );
    const walked = pagedImportWork.walked - before;

    expect(result.issues).toEqual([
      {
        code: 'css-import-expansion',
        file: 'styles/a.css',
        message: expect.stringMatching(/\b64\b/),
      },
    ]);
    expect(walked).toBeGreaterThan(depth);
    expect(walked / css.length).toBeLessThanOrEqual(linear);
  });

  it('refuses them in a template <style> too, in linear work', () => {
    const css = chain(depth, '@import "../styles/b.css" {');
    const before = pagedImportWork.walked;
    const result = current.checkPack(
      pack({ 'styles/b.css': 'p { margin: 0; }' }, [], `<style>${css}</style>`),
    );
    const walked = pagedImportWork.walked - before;

    expect(result.ok).toBe(false);
    expect(new Set(result.issues.map(issue => issue.code))).toEqual(
      new Set(['css-import-expansion']),
    );
    expect(walked / css.length).toBeLessThanOrEqual(linear);
  });
});

/** Where the nested sheet sits: what makes its loads count, or not. */
const placements = {
  /** A manifest style: its loads are @imports between sheets. */
  manifest: (css: (dir: string) => string, extra: Record<string, string>) =>
    pack({ 'styles/a.css': css(''), ...extra }, ['styles/a.css'], ''),
  /** The template's own <style>: each load is a stylesheet of the template. */
  style: (css: (dir: string) => string, extra: Record<string, string>) =>
    pack(extra, [], `<style>${css('../styles/')}</style>`),
  /**
   * Reached only by a url() that loads no stylesheet: the check reads the
   * sheet, but Paged.js never applies it, so its @imports load nothing.
   */
  reached: (css: (dir: string) => string, extra: Record<string, string>) =>
    pack(
      { 'styles/a.css': css(''), ...extra },
      [],
      '<style>p{background-image:url(../styles/a.css)}</style>',
    ),
};

/** What the nested string loads, written relative to the sheet's folder. */
const targets: ((dir: string) => string)[] = [
  dir => `${dir}b.css`,
  dir => `${dir}big.css`,
  dir => `${dir}gone.css`,
  dir => `${dir}a.css`,
  () => 'data:text/css,p{}',
  () => '',
];

/** How the string is nested: as each @import's own URL, or once inside them all. */
const forms = {
  prelude: (depth: number, target: string, media: Media) =>
    chain(
      depth,
      `@import "${target}" {`,
      media === 'inner' ? '@media screen{}' : '',
    ),
  block: (depth: number, target: string, media: Media) =>
    chain(
      depth,
      '@import {',
      `p{content:"${target}"}${media === 'inner' ? '@media screen{}' : ''}`,
    ),
};
type Media = 'none' | 'outer' | 'inner';
const medias: Media[] = ['none', 'outer', 'inner'];

const depths = [1, 40, 64, 65, 66, 67, 130];

const sheets = {
  'styles/b.css': 'p { margin: 0; }',
  // 1 MiB of CSS is 52 loads of it: refused for bytes below the load limit.
  'styles/big.css': `p { margin: 0; }\n${'/* padding */\n'.repeat(1400)}`,
};

describe('checkPack accepts and refuses exactly what it did when it read every load', () => {
  const cases = Object.entries(placements).flatMap(([placement, build]) =>
    depths.flatMap(depth =>
      targets.flatMap((target, t) =>
        Object.entries(forms).map(([form, nest], f) => {
          const media = medias[(depth + t + f) % medias.length] as Media;
          const css = (dir: string) => {
            const inner = nest(depth, target(dir), media);
            // A screen @import around it all: Paged.js skips that one only.
            return media === 'outer'
              ? `@import "${dir}b.css" screen {${inner}}`
              : inner;
          };
          return {
            name: `${placement}, ${form}, ${depth} deep, ${target('') || '""'}, media ${media}`,
            depth,
            files: build(css, sheets),
          };
        }),
      ),
    ),
  );

  it('gives the same result as the full walk on every generated pack', () => {
    const outcomes = {
      accepted: 0,
      refused: 0,
      acceptedPastLimit: 0,
      expansionPastLimit: 0,
    };
    for (const { name, depth, files } of cases) {
      const old = previous.checkPack(files);
      const now = current.checkPack(files);
      const codes = (issues: { code: string }[]) =>
        [...new Set(issues.map(issue => issue.code))].sort();

      expect({ ok: now.ok, codes: codes(now.issues) }, name).toEqual({
        ok: old.ok,
        codes: codes(old.issues),
      });
      if (old.ok) outcomes.accepted++;
      else outcomes.refused++;
      // Deeper than the limit (66 or just past it): loads were dropped.
      const past = depth > 67;
      if (past && old.ok) outcomes.acceptedPastLimit++;
      if (past && codes(old.issues).includes('css-import-expansion'))
        outcomes.expansionPastLimit++;
    }
    // The generated packs span both outcomes, past the limit too.
    expect(outcomes.accepted).toBeGreaterThan(20);
    expect(outcomes.refused).toBeGreaterThan(20);
    expect(outcomes.acceptedPastLimit).toBeGreaterThan(3);
    expect(outcomes.expansionPastLimit).toBeGreaterThan(3);
  });

  it('accepts the shallow packs of each placement', () => {
    for (const build of Object.values(placements)) {
      const result = current.checkPack(
        build(dir => `@import {p{content:"${dir}b.css"}}`, sheets),
      );
      expect(result.issues).toEqual([]);
    }
  });
});
