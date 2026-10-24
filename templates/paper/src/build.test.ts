import { execFileSync } from 'node:child_process';
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fill } from '@pdf-generator/template-tools';
import katex from 'katex';
import { type DefaultTreeAdapterMap, parseFragment, serialize } from 'parse5';
import { describe, expect, it } from 'vitest';
import {
  buildPack,
  expandTemplate,
  formulaBranches,
  katexFonts,
  katexStylesheet,
} from './build.ts';
import { type FormulaSlot, formulas } from './formulas.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const katexRoot = dirname(
  createRequire(import.meta.url).resolve('katex/package.json'),
);
const upstreamCss = readFileSync(join(katexRoot, 'dist/katex.min.css'), 'utf8');
const slots = Object.keys(formulas) as FormulaSlot[];
const cases = slots.flatMap(slot =>
  formulas[slot].map((latex, index) => ({ slot, index, latex })),
);
type Node = DefaultTreeAdapterMap['node'];
type Element = DefaultTreeAdapterMap['element'];

function elements(node: Node): Element[] {
  if (!('childNodes' in node)) return [];
  return [
    ...('tagName' in node ? [node] : []),
    ...node.childNodes.flatMap(elements),
  ];
}

const attr = (node: Element, name: string) =>
  node.attrs.find(a => a.name === name)?.value;
const classes = (node: Element) => (attr(node, 'class') ?? '').split(/\s+/);
const render = (latex: string) =>
  katex.renderToString(latex, {
    displayMode: true,
    output: 'html',
    throwOnError: true,
  });

function declarations(body: string): Record<string, string> {
  return Object.fromEntries(
    body
      .split(';')
      .filter(s => s.trim())
      .map(s => {
        const colon = s.indexOf(':');
        return [s.slice(0, colon).trim(), s.slice(colon + 1).trim()];
      }),
  );
}

function rules(css: string) {
  return [
    ...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g),
  ].map(m => ({
    selector: (m[1] ?? '').trim(),
    declarations: declarations(m[2] ?? ''),
  }));
}

// Only the selector grammar used by KaTeX's relevant rules is accepted. Fail
// closed on new syntax rather than silently underestimating required faces.
function matches(node: Element, selector: string): boolean {
  const expanded = selector.replace(/:where\(([^()]*)\)/g, '$1');
  const tokens = expanded
    .trim()
    .replace(/\s*>\s*/g, ' > ')
    .split(/\s+/);
  const simple = (element: Element, token: string): boolean => {
    let excluded = false;
    token = token.replace(/:not\(([^()]*)\)/g, (_, part: string) => {
      if (simple(element, part)) excluded = true;
      return '';
    });
    if (excluded) return false;
    if (token.includes('::')) return false; // Pseudo-elements do not style text nodes.
    if (!/^(?:[\w-]+|\*)?(?:\.[\w-]+)*$/.test(token))
      throw new Error(`Unsupported KaTeX selector: ${selector}`);
    const tag = /^[\w-]+/.exec(token)?.[0];
    return (
      (!tag || tag === element.tagName) &&
      [...token.matchAll(/\.([\w-]+)/g)].every(m =>
        classes(element).includes(m[1] ?? ''),
      )
    );
  };
  const visit = (element: Element, index: number): boolean => {
    if (!simple(element, tokens[index] ?? '')) return false;
    if (index === 0) return true;
    const direct = tokens[index - 1] === '>';
    const next = index - (direct ? 2 : 1);
    let parent = element.parentNode;
    while (parent && 'tagName' in parent) {
      if (visit(parent, next)) return true;
      if (direct) return false;
      parent = parent.parentNode;
    }
    return false;
  };
  return visit(node, tokens.length - 1);
}

function specificity(selector: string): number {
  const normal = selector.replace(/:where\([^()]*\)/g, '');
  return (
    (normal.match(/\.[\w-]+/g)?.length ?? 0) * 10 +
    (normal.match(/(?:^|[\s>])[a-z][\w-]*/g)?.length ?? 0)
  );
}

