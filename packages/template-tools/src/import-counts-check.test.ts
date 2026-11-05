// The upload check reads each string Paged.js loads once, with the number
// of times it loads it (T06-19): a pack of deeply nested @import blocks is
// refused with css-import-expansion in work linear in its size, and every
// pack is accepted or refused, with the same issues, as when the check read
// every load (the T06-17 walk, kept in paged-imports-full.test-support.ts).
import { manifestSchema, rulesSchema } from '@pdf-generator/contract';
import { recordSchema } from '@pdf-generator/fake-data';
import { describe, expect, it, vi } from 'vitest';
import { withHead } from '../fixtures/document.ts';
import { importWork } from './assets.ts';
import type { PackFiles } from './index.ts';
import type { CheckIssue } from './issues.ts';
import { pagedImportWork } from './paged-imports.ts';
import { fullPagedImports } from './paged-imports-full.test-support.ts';

const current = await import('./index.ts');
// The check as it was before T06-19: every load the T06-17 walk reads, in
// its order, reaches the check one by one.
vi.resetModules();
vi.doMock('./paged-imports.ts', async importOriginal => ({
  ...(await importOriginal<typeof import('./paged-imports.ts')>()),
  pagedImports: (css: string) =>
    fullPagedImports(css).map(load => ({ ...load, loads: 1 })),
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
    id: 'import-counts',
    name: '巢狀引用次數測試',
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

/** Most the walk may count per character of CSS (paged-import-counts.test.ts). */
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
  /** 60 strings inside them all: more @imports close a cycle than are listed. */
  many: (depth: number, target: string, media: Media) =>
    chain(
      depth,
      '@import {',
      `${`p{content:"${target}"}`.repeat(60)}${media === 'inner' ? '@media screen{}' : ''}`,
    ),
};
type Media = 'none' | 'outer' | 'inner';
const medias: Media[] = ['none', 'outer', 'inner'];

const depths = [1, 40, 64, 65, 66, 130];

const sheets = {
  'styles/b.css': 'p { margin: 0; }',
  // 1 MiB of CSS is 52 loads of it: refused for bytes below the load limit.
  'styles/big.css': `p { margin: 0; }\n${'/* padding */\n'.repeat(1400)}`,
};

/** Where an issue points: its code, file and place. */
const at = (issue: CheckIssue) =>
  `${issue.code} ${issue.file}:${issue.line ?? ''}:${issue.column ?? ''}`;

/** The cycle issue that counts the cycles past the ones listed. */
const counting = (issue: CheckIssue) =>
  issue.code === 'css-import-cycle' && / more @imports/.test(issue.message);

describe('checkPack gives the result it gave when it read every load', () => {
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
            files: build(css, sheets),
          };
        }),
      ),
    ),
  );

  // 324 packs, each checked twice, the old way loading every string
  // once per @import around it.
  it('accepts, refuses and points at the same places on every generated pack', {
    timeout: 60_000,
  }, () => {
    const outcomes = { accepted: 0, refused: 0, expansion: 0, counted: 0 };
    for (const { name, files } of cases) {
      const old = previous.checkPack(files);
      const now = current.checkPack(files);
      const places = (issues: CheckIssue[], cycles: boolean) =>
        [
          ...new Set(
            issues
              .filter(issue => (issue.code === 'css-import-cycle') === cycles)
              .filter(issue => !counting(issue))
              .map(at),
          ),
        ].sort();

      expect(now.ok, name).toBe(old.ok);
      // Every issue but the cycles: the same places, the same expansion.
      expect(places(now.issues, false), name).toEqual(
        places(old.issues, false),
      );
      expect(
        now.issues.filter(issue => issue.code === 'css-import-expansion'),
        name,
      ).toEqual(
        old.issues.filter(issue => issue.code === 'css-import-expansion'),
      );
      // The cycles: the first 50 @imports that close one are listed. The old
      // check spent list places on repeated loads of the same string, so it
      // listed the first of these, never another.
      const oldCycles = places(old.issues, true);
      const nowCycles = places(now.issues, true);
      expect(nowCycles, name).toEqual(expect.arrayContaining(oldCycles));
      if (!old.issues.some(counting)) {
        expect(nowCycles, name).toEqual(oldCycles);
        expect(now.issues.some(counting), name).toBe(false);
      } else outcomes.counted++;
      expect(new Set(now.issues.map(issue => issue.code)), name).toEqual(
        new Set(old.issues.map(issue => issue.code)),
      );

      if (old.ok) outcomes.accepted++;
      else outcomes.refused++;
      if (old.issues.some(issue => issue.code === 'css-import-expansion'))
        outcomes.expansion++;
    }
    // The generated packs span both outcomes and the counted cycles.
    expect(outcomes.accepted).toBeGreaterThan(20);
    expect(outcomes.refused).toBeGreaterThan(20);
    expect(outcomes.expansion).toBeGreaterThan(20);
    expect(outcomes.counted).toBeGreaterThan(5);
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

describe('checkPack on many strings under 64 @import blocks: a few steps per string', () => {
  // The Security lens's shapes (T06-19): 64 blocks keep each string at 64
  // loads, so 2,500 strings make 160,000 loads; reading them one by one cost
  // up to 3 s, mostly building a cycle path for every one of them.
  const strings = 2500;
  const sheet = (target: string) =>
    chain(64, '@import {', `p{content:"${target}";}`.repeat(strings));
  /** 1.css → 2.css → … → 189.css → 0.css. */
  const cycle = Object.fromEntries(
    Array.from({ length: 189 }, (_, i) => [
      `styles/${i + 1}.css`,
      `@import "${i === 188 ? 0 : i + 2}.css";`,
    ]),
  );

  it.each<{
    name: string;
    files: Record<string, string>;
    expected: (issues: CheckIssue[]) => void;
  }>([
    {
      name: 'behind a cycle of 190 sheets',
      files: { 'styles/0.css': sheet('1.css'), ...cycle },
      expected: issues => {
        expect(new Set(issues.map(issue => issue.code))).toEqual(
          new Set(['css-import-cycle', 'css-import-expansion']),
        );
        // 50 listed, one that counts the rest, and the expansion.
        expect(issues).toHaveLength(52);
        expect(issues.filter(counting)).toHaveLength(1);
      },
    },
    {
      name: 'loading a missing sheet',
      files: { 'styles/0.css': sheet('gone.css') },
      expected: issues => {
        // One per string, not one per load.
        expect(issues).toHaveLength(strings);
        expect(new Set(issues.map(issue => issue.code))).toEqual(
          new Set(['asset-missing']),
        );
      },
    },
    {
      name: 'loading a sheet',
      files: { 'styles/0.css': sheet('1.css'), 'styles/1.css': 'p{margin:0}' },
      expected: issues => {
        expect(issues).toEqual([
          {
            code: 'css-import-expansion',
            file: 'styles/0.css',
            message: expect.stringMatching(/\b64\b/),
          },
        ]);
      },
    },
  ])('checks strings $name in a few steps each', ({ files, expected }) => {
    const css = Object.values(files).join('');
    const sheets = Object.keys(files).length;
    const before = { ...importWork, walked: pagedImportWork.walked };
    const result = current.checkPack(pack(files, ['styles/0.css'], ''));
    const references = importWork.references - before.references;
    const cycleSteps = importWork.cycleSteps - before.cycleSteps;
    const walked = pagedImportWork.walked - before.walked;

    expected(result.issues);
    // One reference per string and per @import between sheets.
    expect(references).toBeGreaterThanOrEqual(strings);
    expect(references).toBeLessThanOrEqual(strings + 2 * sheets);
    // Cycle paths are built only for the cycles listed: 51 at most.
    expect(cycleSteps).toBeLessThanOrEqual(51 * (sheets + 1));
    expect(walked / css.length).toBeLessThanOrEqual(linear);
  });
});
