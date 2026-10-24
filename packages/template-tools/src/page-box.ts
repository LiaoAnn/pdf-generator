// A cheap guard on pack CSS that moves the printed page under its ground
// truth: gt.json is measured from the laid-out page, and CSS aimed at Paged.js's
// page boxes or at the html/body box model prints content elsewhere (T08-1's
// Security review). Self-check's comparison of drawn boxes is the real check
// (T14-4); this only tells an author at upload.

/** One rule this guard refuses, at an offset into the CSS as given. */
export type PageBoxProblem = { offset: number; message: string };

/** The CSS with comments and string contents blanked, offsets unchanged. */
function masked(css: string): string {
  let out = '';
  let i = 0;
  while (i < css.length) {
    const c = css[i] ?? '';
    if (c === '/' && css[i + 1] === '*') {
      const close = css.indexOf('*/', i + 2);
      const end = close < 0 ? css.length : close + 2;
      out += css.slice(i, end).replace(/[^\n]/g, ' ');
      i = end;
    } else if (c === '"' || c === "'") {
      let end = i + 1;
      while (end < css.length && css[end] !== c && css[end] !== '\n') end++;
      out += `${c}${css.slice(i + 1, end).replace(/[^\n]/g, ' ')}`;
      i = end;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/** Splits at top-level commas (not inside parentheses or brackets). */
function splitList(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth--;
    else if (c === ',' && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

/**
 * Whether a selector's subject (its last compound) is the root element, the
 * body or every element: `html`, `body.x`, `html > body`, `:root`, `*`. Not
 * a pseudo-element, which is a box of its own.
 */
function selectsRoot(selector: string): boolean {
  const compound = selector
    .replace(/\([^)]*\)|\[[^\]]*\]/g, '()')
    .trim()
    .split(/\s*[>+~]\s*|\s+/)
    .at(-1);
  if (!compound || compound.includes('::')) return false;
  if (/^:root\b/i.test(compound)) return true;
  const type = /^(?:[a-z][a-z0-9-]*|\*)/i.exec(compound)?.[0]?.toLowerCase();
  return type === 'html' || type === 'body' || type === '*';
}

const zeroLength = /^[+-]?(?:0+(?:\.0*)?|\.0+)(?:[a-z]+|%)?$/;
const allZero = (tokens: string[]) =>
  tokens.every(token => zeroLength.test(token));

const borderSide =
  '(?:-(?:top|right|bottom|left|block|inline|block-start|block-end|inline-start|inline-end))?';
const borderShorthand = new RegExp(`^border${borderSide}$`);
const borderWidth = new RegExp(`^border${borderSide}-width$`);

/**
 * Whether a root-box declaration leaves the box as Paged.js expects it:
 * undefined when the property doesn't move the box at all.
 */
function neutral(property: string, value: string): boolean | undefined {
  const tokens = value
    .replace(/!\s*important\s*$/i, '')
    .trim()
    .toLowerCase()
    .split(/\s+/);
  if (/^(?:margin|padding)(?:-|$)/.test(property) || borderWidth.test(property))
    return allZero(tokens);
  if (borderShorthand.test(property))
    return tokens.some(
      token => token === 'none' || token === 'hidden' || zeroLength.test(token),
    );
  if (property === 'position') return tokens.join(' ') === 'static';
  if (/^(?:transform|translate|rotate|scale)$/.test(property))
    return tokens.join(' ') === 'none';
  if (property === 'zoom') return /^(?:normal|1|100%)$/.test(tokens.join(' '));
  return undefined;
}

/**
 * The rules in a stylesheet that select Paged.js's own elements, and the
 * declarations that move html or body (margin, padding, border, position,
 * transform, zoom) from their neutral values. `@page` margins are fine:
 * Paged.js lays out the page boxes from them.
 */
export function pageBoxProblems(css: string): PageBoxProblem[] {
  const text = masked(css);
  const problems: PageBoxProblem[] = [];
  // For each open block: does it hold declarations of a root-box rule?
  const stack: ('root' | 'rule' | 'at')[] = [];
  let start = 0;
  const declarations = (from: number, to: number) => {
    let at = from;
    for (const part of text.slice(from, to).split(';')) {
      const colon = part.indexOf(':');
      if (colon > 0) {
        const property = part.slice(0, colon).trim().toLowerCase();
        if (neutral(property, part.slice(colon + 1)) === false) {
          problems.push({
            offset: at + part.search(/\S/),
            message: `${part.trim()} moves html or body, which shifts the printed page away from its ground truth: leave their margin, padding, border, position and transform at 0/none, and set page margins with @page`,
          });
        }
      }
      at += part.length + 1;
    }
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '{') {
      const prelude = text.slice(start, i);
      const head = prelude.trim();
      if (stack.at(-1) === 'root') declarations(start, i);
      if (head.startsWith('@')) {
        // @media, @supports, @layer … hold rules; @page, @font-face and the
        // page's margin boxes hold declarations, which are theirs to set.
        stack.push('at');
      } else {
        // The first selector of the list that names one, from its start.
        let at = start;
        const pagedjs = splitList(prelude).find(selector => {
          if (/pagedjs/i.test(selector)) return true;
          at += selector.length + 1;
          return false;
        });
        if (pagedjs) {
          problems.push({
            offset: at + pagedjs.search(/\S/),
            message: `${head} selects Paged.js's page elements: their layout is the platform's, and changing it moves the printed page away from its ground truth`,
          });
        }
        stack.push(splitList(head).some(selectsRoot) ? 'root' : 'rule');
      }
      start = i + 1;
    } else if (c === '}') {
      if (stack.at(-1) === 'root') declarations(start, i);
      stack.pop();
      start = i + 1;
    } else if (c === ';' && stack.at(-1) !== 'root') {
      start = i + 1;
    }
  }
  return problems;
}