// Compute the inherited font triple at each text node, including font shorthand
// resets, selector specificity, source order, and inline overrides. Face names
// come from upstream @font-face rules, not a hand-maintained list of classes.
function computed(
  node: Element,
  css: string,
  inherited: Record<string, string> = {},
) {
  const result = { ...inherited };
  const priorities: Record<string, number> = {};
  const apply = (values: Record<string, string>, priority: number) => {
    const expanded = { ...values };
    if (values.font) {
      const font = /^(.*?)\s*[\d.]+(?:em|px|pt)(?:\/[^\s]+)?\s+(.+)$/.exec(
        values.font,
      );
      if (!font)
        throw new Error(`Unsupported KaTeX font shorthand: ${values.font}`);
      expanded['font-family'] = font[2] ?? '';
      expanded['font-weight'] = /\b(?:bold|700)\b/.test(font[1] ?? '')
        ? 'bold'
        : 'normal';
      expanded['font-style'] = /\bitalic\b/.test(font[1] ?? '')
        ? 'italic'
        : 'normal';
    }
    for (const [key, value] of Object.entries(expanded)) {
      if (priority >= (priorities[key] ?? -1)) {
        result[key] = value;
        priorities[key] = priority;
      }
    }
  };
  for (const rule of rules(css)) {
    if (rule.selector.startsWith('@')) continue;
    if (
      !Object.keys(rule.declarations).some(key =>
        [
          'font',
          'font-family',
          'font-style',
          'font-weight',
          'position',
          'display',
        ].includes(key),
      )
    )
      continue;
    for (const selector of rule.selector.split(',')) {
      if (matches(node, selector.trim()))
        apply(rule.declarations, specificity(selector));
    }
  }
  apply(declarations(attr(node, 'style') ?? ''), 1000);
  return result;
}

