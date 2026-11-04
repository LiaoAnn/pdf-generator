// How the browser's URL parser reads a URL as written, shared by assets.ts
// and svg.ts so both trim and decode a URL exactly as the parser would.
import type { Reference } from './css.ts';

/**
 * Where a URL starts and ends once the browser's URL parser has stripped the
 * C0 controls and spaces around it; it keeps the no-break space and other
 * Unicode spaces, which then name a file that isn't in the pack.
 */
export const urlStart = (url: string) => {
  let i = 0;
  while (i < url.length && url.charCodeAt(i) <= 0x20) i++;
  return i;
};
export const urlEnd = (url: string) => {
  let i = url.length;
  while (i > 0 && url.charCodeAt(i - 1) <= 0x20) i--;
  return i;
};

/**
 * The candidate URLs of a srcset, with their offsets in it, as the HTML spec
 * splits them: a URL runs to the next whitespace (commas included, so data:
 * URLs survive), then a descriptor runs to the next comma.
 */
/** Exported for svg.ts, which runs the same URLs inside an SVG file. */
export function srcsetUrls(value: string): Reference[] {
  const urls: Reference[] = [];
  let i = 0;
  while (i < value.length) {
    while (i < value.length && /[\t\n\f\r ,]/.test(value[i] ?? '')) i++;
    const start = i;
    while (i < value.length && !/[\t\n\f\r ]/.test(value[i] ?? '')) i++;
    let url = value.slice(start, i);
    if (url.endsWith(',')) {
      // A backward scan, not /,+$/: that regex retries the comma run from
      // each comma in it (quadratic on `x,,,…,x,`).
      let end = url.length;
      while (end > 0 && url.charCodeAt(end - 1) === 0x2c) end--;
      url = url.slice(0, end);
    } else while (i < value.length && value[i] !== ',') i++;
    if (url !== '') urls.push({ url, offset: start });
  }
  return urls;
}

/**
 * The URL parser's view of a URL as written (the caller does its own NUL
 * handling first): tab, LF and CR dropped anywhere, C0 controls and spaces
 * trimmed from the ends. Returned with the index in the given string of the
 * first character the view keeps — where an issue in the URL points — or
 * undefined when nothing is left.
 */
export function urlParserView(
  url: string,
): { url: string; at: number } | undefined {
  let view = '';
  const toUrl: number[] = [];
  for (let k = 0; k < url.length; k++) {
    const char = url.charCodeAt(k);
    if (char === 0x09 || char === 0x0a || char === 0x0d) continue;
    view += url[k];
    toUrl.push(k);
  }
  const start = urlStart(view);
  const end = urlEnd(view);
  if (start >= end) return undefined;
  return { url: view.slice(start, end), at: toUrl[start] ?? url.length };
}
