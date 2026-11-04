// T06-13: every .svg file of the pack, referenced or not, prints as an
// image (<img>, CSS url(), SVG <image>), and inside that image Chrome
// reads the file as XML — character references, SMIL <set>, prefixed
// elements and CDATA all take effect, while scripts and nested file loads
// do nothing. A repeat/reflect spreadMethod or a CSS repeating gradient
// inside the file prints as a PDF shading that pdf.js — the self-check's
// renderer — misreads, so checkPack reads every .svg file here, as XML
// (parse5 would read HTML, not what Chrome sees in the image).
//
// Inside the image Chrome also reads a nested data:image/svg+xml image (the
// same way, so this reads it recursively, nesting bounded) and applies a
// data: stylesheet (<?xml-stylesheet?>, @import, XHTML <link> — refused as
// asset-data), while it loads no other URL: every other URL in the file
// prints nothing (the T06-16 probes: 21 cases of nested <image>/<feImage>/
// <use>/XHTML <img>, plus stylesheets and CSS url()/@font-face urls, all
// blank and never fetched), so every non-data:, non-#id reference is
// refused as asset-svg-nested (an <a> href and a <script>'s attributes
// load nothing to refuse). Issues found inside a nested image are
// reported once, at the data: URL as written in this file.
//
// One iterative pass over the text: no recursion over element depth, and
// every scan for a terminator (-->, ]]>, ?>, a quote, >) resumes where it
// stopped or jumps to the end when the terminator is missing, so crafted
// inputs stay linear (svg-assets.test.ts times those against plain markup).
// Recursion is over data: nesting only, bounded at maxSvgNesting, and each
// level's text is no longer than the URL that carried it, so the total work
// stays linear in the file size.

import { scanCss } from './css.ts';
import { dataImageSvgText } from './data-url.ts';
import { repeatingGradients } from './gradients.ts';
import type { CheckIssue, PackIssueCode } from './issues.ts';
import {
  cssEscapeMessage,
  dynamicAssetMessage,
  repeatingGradientMessage,
  spreadMethodMessage,
  svgNestedRefMessage,
} from './messages.ts';
import { decode, position } from './text.ts';
import { srcsetUrls, urlParserView } from './urls.ts';

/** XML whitespace (spaces, tabs and newlines). */
const ws = (char: string | undefined) =>
  char === ' ' || char === '\t' || char === '\n' || char === '\r';

/** The name without its namespace prefix, lowercase for comparison. */
const localName = (name: string) =>
  name.slice(name.lastIndexOf(':') + 1).toLowerCase();

/** The named references XML defines; every other name stays as written. */
const namedEntity: Record<string, string> = {
  amp: '&',
  apos: "'",
  gt: '>',
  lt: '<',
  quot: '"',
};

/**
 * `raw` (which starts at `base` in the file) with its character references
 * decoded, as the XML parser sees the text: &lt; &gt; &amp; &quot; &apos;
 * and &#N; / &#xH;, unknown named references left as written. `rawOf` maps
 * every UTF-16 unit of the result back to the offset of its `&` or single
 * character in the file, so an issue in the decoded text points at where
 * the token is written.
 */
