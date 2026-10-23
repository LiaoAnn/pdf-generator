// A pack is self-contained: every file its template and stylesheets load is
// in the pack, and every @font-face family is used (Paged.js downloads every
// declared face before it paginates; T03 Must 8). A reference resolves
// against the file containing it, as in a browser loading the pack's files at
// their pack paths.
import {
  cssReferences,
  fontFaces,
  type Reference,
  usedFamilies,
} from './css.ts';
import { attributeOf, type Html, type TemplateHtml } from './html.ts';
import type { PackIssue } from './issues.ts';
import { position } from './text.ts';

/** Attributes that make the browser load a URL, by element. */
const loaders: Record<string, string[]> = {
  img: ['src', 'srcset'],
  source: ['src', 'srcset'],
  video: ['src', 'poster'],
  audio: ['src'],
  iframe: ['src'],
  embed: ['src'],
  script: ['src'],
  input: ['src'],
  object: ['data'],
  link: ['href'],
  image: ['href', 'xlink:href'],
  use: ['href', 'xlink:href'],
};

/** A text file of the pack: the template or a stylesheet. */
type Source = { file: string; text: string };

/** Where `url`, relative to `file`, points in the pack; or what's wrong. */
function resolve(
  file: string,
  url: string,
): { path: string } | { code: string; message: string } | undefined {
  if (url === '' || url.startsWith('#') || url.includes('{{')) return;
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

/** Asset and font issues of a pack's template and stylesheets. */
export function assetIssues(
  template: Source & { html: TemplateHtml },
  styles: Source[],
  exists: (path: string) => boolean,
): PackIssue[] {
  const issues: PackIssue[] = [];
  const faces: (Source & { family: string; name: string; offset: number })[] =
    [];
  const families = new Set<string>();
  const shorthandFirsts: string[] = [];

  const reference = ({ file, text }: Source, { url, offset }: Reference) => {
    const trimmed = url.trimStart();
    const problem = resolve(file, trimmed.trimEnd());
    const at = position(text, offset + url.length - trimmed.length);
    if (problem === undefined) return;
    if ('path' in problem) {
      if (!exists(problem.path)) {
        issues.push({
          code: 'asset-missing',
          file,
          ...at,
          message: `${url} points to ${problem.path}, which is not in the pack`,
        });
      }
      return;
    }
    issues.push({ ...problem, file, ...at });
  };
  /** CSS found at `start` in `source`: a stylesheet or a style element. */
  const css = (source: Source, css: string, start: number, rules: boolean) => {
    for (const ref of cssReferences(css)) {
      reference(source, { url: ref.url, offset: start + ref.offset });
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
      for (const name of loaders[element.tagName] ?? []) {
        const attr = attributeOf(element, name);
        const at = attrAt(name);
        if (attr === undefined || at === undefined) continue;
        const start = valueStart(at);
        const urls =
          name === 'srcset'
            ? srcsetUrls(attr.value)
            : [{ url: attr.value, offset: 0 }];
        for (const { url, offset } of urls) {
          reference(template, { url, offset: start + offset });
        }
      }
      const style = attributeOf(element, 'style');
      const styleAt = attrAt('style');
      if (style !== undefined && styleAt !== undefined) {
        css(template, style.value, valueStart(styleAt), false);
      }
      if (element.tagName === 'style') {
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
      visit(element);
    }
  };
  visit(document);
  for (const style of styles) css(style, style.text, 0, true);

  for (const face of faces) {
    const used =
      families.has(face.family) ||
      shorthandFirsts.some(
        first => first === face.family || first.endsWith(` ${face.family}`),
      );
    if (!used) {
      issues.push({
        code: 'font-unused',
        file: face.file,
        ...position(face.text, face.offset),
        message: `@font-face "${face.name}" is declared but no font-family or font uses it; Paged.js would download it anyway`,
      });
    }
  }
  return issues;
}
