// A pack is self-contained: every file its template and stylesheets load is
// in the pack, and every @font-face family is used (Paged.js downloads every
// declared face before it paginates; T03 Must 8). A reference resolves
// against the file containing it, as in a browser loading the pack's files at
// their pack paths.
import { fontFaces, type Reference, scanCss, usedFamilies } from './css.ts';
import { attributeOf, type Html, type TemplateHtml } from './html.ts';
import type { PackIssue } from './issues.ts';
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
 * The candidate URLs of a srcset, with their offsets in it, as the HTML spec
 * splits them: a URL runs to the next whitespace (commas included, so data:
 * URLs survive), then a descriptor runs to the next comma.
 */
function srcsetUrls(value: string): Reference[] {
  const urls: Reference[] = [];
  let i = 0;
  while (i < value.length) {
    while (i < value.length && /[\s,]/.test(value[i] ?? '')) i++;
    const start = i;
    while (i < value.length && !/\s/.test(value[i] ?? '')) i++;
    let url = value.slice(start, i);
    if (url.endsWith(',')) url = url.replace(/,+$/, '');
    else while (i < value.length && value[i] !== ',') i++;
    if (url !== '') urls.push({ url, offset: start });
  }
  return urls;
}

/** Asset, font and active-content issues of a pack's template and styles. */
export function assetIssues(
  template: Source & { html: TemplateHtml },
  styles: Source[],
  read: (path: string) => Uint8Array | undefined,
): PackIssue[] {
  const issues: PackIssue[] = [];
  const faces: (Source & { family: string; name: string; offset: number })[] =
    [];
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
    const trimmed = url.trimStart();
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
    const problem = resolve(source.file, trimmed.trimEnd());
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
    } else if (/\.css$/i.test(problem.path) && !sheets.has(problem.path)) {
      sheets.add(problem.path);
      reached.push(problem.path);
    }
  };
  /** CSS found at `start` in `source`: a stylesheet or a style element. */
  const css = (source: Source, css: string, start: number, rules: boolean) => {
    const { references, escapes } = scanCss(css);
    for (const ref of references) {
      reference(source, { ...ref, offset: start + ref.offset });
    }
    for (const offset of escapes) {
      issue(
        'css-escape',
        source,
        start + offset,
        'a backslash escape outside a CSS string: write names out plainly',
      );
    }
    if (rules) {
      for (const face of fontFaces(css)) {
        faces.push({ ...source, ...face, offset: start + face.offset });
      }
    }
    const used = usedFamilies(css);
    for (const family of used.families) families.add(family);
    shorthandFirsts.push(...used.shorthandFirsts);
  };

  const { html, document } = template.html;
  const valueStart = (location: { startOffset: number; endOffset: number }) => {
    const attr = html.slice(location.startOffset, location.endOffset);
    const equals = attr.indexOf('=');
    const quote = /^\s*["']?/.exec(attr.slice(equals + 1))?.[0].length ?? 0;
    return location.startOffset + equals + 1 + quote;
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
        const start = valueStart(at);
        const urls =
          name === 'srcset'
            ? srcsetUrls(attr.value)
            : [{ url: attr.value, offset: 0 }];
        const kind = tag === 'link' ? 'stylesheet' : undefined;
        for (const { url, offset } of urls) {
          reference(
            template,
            { url, offset: start + offset, kind },
            'attribute',
          );
        }
      }
      const style = attributeOf(element, 'style');
      const styleAt = attrAt('style');
      if (style !== undefined && styleAt !== undefined) {
        css(template, style.value, valueStart(styleAt), false);
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
            at.startOffset,
            true,
          );
        }
      }
      visit(tag === 'template' ? (element as Html.Template).content : element);
    }
  };
  visit(document);
  for (const style of styles) css(style, style.text, 0, true);
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
    } else css({ file: path, text }, text, 0, true);
  }

  for (const face of faces) {
    const used =
      families.has(face.family) ||
      shorthandFirsts.some(
        first => first === face.family || first.endsWith(` ${face.family}`),
      );
    if (!used) {
      issue(
        'font-unused',
        face,
        face.offset,
        `@font-face "${face.name}" is declared but no font-family or font uses it; Paged.js would download it anyway`,
      );
    }
  }
  return issues;
}