function decodeEntities(
  raw: string,
  base: number,
): { decoded: string; rawOf: number[] } {
  const rawOf: number[] = [];
  let decoded = '';
  const push = (chunk: string, at: number) => {
    decoded += chunk;
    for (let k = 0; k < chunk.length; k++) rawOf.push(at);
  };
  let i = 0;
  while (i < raw.length) {
    if (raw[i] !== '&') {
      push(raw[i] ?? '', base + i);
      i++;
      continue;
    }
    // A reference: a name or #digits up to `;`. The scan stops at the first
    // other character (an `&` among them), so each character is scanned from
    // one `&` at most and the pass stays linear without a length cap: XML
    // allows any number of leading zeros (&#0000114;).
    let semi = -1;
    for (let j = i + 1; j < raw.length; j++) {
      const c = raw.charCodeAt(j);
      if (c === 0x3b) {
        semi = j;
        break;
      }
      // name characters, # and x only; anything else is not a reference
      if (
        !(
          (c >= 0x30 && c <= 0x39) ||
          (c >= 0x41 && c <= 0x5a) ||
          (c >= 0x61 && c <= 0x7a) ||
          c === 0x23
        )
      ) {
        break;
      }
    }
    if (semi > 0) {
      const name = raw.slice(i + 1, semi);
      let value = namedEntity[name];
      if (value === undefined && name.startsWith('#')) {
        const hex = name[1] === 'x' || name[1] === 'X';
        const digits = name.slice(hex ? 2 : 1);
        let point = 0;
        let valid = digits.length > 0;
        for (const char of digits) {
          const c = char.charCodeAt(0);
          const digit =
            c >= 0x30 && c <= 0x39
              ? c - 0x30
              : hex && c >= 0x41 && c <= 0x46
                ? c - 0x41 + 10
                : hex && c >= 0x61 && c <= 0x66
                  ? c - 0x61 + 10
                  : -1;
          if (digit < 0 || (!hex && digit > 9)) {
            valid = false;
            break;
          }
          // Capped: past 0x10FFFF it is invalid anyway, and a long run of
          // digits must not lose precision on the way.
          point = Math.min(point * (hex ? 16 : 10) + digit, 0x110000);
        }
        if (valid) {
          value = point > 0x10ffff ? '�' : String.fromCodePoint(point);
        }
      }
      if (value !== undefined) {
        push(value, base + i);
        i = semi + 1;
        continue;
      }
    }
    // An unknown named reference (and every other &) stays as written.
    push('&', base + i);
    i++;
  }
  return { decoded, rawOf };
}

/** One attribute of a start tag, once the tag has been read. */
type Attribute = {
  /** Whether the name has a namespace prefix (`xlink:href`). */
  prefixed: boolean;
  /** The name as written, without a prefix. */
  local: string;
  /** The value with character references decoded (tab/LF/CR count). */
  value: string;
  /** rawOf of decodeEntities: file offsets per unit of `value`. */
  rawOf: number[];
  /** The file offset of the attribute name. */
  nameStart: number;
};

/** What an open element is to the reader. */
type Open = {
  style: boolean;
  /** The <style> text so far, when `style`: chunks and their file offsets. */
  css: string[];
  map: number[];
};

/**
 * How readText hands an issue up: on level 0 the file's own line and
 * column, on deeper levels re-located to the data: URL that carried the
 * text (see checkUrl), so everything lands in the file itself.
 */
type Report = (
  code: PackIssueCode,
  at: number | undefined,
  message: string,
) => void;

/** Levels of nested data:image/svg+xml images read; level 0 is the file. */
const maxSvgNesting = 8;

/**
 * Where `text` names an encoding in its XML declaration: refused unless it
 * is UTF-8. Chrome reads an SVG image by its BOM and declaration, so a
 * UTF-16 declaration still prints; the check asks for the file as written.
 */
function declaredEncodingIssues(report: Report, text: string): void {
  if (!text.startsWith('<?xml')) return;
  const end = text.indexOf('?>', 5);
  const decl = text.slice(5, end < 0 ? text.length : end);
  let i = decl.indexOf('encoding');
  if (i < 0) return;
  i += 'encoding'.length;
  while (ws(decl[i])) i++;
  if (decl[i] !== '=') return;
  i++;
  while (ws(decl[i])) i++;
  const quote = decl[i];
  if (quote !== '"' && quote !== "'") return;
  const close = decl.indexOf(quote, i + 1);
  const value = decl.slice(i + 1, close < 0 ? decl.length : close).trim();
  if (!/^utf-8$/i.test(value)) {
    report(
      'text-encoding',
      undefined,
      `its XML declaration names encoding "${value}": save the file as UTF-8`,
    );
  }
}

/**
 * A DOCTYPE with an internal subset: Chrome applies its entity and
 * attribute defaults, which this check cannot read. `text[at]` is the `<`
 * of `<!DOCTYPE`; returns the index after `>`, quoted strings read
 * correctly.
 */
