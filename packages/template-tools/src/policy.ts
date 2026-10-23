// What HTML a pack may contain: only what a printed document needs, so a
// fixture prints the same way every time and nothing in it runs code or
// fetches from the network. An allowlist, not a list of known tricks; plus
// the rule that Handlebars may not change the HTML or CSS structure, since
// the checks see the template with its Handlebars statements taken out.
import { attributeOf, type Html, type TemplateHtml } from './html.ts';
import type { PackIssue } from './issues.ts';
import { position } from './text.ts';

const svg = 'http://www.w3.org/2000/svg';
const mathml = 'http://www.w3.org/1998/Math/MathML';

const cell = [
  'colspan',
  'rowspan',
  'headers',
  'scope',
  'abbr',
  'align',
  'valign',
  'width',
  'height',
  'nowrap',
];
const plain = (...names: string[]) => names.map(name => [name, []] as const);

/** HTML elements a pack may use, with the attributes each adds to the global ones. */
const htmlElements = new Map<string, readonly string[]>([
  ['html', ['xmlns']],
  ['meta', ['charset', 'name', 'content']],
  ['link', ['rel', 'href', 'type', 'media']],
  ['style', ['media', 'type']],
  ['blockquote', ['cite']],
  ['ol', ['start', 'reversed', 'type']],
  ['li', ['value']],
  [
    'table',
    ['border', 'cellpadding', 'cellspacing', 'width', 'align', 'summary'],
  ],
  ['colgroup', ['span', 'width']],
  ['col', ['span', 'width']],
  ['tr', ['align', 'valign', 'height']],
  ['th', cell],
  ['td', cell],
  ['a', ['href', 'name']],
  ['q', ['cite']],
  ['time', ['datetime']],
  ['del', ['cite', 'datetime']],
  ['ins', ['cite', 'datetime']],
  ['data', ['value']],
  ['label', ['for']],
  ['img', ['src', 'srcset', 'sizes', 'alt', 'width', 'height']],
  ['source', ['srcset', 'sizes', 'type', 'media', 'width', 'height']],
  [
    'input',
    ['type', 'checked', 'name', 'value', 'disabled', 'readonly', 'size'],
  ],
  ['select', ['name', 'disabled', 'multiple', 'size']],
  ['option', ['value', 'selected', 'disabled', 'label']],
  ['optgroup', ['label', 'disabled']],
  ['textarea', ['name', 'rows', 'cols', 'disabled', 'readonly']],
  ...plain(
    'head',
    'body',
    'title',
    'div',
    'span',
    'p',
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
    'header',
    'footer',
    'main',
    'section',
    'article',
    'aside',
    'nav',
    'address',
    'figure',
    'figcaption',
    'pre',
    'code',
    'hr',
    'br',
    'wbr',
    'ul',
    'dl',
    'dt',
    'dd',
    'caption',
    'thead',
    'tbody',
    'tfoot',
    'strong',
    'em',
    'b',
    'i',
    'u',
    's',
    'small',
    'sub',
    'sup',
    'mark',
    'abbr',
    'cite',
    'dfn',
    'kbd',
    'samp',
    'var',
    'bdi',
    'bdo',
    'ruby',
    'rt',
    'rp',
    'picture',
    'template',
    'noscript',
  ),
]);
const globalAttributes = new Set([
  'class',
  'id',
  'style',
  'lang',
  'dir',
  'title',
  'hidden',
  'translate',
  'role',
]);
const inputTypes = new Set(['checkbox', 'radio', 'text']);
/** SVG and MathML elements a pack may use: static drawing and formulas. */
const svgElements = new Set([
  'svg',
  'g',
  'defs',
  'symbol',
  'use',
  'path',
  'rect',
  'circle',
  'ellipse',
  'line',
  'polyline',
  'polygon',
  'text',
  'tspan',
  'textPath',
  'title',
  'desc',
  'linearGradient',
  'radialGradient',
  'stop',
  'clipPath',
  'mask',
  'pattern',
  'image',
  'marker',
]);
const mathElements = new Set([
  'math',
  'semantics',
  'annotation',
  'mrow',
  'mi',
  'mo',
  'mn',
  'ms',
  'mtext',
  'mspace',
  'msup',
  'msub',
  'msubsup',
  'mfrac',
  'msqrt',
  'mroot',
  'mover',
  'munder',
  'munderover',
  'mtable',
  'mtr',
  'mtd',
  'mlabeledtr',
  'mstyle',
  'mpadded',
  'mphantom',
  'menclose',
  'mmultiscripts',
  'mprescripts',
  'none',
]);

const fullName = (attr: Html.Element['attrs'][number]) =>
  attr.prefix ? `${attr.prefix}:${attr.name}` : attr.name;

/** Elements that run code or change where the page loads from. */
function isActive(element: Html.Element): boolean {
  const tag = element.tagName;
  return (
    tag === 'script' ||
    (element.namespaceURI !== svg &&
      element.namespaceURI !== mathml &&
      (tag === 'base' ||
        (tag === 'meta' &&
          attributeOf(element, 'http-equiv')?.value.toLowerCase() ===
            'refresh')))
  );
}

