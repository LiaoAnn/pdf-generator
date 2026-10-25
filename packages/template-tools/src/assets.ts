// A pack is self-contained: every file its template and stylesheets load is
// in the pack, and every @font-face family is used (Paged.js downloads every
// declared face before it paginates; T03 Must 8). A reference resolves
// against the file containing it, as in a browser loading the pack's files at
// their pack paths.
import {
  type FaceKind,
  fontFaces,
  fontRequests,
  type Reference,
  scanCss,
  usedFamilies,
} from './css.ts';
import {
  attributeOf,
  decodedOffsets,
  type Html,
  type TemplateHtml,
} from './html.ts';
import type { PackIssue } from './issues.ts';
import { pageBoxProblems } from './page-box.ts';
import { isRefused } from './policy.ts';
import { decode, position } from './text.ts';

/**
 * Attributes that make the browser load a URL, by element, among the
 * elements the allowlist (policy.ts) admits.
 */
const loaders = new Map<string, string[]>([
  ['img', ['src', 'srcset']],
  ['source', ['srcset']],
  ['link', ['href']],
  ['image', ['href', 'xlink:href']],
]);

/** A text file of the pack: the template or a stylesheet. */
type Source = { file: string; text: string };

/** Where `url`, relative to `file`, points in the pack; or what's wrong. */
function resolve(
  file: string,
  url: string,
): { path: string } | { code: string; message: string } | undefined {
  if (url === '' || url.startsWith('#')) return;
  if (/^data:/i.test(url)) return;
  if (/^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith('//')) {
    return {
      code: 'asset-external',
      message: `${url} is outside the pack: put the file in the pack and list it in manifest.json files.assets`,
    };
  }
  let path = url.split(/[?#]/)[0] ?? '';
  try {
    path = decodeURIComponent(path);
  } catch {
    // A stray % stays as written.
  }
  const outside = {
    code: 'asset-path',
    message: `${url} must be a path relative to ${file}, inside the pack`,
  };
  if (path.startsWith('/')) return outside;
  const segments = file.split('/').slice(0, -1);
  for (const segment of path.split('/')) {
    if (segment === '..') {
      if (segments.pop() === undefined) return outside;
    } else if (segment !== '.' && segment !== '') segments.push(segment);
  }
  return { path: segments.join('/') };
}

/**
 * Where a URL starts and ends once the browser's URL parser has stripped the
 * C0 controls and spaces around it; it keeps the no-break space and other
 * Unicode spaces, which then name a file that isn't in the pack.
 */
const urlStart = (url: string) => {
  let i = 0;
  while (i < url.length && url.charCodeAt(i) <= 0x20) i++;
  return i;
};
const urlEnd = (url: string) => {
  let i = url.length;
  while (i > 0 && url.charCodeAt(i - 1) <= 0x20) i--;
  return i;
};

/**
 * The candidate URLs of a srcset, with their offsets in it, as the HTML spec
 * splits them: a URL runs to the next whitespace (commas included, so data:
 * URLs survive), then a descriptor runs to the next comma.
 */
function srcsetUrls(value: string): Reference[] {
  const urls: Reference[] = [];
  let i = 0;
  while (i < value.length) {
    while (i < value.length && /[\t\n\f\r ,]/.test(value[i] ?? '')) i++;
    const start = i;
    while (i < value.length && !/[\t\n\f\r ]/.test(value[i] ?? '')) i++;
    let url = value.slice(start, i);
    if (url.endsWith(',')) url = url.replace(/,+$/, '');
    else while (i < value.length && value[i] !== ',') i++;
    if (url !== '') urls.push({ url, offset: start });
  }
  return urls;
}

/** Elements the browser prints bold, or italic, by default. */
const boldElements = new Set([
  'b',
  'strong',
  'th',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
]);
const slantedElements = new Set(['i', 'em', 'cite', 'var', 'dfn', 'address']);

/** Asset, font and active-content issues of a pack's template and styles. */
export function assetIssues(
  template: Source & { html: TemplateHtml },
  styles: Source[],
  read: (path: string) => Uint8Array | undefined,
): PackIssue[] {
  const issues: PackIssue[] = [];
  const faces: (Source &
    FaceKind & { family: string; name: string; offset: number })[] = [];
  /** Whether anything asks for a bold or an italic face. */
  const requests = { bold: false, slanted: false };
  const request = (asked: { bold: boolean; slanted: boolean }) => {
    requests.bold ||= asked.bold;
    requests.slanted ||= asked.slanted;
  };
  const families = new Set<string>();
  const shorthandFirsts: string[] = [];
  /** Stylesheets checked or queued, so each is read once (imports cycle). */
  const sheets = new Set(styles.map(style => style.file));
  const reached: string[] = [];

  const issue = (
    code: string,
    source: Source,
    offset: number,
    message: string,
  ) =>
    issues.push({
      code,
      file: source.file,
      ...position(source.text, offset),
      message,
    });

  /**
   * A URL found in `source`: in an HTML attribute, in CSS, or one that loads
   * a stylesheet (`<link href>`, `@import`), where data: would hide what the
   * stylesheet loads in turn.
   */
  const reference = (
    source: Source,
    { url, offset, kind }: Reference,
    context: 'attribute' | 'css' = 'css',
  ) => {
    const trimmed = url.slice(urlStart(url));
    const at = offset + url.length - trimmed.length;
    if (source === template && url.includes('{{')) {
      // In CSS a statement is a template-structure issue already.
      if (context === 'attribute') {
        issue(
          'asset-dynamic',
          source,
          at,
          `${url} depends on the data: write the path out, and pick between paths with {{#if}}`,
        );
      }
      return;
    }
    if (kind === 'stylesheet' && /^data:/i.test(trimmed)) {
      issue(
        'asset-data',
        source,
        at,
        'a stylesheet may not be a data: URL: put it in the pack as a .css file',
      );
      return;
    }
    const problem = resolve(source.file, trimmed.slice(0, urlEnd(trimmed)));
    if (problem === undefined) return;
    if (!('path' in problem)) {
      issue(problem.code, source, at, problem.message);
    } else if (read(problem.path) === undefined) {
      issue(
        'asset-missing',
        source,
        at,
        `${url} points to ${problem.path}, which is not in the pack`,
      );
    } else if (
      (kind === 'stylesheet' || /\.css$/i.test(problem.path)) &&
      !sheets.has(problem.path)
    ) {
      sheets.add(problem.path);
      reached.push(problem.path);
    }
  };
  /**
   * CSS found in `source`; `at` turns an offset in `css` into one in the
   * source (they differ in attribute values, which are entity-decoded).
   */
  const css = (
    source: Source,
    css: string,
    at: (offset: number) => number,
    rules: boolean,
  ) => {
    const { references, escapes, dynamic } = scanCss(css);
    for (const offset of dynamic) {
      issue(
        'asset-dynamic',
        source,
        at(offset),
        'image-set() takes only url(), strings, type() and gradients: another function here (var(), if(), a custom function …) can supply a URL this check cannot see',
      );
    }
    for (const ref of references) {
      reference(source, { ...ref, offset: at(ref.offset) });
    }
    for (const offset of escapes) {
      issue(
        'css-escape',
        source,
        at(offset),
        'a backslash escape in CSS: write the character itself (packs are UTF-8)',
      );
    }
    if (rules) {
      for (const problem of pageBoxProblems(css)) {
        issue('css-page-box', source, at(problem.offset), problem.message);
      }
      for (const face of fontFaces(css)) {
        faces.push({ ...source, ...face, offset: at(face.offset) });
      }
    }
    const used = usedFamilies(css);
    for (const family of used.families) families.add(family);
    request(fontRequests(css));
    shorthandFirsts.push(...used.shorthandFirsts);
  };

  const { html, document } = template.html;
  /**
   * Maps an offset in an attribute's value as parse5 decoded it (entities,
   * CR LF → LF) to an offset in the template.
   */
  const valueAt = (
    location: { startOffset: number; endOffset: number },
    decoded: string,
  ) => {
    const attr = html.slice(location.startOffset, location.endOffset);
    const equals = attr.indexOf('=');
    const quote = /^\s*["']?/.exec(attr.slice(equals + 1))?.[0] ?? '';
    const start = location.startOffset + equals + 1 + quote.length;
    const raw = html.slice(
      start,
      location.endOffset - (/["']$/.test(quote) ? 1 : 0),
    );
    const map = decodedOffsets(raw);
    return map.decoded === decoded
      ? (offset: number) => start + (map.raw[offset] ?? raw.length)
      : (offset: number) => start + offset;
  };
  const visit = (node: Html.ParentNode) => {
    for (const child of node.childNodes) {
      if (!('tagName' in child)) continue;
      const element = child as Html.Element;
      const location = element.sourceCodeLocation;
      const attrAt = (name: string) =>
        location?.attrs?.[name] ??
        location?.attrs?.[name.split(':').pop() ?? ''];
      const tag = element.tagName;
      // The allowlist reports these; nothing inside them is loaded.
      if (isRefused(element)) continue;
      for (const name of loaders.get(tag) ?? []) {
        const attr = attributeOf(element, name);
        const at = attrAt(name);
        if (attr === undefined || at === undefined) continue;
        const start = valueAt(at, attr.value);
        // Any data in a srcset, descriptors included, can carry a URL.
        const dynamicAt = attr.value.indexOf('{{');
        if (name === 'srcset' && dynamicAt >= 0) {
          issue(
            'asset-dynamic',
            template,
            start(dynamicAt),
            'a srcset may not depend on the data: write it out',
          );
          continue;
        }
        const urls =
          name === 'srcset'
            ? srcsetUrls(attr.value)
            : [{ url: attr.value, offset: 0 }];
        const kind = tag === 'link' ? 'stylesheet' : undefined;
        for (const { url, offset } of urls) {
          reference(
            template,
            { url, offset: start(offset), kind },
            'attribute',
          );
        }
      }
      // A link loads nothing when printed, but a data-driven one is still a
      // URL the data chooses.
      const link = tag === 'a' ? attributeOf(element, 'href') : undefined;
      const linkAt = attrAt('href');
      if (link?.value.includes('{{') && linkAt) {
        issue(
          'asset-dynamic',
          template,
          valueAt(linkAt, link.value)(0),
          `${link.value} depends on the data: write the link out`,
        );
      }
      request({
        bold: boldElements.has(tag),
        slanted: slantedElements.has(tag),
      });
      // SVG presentation attributes take url() too (fill, mask, clip-path…).
      if (element.namespaceURI === 'http://www.w3.org/2000/svg') {
        for (const attr of element.attrs) {
          if (attr.name === 'font-weight' || attr.name === 'font-style') {
            request(fontRequests(`${attr.name}:${attr.value}`));
          }
          const name = attr.prefix ? `${attr.prefix}:${attr.name}` : attr.name;
          const at = attrAt(name);
          if (name === 'style' || name.endsWith('href') || !at) continue;
          css(template, attr.value, valueAt(at, attr.value), false);
        }
      }
      const style = attributeOf(element, 'style');
      const styleAt = attrAt('style');
      if (style !== undefined && styleAt !== undefined) {
        css(template, style.value, valueAt(styleAt, style.value), false);
      }
      const family = attributeOf(element, 'font-family');
      if (family !== undefined) {
        for (const name of usedFamilies(`font-family:${family.value}`)
          .families) {
          families.add(name);
        }
      }
      if (tag === 'style') {
        for (const text of element.childNodes) {
          const at = (text as Html.TextNode).sourceCodeLocation;
          if (text.nodeName !== '#text' || !at) continue;
          css(
            template,
            html.slice(at.startOffset, at.endOffset),
            offset => at.startOffset + offset,
            true,
          );
        }
      }
      visit(tag === 'template' ? (element as Html.Template).content : element);
    }
  };
  visit(document);
  const same = (offset: number) => offset;
  for (const style of styles) css(style, style.text, same, true);
  // Stylesheets reached by <link> or @import, each once.
  for (let path = reached.shift(); path !== undefined; path = reached.shift()) {
    const bytes = read(path);
    const text = bytes && decode(bytes);
    if (text === undefined) {
      issues.push({
        code: 'text-encoding',
        file: path,
        message: 'not valid UTF-8 text',
      });
    } else css({ file: path, text }, text, same, true);
  }

  // The weight and style combinations the pack prints: regular upright
  // always, the others when something asks for them anywhere.
  const kinds = [
    { bold: false, slanted: false },
    ...(requests.bold ? [{ bold: true, slanted: false }] : []),
    ...(requests.slanted ? [{ bold: false, slanted: true }] : []),
    ...(requests.bold && requests.slanted
      ? [{ bold: true, slanted: true }]
      : []),
  ];
  const matches = (face: FaceKind, kind: (typeof kinds)[number]) =>
    (kind.bold ? face.bold : face.regular) && face.slanted === kind.slanted;
  for (const face of faces) {
    const familyUsed =
      families.has(face.family) ||
      shorthandFirsts.some(
        first => first === face.family || first.endsWith(` ${face.family}`),
      );
    // A combination no face of the family matches falls back to whichever
    // face the browser picks, so then every face of the family counts.
    const family = faces.filter(other => other.family === face.family);
    const used =
      familyUsed &&
      kinds.some(
        kind =>
          matches(face, kind) || !family.some(other => matches(other, kind)),
      );
    if (!used) {
      issue(
        'font-unused',
        face,
        face.offset,
        familyUsed
          ? `@font-face "${face.name}" (${face.bold && !face.regular ? 'bold' : 'regular'}${face.slanted ? ' italic' : ''}) is declared but nothing asks for that weight and style; Paged.js would download it anyway`
          : `@font-face "${face.name}" is declared but no font-family or font uses it; Paged.js would download it anyway`,
      );
    }
  }
  return issues;
}
