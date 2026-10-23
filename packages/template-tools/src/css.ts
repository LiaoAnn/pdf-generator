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

// The `d` flag records where each group starts: the URL's own offset.
const urlPattern = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s"']*))\s*\)/dgi;
const importPattern = /@import\s+(?:"([^"]*)"|'([^']*)')/dgi;

const matches = (pattern: RegExp, css: string): Reference[] =>
  [...css.matchAll(pattern)].map(match => {
    const group = [1, 2, 3].find(i => match[i] !== undefined) ?? 0;
    return {
      url: match[group] ?? '',
      offset: match.indices?.[group]?.[0] ?? match.index,
    };
  });

/** Every `url(…)` and `@import "…"` outside comments. */
export function cssReferences(css: string): Reference[] {
  const text = withoutComments(css);
  return [...matches(urlPattern, text), ...matches(importPattern, text)];
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
  for (const match of text.matchAll(
    /(?:^|[;{\s])(font-family|font)\s*:\s*([^;}]*)/gi,
  )) {
    const [first = '', ...rest] = (match[2] ?? '').split(',').map(normalize);
    if (match[1]?.toLowerCase() === 'font') shorthandFirsts.push(first);
    else families.add(first);
    for (const family of rest) families.add(family);
  }
  return { families, shorthandFirsts };
}