/** Whether an element is refused: no other check looks inside it. */
export function isRefused(element: Html.Element): boolean {
  if (isActive(element)) return true;
  const tag = element.tagName;
  if (element.namespaceURI === svg) return !svgElements.has(tag);
  if (element.namespaceURI === mathml) return !mathElements.has(tag);
  return !htmlElements.has(tag);
}

/** Issues of the allowlist and of Handlebars inside HTML or CSS structure. */
export function policyIssues(
  source: string,
  { html, document, statements }: TemplateHtml,
  file: string,
): PackIssue[] {
  const issues: PackIssue[] = [];
  const report = (code: string, offset: number, message: string) =>
    issues.push({ code, file, ...position(source, offset), message });

  // Ranges Handlebars may not appear in, and the attribute values it may.
  const forbidden: [number, number][] = [];
  const values: [number, number][] = [];

  const visit = (node: Html.ParentNode) => {
    for (const child of node.childNodes) {
      if (child.nodeName === '#comment') {
        const at = (child as Html.CommentNode).sourceCodeLocation;
        if (at) forbidden.push([at.startOffset, at.endOffset]);
        continue;
      }
      if (!('tagName' in child)) continue;
      const element = child as Html.Element;
      const location = element.sourceCodeLocation;
      const tag = element.tagName;
      const where = location?.startOffset ?? 0;
      const attrAt = (name: string) =>
        location?.attrs?.[name] ??
        location?.attrs?.[name.split(':').pop() ?? ''];

      for (const tagRange of [location?.startTag, location?.endTag]) {
        if (tagRange)
          forbidden.push([tagRange.startOffset, tagRange.endOffset]);
      }
      if (isActive(element)) {
        report(
          'html-active',
          where,
          `<${tag}> is not allowed in a pack: printing must not run code or change where the page loads from`,
        );
        continue;
      }
      if (isRefused(element)) {
        report(
          'html-unsupported',
          where,
          `<${tag}> is not an element a pack may use (see the T06 allowlist)`,
        );
        continue;
      }

      const foreign =
        element.namespaceURI === svg || element.namespaceURI === mathml;
      const allowed = htmlElements.get(tag) ?? [];
      for (const attr of element.attrs) {
        const name = fullName(attr);
        const at = attrAt(name);
        const offset = at?.startOffset ?? where;
        if (at) {
          // A quoted value is the one place a statement may sit in a tag;
          // never in style, whose value is CSS.
          const raw = html.slice(at.startOffset, at.endOffset);
          const equals = raw.indexOf('=');
          const open = equals < 0 ? -1 : raw.slice(equals + 1).search(/\S/);
          const quote = open < 0 ? '' : raw[equals + 1 + open];
          if (name !== 'style' && (quote === '"' || quote === "'")) {
            values.push([at.startOffset + equals + 2 + open, at.endOffset - 1]);
          }
        }
        if (name.startsWith('on') || name === 'srcdoc') {
          report(
            'html-active',
            offset,
            `${name} is not allowed in a pack: printing must not run code`,
          );
          continue;
        }
        let ok: boolean;
        if (name === 'href' || name === 'xlink:href') {
          ok = foreign
            ? tag === 'image' ||
              ((tag === 'use' || tag === 'textPath') &&
                attr.value.startsWith('#'))
            : allowed.includes('href');
        } else {
          ok =
            foreign ||
            globalAttributes.has(name) ||
            name.startsWith('aria-') ||
            name.startsWith('data-') ||
            allowed.includes(name);
        }
        if (ok && !foreign && tag === 'input' && name === 'type') {
          ok = inputTypes.has(attr.value.toLowerCase());
        }
        if (ok && !foreign && tag === 'link' && name === 'rel') {
          ok = attr.value === 'stylesheet';
        }
        if (!ok) {
          report(
            'html-unsupported',
            offset,
            `${name}${name === 'type' || name === 'rel' || name.endsWith('href') ? `="${attr.value}"` : ''} is not allowed on <${tag}> in a pack (see the T06 allowlist)`,
          );
        }
      }
      if (
        !foreign &&
        tag === 'link' &&
        attributeOf(element, 'rel') === undefined
      ) {
        report('html-unsupported', where, '<link> needs rel="stylesheet"');
      }
      if (tag === 'style') {
        for (const text of element.childNodes) {
          const at = (text as Html.TextNode).sourceCodeLocation;
          if (at) forbidden.push([at.startOffset, at.endOffset]);
        }
      }
      visit(tag === 'template' ? (element as Html.Template).content : element);
    }
  };
  visit(document);

  const inside = (at: number, [start, end]: [number, number]) =>
    start <= at && at < end;
  for (const [start] of statements) {
    const before = source.slice(Math.max(0, start - 2), start);
    if (
      before.endsWith('<') ||
      before === '</' ||
      (forbidden.some(range => inside(start, range)) &&
        !values.some(range => inside(start, range)))
    ) {
      report(
        'template-structure',
        start,
        'Handlebars may not sit inside a tag (except in a quoted attribute value), an HTML comment, CSS, or right after <: put {{…}} in text or in quoted values',
      );
    }
  }
  return issues;
}