const faceKey = (style: Record<string, string>) =>
  [
    (style['font-family'] ?? '').split(',')[0]?.replace(/["']/g, '').trim(),
    (style['font-weight'] ?? 'normal')
      .replace(/^400$/, 'normal')
      .replace(/^700$/, 'bold'),
    style['font-style'] ?? 'normal',
  ].join('|');

function neededFaces(html: string): Set<string> {
  const faceByStyle = new Map(
    rules(upstreamCss)
      .filter(r => r.selector === '@font-face')
      .map(r => {
        const name = /fonts\/(KaTeX_[\w-]+)\.ttf/.exec(
          r.declarations.src ?? '',
        )?.[1];
        if (!name) throw new Error('Upstream KaTeX face has no TTF source');
        return [faceKey(r.declarations), name];
      }),
  );
  const needed = new Set<string>();
  const visit = (node: Node, inherited: Record<string, string>) => {
    const style =
      'tagName' in node ? computed(node, upstreamCss, inherited) : inherited;
    if (
      'nodeName' in node &&
      node.nodeName === '#text' &&
      'value' in node &&
      node.value.replace(/[\s\u200b]/g, '')
    ) {
      const face = faceByStyle.get(faceKey(style));
      if (!face)
        throw new Error(
          `No upstream face for ${faceKey(style)}: ${node.value}`,
        );
      needed.add(face);
    }
    if ('childNodes' in node)
      node.childNodes.forEach(child => {
        visit(child, style);
      });
  };
  visit(parseFragment(html), {});
  return needed;
}

describe('paper formula build', () => {
  it('reproduces every committed generated file and the build-pack CLI writes the same bytes', () => {
    // Regression: source changes without rebuilding the shipped pack, or the
    // direct-node CLI imports successfully but never writes the files.
    const generated = buildPack();
    expect(generated).toHaveProperty('styles/katex.css', katexStylesheet());
    for (const face of katexFonts) {
      expect(generated).toHaveProperty(`fonts/${face}.ttf`);
      expect(Buffer.from(generated[`fonts/${face}.ttf`] ?? '')).toEqual(
        readFileSync(join(katexRoot, `dist/fonts/${face}.ttf`)),
      );
    }
    const temporary = mkdtempSync(join(tmpdir(), 'paper-build-'));
    try {
      cpSync(join(root, 'src'), join(temporary, 'src'), { recursive: true });
      cpSync(join(root, 'package.json'), join(temporary, 'package.json'));
      symlinkSync(
        join(root, 'node_modules'),
        join(temporary, 'node_modules'),
        'dir',
      );
      execFileSync('pnpm', ['build-pack'], { cwd: temporary, stdio: 'pipe' });
      for (const [path, contents] of Object.entries(generated)) {
        const expected = Buffer.from(contents);
        expect(
          readFileSync(join(root, 'pack', path)),
          `committed ${path}; run build-pack`,
        ).toEqual(expected);
        expect(
          readFileSync(join(temporary, 'pack', path)),
          `CLI ${path}`,
        ).toEqual(expected);
      }
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });

  it.each(cases)(
    'fills $slot option $index with exactly its original LaTeX and pre-rendered display HTML',
    ({ slot, index, latex }) => {
      // Regression: Handlebars consumes TeX braces, attribute escaping corrupts
      // the label, wrong branches print, or MathML/scripts replace static HTML.
      const filled = fill(formulaBranches(slot), {
        eq1: 0,
        eq2: 0,
        eq3: 0,
        eq4: 0,
        [slot]: index,
      });
      const all = elements(parseFragment(filled));
      const blocks = all.filter(node => attr(node, 'data-gt') === 'formula');
      expect(blocks).toHaveLength(1);
      const block = blocks[0];
      expect(block).toBeDefined();
      if (!block) return;
      expect(attr(block, 'data-gt-latex')).toBe(latex);
      const display = elements(block).filter(node =>
        classes(node).includes('katex-display'),
      );
      expect(display).toHaveLength(1);
      // Parsing both sides normalizes entity spelling after fill; compare all
      // inner markup, including every attribute, style, and text node.
      expect(serialize(block).trim()).toBe(
        serialize(parseFragment(render(latex))),
      );
      for (const face of neededFaces(serialize(block)))
        expect(katexFonts, face).toContain(face);
      expect(
        all.some(
          node =>
            ['math', 'script'].includes(node.tagName) ||
            classes(node).includes('katex-mathml'),
        ),
      ).toBe(false);
    },
  );

  it('expands only standalone formula markers, preserves other text, and rejects unknown slots', () => {
    // Regression: replace only the first marker, miss an indented line, or
    // consume unrelated inline comments/template fields with a greedy regexp.
    const source =
      'Title {{title}}\n<!-- formula eq1 -->\n  <!-- formula eq2 -->\nUntouched {{title}} &amp; body.\n<!-- formula eq3 -->\n<!-- formula eq4 -->\n<!-- formula eq1 -->\ninline <!-- formula eq2 --> text\n<!-- ordinary -->\n';
    const result = expandTemplate(source);
    const filled = fill(result, {
      title: 'Paper',
      eq1: 2,
      eq2: 1,
      eq3: 0,
      eq4: 2,
    });
    expect(
      elements(parseFragment(filled))
        .filter(n => attr(n, 'data-gt') === 'formula')
        .map(n => attr(n, 'data-gt-latex')),
    ).toEqual([
      formulas.eq1[2],
      formulas.eq2[1],
      formulas.eq3[0],
      formulas.eq4[2],
      formulas.eq1[2],
    ]);
    expect(result.startsWith('Title {{title}}\n')).toBe(true);
    expect(result).toContain('\nUntouched {{title}} &amp; body.\n');
    expect(
      result.endsWith(
        '\ninline <!-- formula eq2 --> text\n<!-- ordinary -->\n',
      ),
    ).toBe(true);
    expect(expandTemplate('plain {{title}}\n<!-- ordinary -->\n')).toBe(
      'plain {{title}}\n<!-- ordinary -->\n',
    );
    expect(() =>
      expandTemplate('before\n<!-- formula eq99 -->\nafter'),
    ).toThrow();
  });

  it('ships every face required by the actual formula text and only local TTF font-face URLs', () => {
    // Regression: selecting fonts from class names alone misses inherited
    // bold/italic faces, scalable delimiters, or large operators.
    const needed = new Set(
      cases.flatMap(({ latex }) => [...neededFaces(render(latex))]),
    );
    expect(needed.size).toBeGreaterThan(1);
    const css = katexStylesheet();
    const faces = rules(css).filter(r => r.selector === '@font-face');
    const declared = faces.map(rule => {
      const urls = [
        ...(rule.declarations.src ?? '').matchAll(
          /url\(\s*["']?([^"')\s]+)["']?\s*\)/g,
        ),
      ].map(m => m[1]);
      expect(urls).toHaveLength(1);
      expect(urls[0]).toMatch(/^\.\.\/fonts\/KaTeX_[\w-]+\.ttf$/);
      const name =
        urls[0]
          ?.split('/')
          .at(-1)
          ?.replace(/\.ttf$/, '') ?? '';
      const upstream = rules(upstreamCss).find(
        r =>
          r.selector === '@font-face' &&
          (r.declarations.src ?? '').includes(`/${name}.ttf`),
      );
      expect(upstream, name).toBeDefined();
      expect(faceKey(rule.declarations), name).toBe(
        faceKey(upstream?.declarations ?? {}),
      );
      return name;
    });
    expect([...declared].sort()).toEqual([...katexFonts].sort());
    expect(new Set(declared).size).toBe(declared.length);
    for (const name of needed)
      expect(declared, `required face ${name}`).toContain(name);
    for (const match of css.matchAll(/url\(\s*["']?([^"')\s]+)["']?\s*\)/g)) {
      expect(declared.map(name => `../fonts/${name}.ttf`)).toContain(match[1]);
    }
    // The retained layout/font rules must still select the same faces.
    for (const { latex } of cases) {
      const html = parseFragment(render(latex));
      for (const element of elements(html)) {
        if (
          !element.childNodes.some(
            n => 'value' in n && n.value.replace(/[\s\u200b]/g, ''),
          )
        )
          continue;
        const ancestry: Element[] = [];
        let current: Node | null = element;
        while (current && 'tagName' in current) {
          ancestry.unshift(current);
          current = current.parentNode;
        }
        let original: Record<string, string> = {};
        let trimmed: Record<string, string> = {};
        for (const ancestor of ancestry) {
          original = computed(ancestor, upstreamCss, original);
          trimmed = computed(ancestor, css, trimmed);
        }
        expect(faceKey(trimmed)).toBe(faceKey(original));
      }
    }
  });

  it('preserves positioned KaTeX spans, positions ordinary spans with zero specificity, and hides vlist-s', () => {
    // Regression: PDF paint order diverges from DOM text order, a broad rule
    // overrides absolute tags/accents, or U+200B remains in the GT DOM text.
    const css = katexStylesheet();
    const fixes = rules(css).filter(
      r =>
        r.declarations.position === 'relative' &&
        r.selector.includes(':where('),
    );
    expect(fixes.length).toBeGreaterThan(0);
    for (const rule of fixes)
      for (const selector of rule.selector.split(','))
        expect(specificity(selector)).toBe(0);
    let ordinary = 0;
    let absolute = 0;
    let hidden = 0;
    for (const { latex } of cases) {
      const spans = elements(parseFragment(render(latex))).filter(
        n => n.tagName === 'span',
      );
      for (const node of spans) {
        let parent = node.parentNode;
        let inHtml = false;
        while (parent && 'tagName' in parent) {
          if (classes(parent).includes('katex-html')) inHtml = true;
          parent = parent.parentNode;
        }
        if (!inHtml) continue;
        const before = computed(node, upstreamCss).position;
        const after = computed(node, css);
        if (before === 'absolute') {
          expect(after.position).toBe('absolute');
          absolute++;
        } else {
          expect(after.position).toBe('relative');
          ordinary++;
        }
        if (classes(node).includes('vlist-s')) {
          expect(after.display).toBe('none');
          hidden++;
        }
      }
    }
    expect(ordinary).toBeGreaterThan(0);
    expect(absolute).toBeGreaterThan(0);
    expect(hidden).toBeGreaterThan(0);
  });

  it('leaves room for the paper body within the platform text-file limit', () => {
    // Regression: duplicate output or HTML+MathML bloats the static branches
    // until a complete paper can no longer pass the 64 KiB pack text gate.
    const branches = slots.map(formulaBranches).join('\n');
    expect(Buffer.byteLength(branches, 'utf8')).toBeLessThanOrEqual(52 * 1024);
  });
});