function doctype(report: Report, text: string, at: number): number {
  const n = text.length;
  let i = at + '<!DOCTYPE'.length;
  while (i < n) {
    const c = text[i];
    if (c === '"' || c === "'") {
      const end = text.indexOf(c, i + 1);
      i = end < 0 ? n : end + 1;
      continue;
    }
    if (c === '>') return i + 1;
    if (c === '[') break;
    i++;
  }
  if (i >= n) return n;
  report(
    'html-unsupported',
    at,
    "an SVG file's DOCTYPE may not have an internal subset (the […] part): Chrome applies its entity and attribute declarations, which this check does not read; delete the […] part",
  );
  const close = text.indexOf(']', i + 1);
  if (close < 0) return n;
  const end = text.indexOf('>', close + 1);
  return end < 0 ? n : end + 1;
}

/**
 * The issues of one SVG file, located in it by line and column of the raw
 * text: spreadMethod, SMIL setters of it, CSS in <style> and in attributes,
 * nested data:image/svg+xml images and data: stylesheets, the DOCTYPE, and
 * the file's encoding.
 */
export function svgIssues(file: string, bytes: Uint8Array): CheckIssue[] {
  const issues: CheckIssue[] = [];
  const text = decode(bytes);
  if (text === undefined) {
    // An undecodable file (UTF-16 says its BOM and declaration) still
    // prints in Chrome, but the check reads UTF-8 packs — report only this.
    issues.push({
      code: 'text-encoding',
      file,
      message: 'not valid UTF-8 text',
    });
    return issues;
  }
  const report: Report = (code, at, message) =>
    issues.push({
      code,
      file,
      ...(at === undefined ? {} : position(text, at)),
      message,
    });
  readText(report, text, 0);
  return issues;
}

/**
 * What readText finds in a data:image/svg+xml image decoded to `text`,
 * nested at `level` (1 under a file or the template, deeper inside another
 * image), each message prefixed to name the image and carrying no position:
 * the caller reports them all at the URL as written. svg.ts's checkUrl and
 * assets.ts's reference() use it; the 8-level bound still applies inside.
 */
export function dataSvgTextIssues(
  text: string,
  level: number,
): { code: PackIssueCode; message: string }[] {
  const issues: { code: PackIssueCode; message: string }[] = [];
  readText(
    (code, _at, message) =>
      issues.push({
        code,
        message: `in the data:image/svg+xml image here: ${message}`,
      }),
    text,
    level,
  );
  return issues;
}

/**
 * Read one SVG document's text (the file itself at level 0, a decoded data:
 * image deeper), reporting each issue through `report` as readText sees it.
 */
