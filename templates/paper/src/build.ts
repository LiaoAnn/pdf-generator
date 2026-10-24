// Pre-renders the paper's KaTeX formulas into the pack (no script runs at
// print time) and writes KaTeX's stylesheet and fonts next to them.
//   pnpm --filter @pdf-generator/paper build-pack
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import katex from 'katex';
import { type FormulaSlot, formulas } from './formulas.ts';

const katexDist = join(
  dirname(createRequire(import.meta.url).resolve('katex/package.json')),
  'dist',
);

/**
 * KaTeX font faces the pack ships, as `fonts/<name>.ttf`: the faces the
 * formula pool prints (`build.test.ts` derives them from KaTeX's output).
 * TTF, not woff2: the platform didn't read the PostScript name of
 * KaTeX_Main-Regular.woff2 in a batch, so its text failed the font check.
 */
export const katexFonts: readonly string[] = [
  'KaTeX_Caligraphic-Regular',
  'KaTeX_Main-Bold',
  'KaTeX_Main-Regular',
  'KaTeX_Math-Italic',
  'KaTeX_Size1-Regular',
  'KaTeX_Size2-Regular',
  'KaTeX_Size3-Regular',
];

// Braces as character references, so neither the LaTeX nor KaTeX's text
// can form a Handlebars `{{`.
const escapeHtml = (text: string) =>
  text
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('{', '&#123;')
    .replaceAll('}', '&#125;');
const escapeBraces = (html: string) =>
  html.replaceAll('{', '&#123;').replaceAll('}', '&#125;');

/**
 * The Handlebars for one equation slot: one `{{#if (eq <slot> <index>)}}`
 * branch per option (on `@root`, so it works inside `{{#each}}`), each a `data-gt="formula"` block with its LaTeX in
 * `data-gt-latex` and KaTeX's pre-rendered HTML inside.
 */
export function formulaBranches(slot: FormulaSlot): string {
  return formulas[slot]
    .map((latex, index) => {
      const html = katex.renderToString(latex, {
        displayMode: true,
        output: 'html',
        throwOnError: true,
      });
      return `{{#if (eq @root.${slot} ${index})}}
<div class="equation" data-gt="formula" data-gt-latex="${escapeHtml(latex)}">${escapeBraces(html)}</div>
{{/if}}`;
    })
    .join('\n');
}

const marker = /^\s*<!-- formula (\S+) -->\s*$/;

/** The template source with every `<!-- formula <slot> -->` line expanded. */
export function expandTemplate(source: string): string {
  return source
    .split('\n')
    .map(line => {
      const slot = marker.exec(line)?.[1];
      if (slot === undefined) return line;
      if (!Object.hasOwn(formulas, slot)) {
        throw new Error(`unknown formula slot ${slot}`);
      }
      return formulaBranches(slot as FormulaSlot);
    })
    .join('\n');
}

/** KaTeX's stylesheet, trimmed to the shipped faces. */
export function katexStylesheet(): string {
  const upstream = readFileSync(join(katexDist, 'katex.min.css'), 'utf8');
  const trimmed = upstream.replace(/@font-face\{[^}]*\}/g, face => {
    const name = /url\(fonts\/([\w-]+)\.ttf\)/.exec(face)?.[1];
    if (name === undefined || !katexFonts.includes(name)) return '';
    return face.replace(
      /src:[^;}]*/,
      `src:url(../fonts/${name}.ttf) format("truetype")`,
    );
  });
  return `/* biome-ignore-all lint: KaTeX's own stylesheet, written by src/build.ts */
/* biome-ignore-all format: as KaTeX ships it */
${trimmed}`;
}

/** Every generated pack file, by its path inside `pack/`. */
export function buildPack(): Record<string, string | Uint8Array> {
  const source = readFileSync(new URL('paper.hbs', import.meta.url), 'utf8');
  return {
    'templates/paper.hbs': expandTemplate(source),
    'styles/katex.css': katexStylesheet(),
    ...Object.fromEntries(
      katexFonts.map(name => [
        `fonts/${name}.ttf`,
        new Uint8Array(readFileSync(join(katexDist, 'fonts', `${name}.ttf`))),
      ]),
    ),
  };
}

if (import.meta.main) {
  const pack = fileURLToPath(new URL('../pack/', import.meta.url));
  for (const [path, contents] of Object.entries(buildPack())) {
    mkdirSync(dirname(join(pack, path)), { recursive: true });
    writeFileSync(join(pack, path), contents);
  }
}
