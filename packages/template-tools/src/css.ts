// Just enough CSS reading for the asset and font checks: where its URLs are,
// which @font-face families it declares and which families it uses. Offsets
// are into the CSS text as given, so issues point at what the author wrote.

/** A URL as written, and the offset of its first character. */
export type Reference = { url: string; offset: number };

/** CSS with comments replaced by spaces (newlines kept), offsets unchanged. */
const withoutComments = (css: string) =>
  css.replace(/\/\*[\s\S]*?(?:\*\/|$)/g, comment =>
    comment.replace(/[^\n]/g, ' '),
  );

const imageSets = new Set(['image-set', '-webkit-image-set']);
const identifier = /[A-Za-z0-9_\-\u0080-￿]/;

/**
 * The URLs a stylesheet loads (`url(…)`, `@import "…"`, strings in
 * `image-set(…)`) and every backslash outside strings and comments: an escape
 * there can spell `url` or `@import` in a way no scanner here would see, and
 * a pack never needs one. One linear pass that knows strings and comments.
 */
export function scanCss(css: string): {
  references: Reference[];
  escapes: number[];
} {
  const references: Reference[] = [];
  const escapes: number[] = [];
  const functions: string[] = [];
  let importing = false;
  let i = 0;
  while (i < css.length) {
    const c = css[i] ?? '';
    if (c === '/' && css[i + 1] === '*') {
      const end = css.indexOf('*/', i + 2);
      i = end < 0 ? css.length : end + 2;
    } else if (c === '"' || c === "'") {
      let end = i + 1;
      while (end < css.length && css[end] !== c && css[end] !== '\n') {
        end += css[end] === '\\' ? 2 : 1;
      }
      const inside = functions.at(-1) ?? '';
      if (importing || inside === 'url' || imageSets.has(inside)) {
        references.push({ url: css.slice(i + 1, end), offset: i + 1 });
      }
      importing = false;
      i = end + 1;
    } else if (c === '\\') {
      escapes.push(i);
      i += 2;
    } else if (c === '@' || identifier.test(c)) {
      let end = i + 1;
      while (end < css.length && identifier.test(css[end] ?? '')) end++;
      const name = css.slice(c === '@' ? i + 1 : i, end).toLowerCase();
      if (c === '@') importing = name === 'import';
      else if (css[end] === '(' && name === 'url') {
        let start = end + 1;
        while (/\s/.test(css[start] ?? '')) start++;
        if (css[start] === '"' || css[start] === "'") {
          functions.push('url');
          i = start;
          continue;
        }
        const close = css.indexOf(')', start);
        const stop = close < 0 ? css.length : close;
        references.push({
          url: css.slice(start, stop).trimEnd(),
          offset: start,
        });
        importing = false;
        i = stop + 1;
        continue;
      } else if (css[end] === '(') {
        functions.push(name);
        end++;
      }
      i = end;
    } else {
      if (c === '(') functions.push('');
      else if (c === ')') functions.pop();
      else if (c === ';' || c === '{' || c === '}') importing = false;
      i++;
    }
  }
  return { references, escapes };
}

const facePattern = /@font-face\s*\{[^}]*\}/gi;

/** Family name as compared: unquoted, whitespace collapsed, lower case. */
const normalize = (name: string) =>
  name.replace(/["']/g, '').replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * The @font-face rules: the family each declares (as compared, and as
 * written) and the offset of its `@`.
 */
export function fontFaces(
  css: string,
): { family: string; name: string; offset: number }[] {
  return [...withoutComments(css).matchAll(facePattern)].flatMap(match => {
    const family = /font-family\s*:\s*([^;}]+)/i.exec(match[0])?.[1];
    return family === undefined
      ? []
      : [
          {
            family: normalize(family),
            name: family.replace(/["']/g, '').trim(),
            offset: match.index,
          },
        ];
  });
}

/**
 * Families named by `font-family` and `font` declarations outside @font-face
 * rules, in a stylesheet or in a `style` attribute's declarations. For the
 * `font` shorthand, the first family follows the size, so it is matched as the
 * end of the first comma-separated item.
 */
export function usedFamilies(css: string): {
  families: Set<string>;
  shorthandFirsts: string[];
} {
  const text = withoutComments(css).replace(facePattern, '');
  const families = new Set<string>();
  const shorthandFirsts: string[] = [];
  // Custom properties count too: `--body: Report` used as var(--body).
  for (const match of text.matchAll(
    /(?:^|[;{\s])(font-family|font|--[\w-]+)\s*:\s*([^;}]*)/gi,
  )) {
    const [first = '', ...rest] = (match[2] ?? '').split(',').map(normalize);
    if (match[1]?.toLowerCase() === 'font') shorthandFirsts.push(first);
    else families.add(first);
    for (const family of rest) families.add(family);
  }
  return { families, shorthandFirsts };
}