function readText(report: Report, text: string, level: number): void {
  const n = text.length;
  if (text.includes('\0')) {
    report(
      'text-encoding',
      undefined,
      'contains a NUL character: another encoding read as UTF-8? Save the file as UTF-8',
    );
  } else {
    declaredEncodingIssues(report, text);
  }
  const issue = report;

  /**
   * A URL found inside this SVG text — an <image>/<img> href or src, a
   * srcset candidate, or a CSS url() / image-set() string / @import — as
   * the URL parser sees it: tab, LF and CR dropped anywhere, C0 controls
   * and spaces trimmed at the ends. `stylesheet` is an @import, <link> or
   * <?xml-stylesheet?> URL. An SVG image loads no other URL: `nestedRef`
   * — true everywhere a load could be attempted (every call but an <a>
   * href/src and a <script>'s, which never load) — refuses every
   * non-data:, non-#id URL (it prints nothing), a nested data: image is
   * read recursively, a data: stylesheet refused. `rawAt` maps an
   * offset in `url` to one in `text`.
   */
  const checkUrl = (
    url: string,
    kind: 'image' | 'stylesheet',
    rawAt: (offset: number) => number,
    nestedRef = false,
  ) => {
    const view = urlParserView(url);
    if (view === undefined) return;
    const parsed = view.url;
    // The first character kept after trimming, where the issue points.
    const at = rawAt(view.at);
    // A URL an image element would load: an SVG image loads no other file
    // or URL (T06-16 probe), so it prints nothing. data: loads (a nested
    // image below, a real image as is); a same-document #id is fine.
    if (
      nestedRef &&
      parsed.slice(0, 5).toLowerCase() !== 'data:' &&
      !parsed.startsWith('#')
    ) {
      // An <image> href, a CSS url()/@import, an xml-stylesheet PI or a
      // <link> href alike: the probe (T06-16) shows no fetch for any.
      issue('asset-svg-nested', at, svgNestedRefMessage(parsed));
      return;
    }
    if (kind === 'stylesheet') {
      if (parsed.slice(0, 5).toLowerCase() === 'data:') {
        issue(
          'asset-data',
          at,
          "a stylesheet in an SVG image may not be a data: URL: put its rules in the SVG's <style> element",
        );
      }
      return;
    }
    const data = dataImageSvgText(parsed);
    if (data === undefined) return;
    if ('encoding' in data) {
      issue(
        'text-encoding',
        at,
        `in the data:image/svg+xml image here: ${data.encoding}`,
      );
      return;
    }
    if (level >= maxSvgNesting) {
      issue(
        'pack-too-complex',
        at,
        `data:image/svg+xml images nested more than ${maxSvgNesting} deep: the check reads at most ${maxSvgNesting} levels; draw the inner image's shapes in the image around it (an SVG image loads no pack file)`,
      );
      return;
    }
    // Every issue inside is reported once, re-located to this URL (and a
    // deeper level's URL re-locates again to the outermost one).
    for (const found of dataSvgTextIssues(data.text, level + 1)) {
      issue(found.code, at, found.message);
    }
  };

  /** The CSS checks shared with a template's attribute CSS (assets.ts). */
  const checkCss = (css: string, map: number[]) => {
    const at = (offset: number) => map[offset] ?? n;
    for (const offset of repeatingGradients(css)) {
      issue('css-repeating-gradient', at(offset), repeatingGradientMessage);
    }
    const { references, escapes, dynamic } = scanCss(css);
    for (const offset of escapes) {
      issue('css-escape', at(offset), cssEscapeMessage);
    }
    for (const offset of dynamic) {
      issue('asset-dynamic', at(offset), dynamicAssetMessage);
    }
    for (const reference of references) {
      checkUrl(
        reference.url,
        reference.kind === 'stylesheet' ? 'stylesheet' : 'image',
        offset => at(reference.offset + offset),
        true,
      );
    }
  };

  /**
   * The pseudo-attributes of an xml-stylesheet processing instruction
   * ([j, stop), before the ?>): inside an SVG image its stylesheet never
   * loads, so the href is refused (a data: one as asset-data, which Chrome
   * applies). Located in the raw text: a PI has no character references.
   */
  const stylesheetPi = (j: number, stop: number) => {
    while (j < stop) {
      while (j < stop && ws(text[j])) j++;
      if (j >= stop || text[j] === '?') break;
      const nameStart = j;
      while (
        j < stop &&
        !ws(text[j]) &&
        text[j] !== '=' &&
        text[j] !== '?' &&
        text[j] !== '/'
      ) {
        j++;
      }
      const name = text.slice(nameStart, j).toLowerCase();
      while (j < stop && ws(text[j])) j++;
      if (text[j] !== '=') {
        j++;
        continue;
      }
      j++;
      while (j < stop && ws(text[j])) j++;
      const quote = text[j];
      if (quote !== '"' && quote !== "'") {
        j++;
        continue;
      }
      const close = text.indexOf(quote, j + 1);
      const vend = close < 0 || close > stop ? stop : close;
      if (name === 'href') {
        // Chrome decodes character references in pseudo-attribute values
        // (&#100;ata: is data:), as in an attribute.
        const href = decodeEntities(text.slice(j + 1, vend), j + 1);
        checkUrl(
          href.decoded,
          'stylesheet',
          offset => href.rawOf[offset] ?? n,
          true,
        );
      }
      j = vend + 1;
    }
  };

  /** The open elements, innermost last; a 16,000-deep file must not recurse. */
  const stack: Open[] = [];

  /** A text or CDATA chunk [start, end): read only as <style> content. */
  const chunk = (start: number, end: number, cdata: boolean) => {
    const open = stack.at(-1);
    if (open === undefined || !open.style) return;
    const raw = text.slice(start, end);
    if (cdata) {
      open.css.push(raw);
      for (let k = 0; k < raw.length; k++) open.map.push(start + k);
    } else {
      const decoded = decodeEntities(raw, start);
      open.css.push(decoded.decoded);
      for (const at of decoded.rawOf) open.map.push(at);
    }
  };

  /** A start tag's attributes and the checks it may raise. */
  const startTag = (lt: number): number => {
    let i = lt + 1;
    while (i < n && !ws(text[i]) && text[i] !== '/' && text[i] !== '>') i++;
    const local = localName(text.slice(lt + 1, i));
    const attrs: Attribute[] = [];
    let closed = false;
    while (i < n) {
      while (i < n && ws(text[i])) i++;
      if (i >= n) break;
      const c = text[i];
      if (c === '>') {
        i++;
        break;
      }
      if (c === '/') {
        // A self-closing tag opens nothing, so nothing goes on the stack.
        if (text[i + 1] === '>') {
          i += 2;
          closed = true;
          break;
        }
        i++;
        continue;
      }
      const nameStart = i;
      while (
        i < n &&
        !ws(text[i]) &&
        text[i] !== '=' &&
        text[i] !== '/' &&
        text[i] !== '>'
      ) {
        i++;
      }
      const name = text.slice(nameStart, i);
      while (i < n && ws(text[i])) i++;
      let value = '';
      let rawOf: number[] = [];
      if (text[i] === '=') {
        i++;
        while (i < n && ws(text[i])) i++;
        const quote = text[i];
        // XML reads a literal tab, LF or CR in an attribute value as a
        // space; a character reference (&#9; …) is normalized BEFORE it, so
        // it keeps its character. Same length, so the offsets still map.
        if (quote === '"' || quote === "'") {
          const end = text.indexOf(quote, i + 1);
          const raw = end < 0 ? text.slice(i + 1) : text.slice(i + 1, end);
          const decoded = decodeEntities(raw.replace(/[\t\n\r]/g, ' '), i + 1);
          value = decoded.decoded;
          rawOf = decoded.rawOf;
          i = end < 0 ? n : end + 1;
        } else {
          // An unquoted value is not well-formed; read to the delimiter.
          const start = i;
          while (i < n && !ws(text[i]) && text[i] !== '>') i++;
          const decoded = decodeEntities(
            text.slice(start, i).replace(/[\t\n\r]/g, ' '),
            start,
          );
          value = decoded.decoded;
          rawOf = decoded.rawOf;
        }
      }
      if (name !== '') {
        attrs.push({
          prefixed: name.includes(':'),
          local: localName(name),
          value,
          rawOf,
          nameStart,
        });
      }
    }
    // T06-12's rule, in the file Chrome prints: repeat and reflect on a
    // gradient print as a shading the self-check misreads.
    let spread: Attribute | undefined;
    let setter: Attribute | undefined;
    let repeats = false;
    for (const attr of attrs) {
      if (attr.local === 'spreadmethod') spread ??= attr;
      if (attr.local === 'attributename') setter ??= attr;
      if (
        (attr.local === 'to' ||
          attr.local === 'from' ||
          attr.local === 'by' ||
          attr.local === 'values') &&
        /repeat|reflect/i.test(attr.value)
      ) {
        repeats = true;
      }
    }
    if (
      spread !== undefined &&
      (local === 'lineargradient' || local === 'radialgradient') &&
      /^[\t\n\f\r ]*(?:repeat|reflect)[\t\n\f\r ]*$/i.test(spread.value)
    ) {
      issue('css-repeating-gradient', spread.nameStart, spreadMethodMessage);
    }
    // SMIL: <set attributeName="spreadMethod" to="repeat"> and friends make
    // the gradient repeat when the image renders (T06-13 probe).
    if (
      setter !== undefined &&
      setter.value.trim().toLowerCase() === 'spreadmethod' &&
      repeats
    ) {
      issue('css-repeating-gradient', lt, spreadMethodMessage);
    }
    // Every attribute value a stylesheet context could carry: the style
    // attribute of foreignObject HTML, SVG presentation attributes, … But a
    // URL attribute (an <image>'s href, any prefix; xlink:href too) is a
    // URL the image loads instead: only data: does anything there.
    for (const attr of attrs) {
      const rawAt = (offset: number) => attr.rawOf[offset] ?? n;
      if (attr.local === 'href' || attr.local === 'src') {
        // Not <a> (its href is a hyperlink, never a load) or <script> (it
        // never runs): in every other case the attribute would load, a
        // <link>'s stylesheet included, and inside an SVG image that load
        // never happens (T06-16 probe).
        const nestedRef = local !== 'a' && local !== 'script';
        checkUrl(
          attr.value,
          local === 'link' ? 'stylesheet' : 'image',
          rawAt,
          nestedRef,
        );
        continue;
      }
      if (attr.local === 'srcset') {
        for (const reference of srcsetUrls(attr.value)) {
          checkUrl(
            reference.url,
            'image',
            offset => rawAt(reference.offset + offset),
            true,
          );
        }
        continue;
      }
      // A prefixed attribute (inkscape:export-filename="C:\…") is never
      // CSS to Chrome: style and presentation attributes have no namespace.
      if (!attr.prefixed) checkCss(attr.value, attr.rawOf);
    }
    if (!closed) {
      stack.push({ style: local === 'style', css: [], map: [] });
    }
    return i;
  };

  /** An end tag read far enough to ignore; pops one open element. */
  const endTag = (lt: number): number => {
    let i = lt + 2;
    while (i < n && !ws(text[i]) && text[i] !== '>') i++;
    const open = stack.pop();
    if (open?.style === true) checkCss(open.css.join(''), open.map);
    const end = text.indexOf('>', i);
    return end < 0 ? n : end + 1;
  };

  let i = 0;
  while (i < n) {
    const lt = text.indexOf('<', i);
    if (lt < 0) {
      chunk(i, n, false);
      break;
    }
    if (lt > i) chunk(i, lt, false);
    const c = text.charCodeAt(lt + 1);
    if (c === 0x21) {
      // ! — comment, CDATA, DOCTYPE, or another declaration.
      if (text.startsWith('<!--', lt)) {
        const end = text.indexOf('-->', lt + 4);
        i = end < 0 ? n : end + 3;
      } else if (text.startsWith('<![CDATA[', lt)) {
        const end = text.indexOf(']]>', lt + 9);
        chunk(lt + 9, end < 0 ? n : end, true);
        i = end < 0 ? n : end + 3;
      } else if (text.slice(lt + 2, lt + 9).toLowerCase() === 'doctype') {
        i = doctype(report, text, lt);
      } else {
        const end = text.indexOf('>', lt + 2);
        i = end < 0 ? n : end + 1;
      }
    } else if (c === 0x3f) {
      // ? — a processing instruction; the declaration was read up front.
      // <?xml-stylesheet href="…"?> loads a stylesheet in an SVG image.
      const end = text.indexOf('?>', lt + 2);
      const stop = end < 0 ? n : end;
      if (
        text.startsWith('xml-stylesheet', lt + 2) &&
        (lt + 16 >= stop || text[lt + 16] === '?' || ws(text[lt + 16]))
      ) {
        stylesheetPi(lt + 16, stop);
      }
      i = end < 0 ? n : end + 2;
    } else if (c === 0x2f) {
      // / — an end tag.
      i = endTag(lt);
    } else {
      i = startTag(lt);
    }
  }
  // Not well-formed: elements still open at the end. Report what a <style>
  // gathered anyway; read on as best as one can rather than throwing.
  for (const open of stack) {
    if (open.style) checkCss(open.css.join(''), open.map);
  }
}
