// Just enough CSS reading for the asset and font checks: where its URLs are,
// which @font-face families it declares and which families it uses. Offsets
// are into the CSS text as given, so issues point at what the author wrote.

/** CSS whitespace: not the no-break space or other Unicode spaces. */
const cssSpace = /[ \t\n\r\f]/;

/** A URL as written, and the offset of its first character. */
export type Reference = {
  url: string;
  offset: number;
  /** `stylesheet` when it loads one (`@import`). */
  kind?: 'stylesheet';
};

/** CSS with comments replaced by spaces (newlines kept), offsets unchanged. */
const withoutComments = (css: string) =>
  css.replace(/\/\*[\s\S]*?(?:\*\/|$)/g, comment =>
    comment.replace(/[^\n]/g, ' '),
  );

const imageSets = new Set(['image-set', '-webkit-image-set']);
/** Functions image-set() may take directly: URLs, types and gradients. */
const imageArguments =
  /^(?:url|type|(?:-webkit-)?(?:repeating-)?(?:linear|radial|conic)-gradient)$/;
const identifier = /[A-Za-z0-9_\-\u0080-￿]/;

/**
 * The URLs a stylesheet loads (`url(…)`, `@import "…"`, strings in
 * `image-set(…)`) and every backslash outside comments: an escape can spell
 * `url` or `@import`, or end a string or url() where this scanner wouldn't,
 * and a UTF-8 pack never needs one. One linear pass that knows strings and
 * comments.
 */
export function scanCss(css: string): {
  references: Reference[];
  escapes: number[];
  /** var()/env()/attr() inside image-set(): a URL from elsewhere. */
  dynamic: number[];
} {
  const references: Reference[] = [];
  const escapes: number[] = [];
  const dynamic: number[] = [];
  const functions: string[] = [];
  let insideImageSet = 0;
  let importing = false;
  let i = 0;
  while (i < css.length) {
    const c = css[i] ?? '';
    if (c === '/' && css[i + 1] === '*') {
      const end = css.indexOf('*/', i + 2);
      i = end < 0 ? css.length : end + 2;
    } else if (c === '"' || c === "'") {
      let end = i + 1;
      // CR and form feed end a line in CSS as LF does.
      while (
        end < css.length &&
        css[end] !== c &&
        !/[\n\r\f]/.test(css[end] ?? '')
      ) {
        // Every backslash is an issue, so no need to know what it escapes.
        if (css[end] === '\\') escapes.push(end);
        end++;
      }
      const inside = functions.at(-1) ?? '';
      if (importing || inside === 'url' || imageSets.has(inside)) {
        references.push({
          url: css.slice(i + 1, end),
          offset: i + 1,
          ...(importing ? { kind: 'stylesheet' as const } : {}),
        });
      }
      importing = false;
      i = end + 1;
    } else if (c === '\\') {
      escapes.push(i);
      i++;
    } else if (c === '@' || identifier.test(c)) {
      let end = i + 1;
      while (end < css.length && identifier.test(css[end] ?? '')) end++;
      const name = css.slice(c === '@' ? i + 1 : i, end).toLowerCase();
      if (c === '@') importing = name === 'import';
      else if (css[end] === '(' && name === 'url') {
        let start = end + 1;
        while (cssSpace.test(css[start] ?? '')) start++;
        if (css[start] === '"' || css[start] === "'") {
          functions.push('url');
          i = start;
          continue;
        }
        const close = css.indexOf(')', start);
        const stop = close < 0 ? css.length : close;
        for (let at = start; at < stop; at++) {
          if (css[at] === '\\') escapes.push(at);
        }
        references.push({
          url: css.slice(start, stop).replace(/[ \t\n\r\f]+$/, ''),
          offset: start,
          ...(importing ? { kind: 'stylesheet' as const } : {}),
        });
        importing = false;
        i = stop + 1;
        continue;
      } else if (css[end] === '(') {
        // image-set() takes strings as URLs: any function that could make
        // one (custom functions, if(), var() …) hides a URL from this scan.
        const parent = functions.at(-1) ?? '';
        if (
          (imageSets.has(parent) && !imageArguments.test(name)) ||
          (['var', 'env', 'attr'].includes(name) && insideImageSet > 0)
        ) {
          dynamic.push(i);
        }
        if (imageSets.has(name)) insideImageSet++;
        functions.push(name);
        end++;
      }
      i = end;
    } else {
      if (c === '(') functions.push('');
      else if (c === ')' && imageSets.has(functions.pop() ?? '')) {
        insideImageSet--;
      } else if (c === ';' || c === '{' || c === '}') importing = false;
      i++;
    }
  }
  return { references, escapes, dynamic };
}

const facePattern = /@font-face\s*\{[^}]*\}/gi;

/** Family name as compared: unquoted, whitespace collapsed, lower case. */
const normalize = (name: string) =>
  name.replace(/["']/g, '').replace(/\s+/g, ' ').trim().toLowerCase();

/** A face's weight and style as the font-unused check compares them. */
export type FaceKind = { regular: boolean; bold: boolean; slanted: boolean };

/** A font-weight that asks for (or a face weight that is) bold: 600 and up. */
const isBold = (token: string) =>
  /^bold(?:er)?$/i.test(token) || Number(token) >= 600;
const isSlanted = (value: string) => /\b(?:italic|oblique)\b/i.test(value);

/**
 * The @font-face rules: the family each declares (as compared, and as
 * written), the weights and style it covers, and the offset of its `@`.
 */
export function fontFaces(
  css: string,
): ({ family: string; name: string; offset: number } & FaceKind)[] {
  return [...withoutComments(css).matchAll(facePattern)].flatMap(match => {
    const descriptor = (name: string) =>
      new RegExp(`${name}\\s*:\\s*([^;}]+)`, 'i').exec(match[0])?.[1];
    const family = descriptor('font-family');
    // normal, bold, a number or a range of two numbers (a variable face).
    const weights = (descriptor('font-weight') ?? 'normal')
      .trim()
      .split(/\s+/)
      .map(token => (/^bold$/i.test(token) ? 700 : Number(token) || 400));
    return family === undefined
      ? []
      : [
          {
            family: normalize(family),
            name: family.replace(/["']/g, '').trim(),
            offset: match.index,
            regular: Math.min(...weights) < 600,
            bold: Math.max(...weights) >= 600,
            slanted: isSlanted(descriptor('font-style') ?? ''),
          },
        ];
  });
}

/**
 * Whether declarations outside @font-face rules ask for bold or for italic
 * (or oblique): font-weight, font-style and the font shorthand.
 */
export function fontRequests(css: string): { bold: boolean; slanted: boolean } {
  const text = withoutComments(css).replace(facePattern, '');
  let bold = false;
  let slanted = false;
  for (const match of text.matchAll(
    /(?:^|[;{\s])(font-weight|font-style|font)\s*:\s*([^;}]*)/gi,
  )) {
    const property = match[1]?.toLowerCase();
    const value = (match[2] ?? '').replace(/!\s*important\s*$/i, ' ');
    if (property !== 'font-style') {
      bold ||= value.trim().split(/\s+/).some(isBold);
    }
    if (property !== 'font-weight') slanted ||= isSlanted(value);
  }
  return { bold, slanted };
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
