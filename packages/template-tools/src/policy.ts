// What HTML a pack may contain: only what a printed document needs, so a
// fixture prints the same way every time and nothing in it runs code or
// fetches from the network. An allowlist, not a list of known tricks; plus
// the rule that Handlebars may not change the HTML or CSS structure, since
// the checks see the template with its Handlebars statements taken out.
import {
  attributeOf,
  type Html,
  lastContent,
  type TemplateHtml,
} from './html.ts';
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
/** Word's HTML aligns blocks with the legacy attribute. */
const aligned = (...names: string[]) =>
  names.map(name => [name, ['align']] as const);

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
  ['img', ['src', 'srcset', 'sizes', 'alt', 'width', 'height', 'align']],
  ['source', ['srcset', 'sizes', 'type', 'media', 'width', 'height']],
  [
    'input',
    ['type', 'checked', 'name', 'value', 'disabled', 'readonly', 'size'],
  ],
  ['textarea', ['name', 'rows', 'cols', 'disabled', 'readonly']],
  ...aligned('div', 'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'),
  ...plain(
    'head',
    'body',
    'title',
    'span',
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
const urlAttributes = new Set(['src', 'srcset', 'href', 'xlink:href']);
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
  { html, document, statements, branchAt, inBranch }: TemplateHtml,
  file: string,
): PackIssue[] {
  const issues: PackIssue[] = [];
  const report = (code: string, offset: number, message: string) =>
    issues.push({ code, file, ...position(source, offset), message });

  // Where statements may not appear (tags, HTML comments, CSS); the quoted
  // attribute values inside tags where they may; of those, the URL values,
  // and the RCDATA content (title, textarea), where only mustaches may.
  const forbidden: [number, number][] = [];
  const values: [number, number][] = [];
  const urls: [number, number][] = [];
  const rcdata: [number, number][] = [];

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

      // An element prints whole or not at all only if its tags (or, without
      // an end tag, its last content) are in one Handlebars branch.
      if (location?.startTag) {
        const branch = branchAt(location.startTag.startOffset);
        const last = location.endTag ? undefined : lastContent(html, element);
        if (
          branchAt(location.startTag.endOffset - 1) !== branch ||
          (location.endTag &&
            branchAt(location.endTag.startOffset) !== branch) ||
          (last !== undefined && !inBranch(last, branch))
        ) {
          report(
            'gt-branch',
            where,
            `<${tag}> must open and close in the same {{#…}}/{{else}} branch`,
          );
        }
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
          // never in style, whose value is CSS, nor on SVG or MathML, whose
          // attributes are CSS-like (fill="url(…)").
          const raw = html.slice(at.startOffset, at.endOffset);
          const equals = raw.indexOf('=');
          const open = equals < 0 ? -1 : raw.slice(equals + 1).search(/\S/);
          const quote = open < 0 ? '' : raw[equals + 1 + open];
          const value: [number, number] = [
            at.startOffset + equals + 2 + open,
            at.endOffset - 1,
          ];
          if (
            !foreign &&
            name !== 'style' &&
            (quote === '"' || quote === "'")
          ) {
            values.push(value);
            if (urlAttributes.has(name)) urls.push(value);
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
      if (tag === 'style' || tag === 'title' || tag === 'textarea') {
        for (const text of element.childNodes) {
          const at = (text as Html.TextNode).sourceCodeLocation;
          if (at) {
            (tag === 'style' ? forbidden : rcdata).push([
              at.startOffset,
              at.endOffset,
            ]);
          }
        }
      }
      visit(tag === 'template' ? (element as Html.Template).content : element);
    }
  };
  visit(document);

  // Each list holds disjoint ranges: sort once, then binary search.
  const lookup = (ranges: [number, number][]) => {
    ranges.sort((a, b) => a[0] - b[0]);
    return (at: number) => {
      let low = 0;
      let high = ranges.length - 1;
      while (low <= high) {
        const middle = (low + high) >> 1;
        const [start, end] = ranges[middle] ?? [0, 0];
        if (at < start) high = middle - 1;
        else if (at >= end) low = middle + 1;
        else return true;
      }
      return false;
    };
  };
  const inForbidden = lookup(forbidden);
  const inValue = lookup(values);
  const inUrl = lookup(urls);
  const inRcdata = lookup(rcdata);
  for (const { start, mustache } of statements) {
    const before = source.slice(Math.max(0, start - 2), start);
    const where =
      before.endsWith('<') || before === '</'
        ? 'right after <'
        : inForbidden(start) && !inValue(start)
          ? 'inside a tag (outside a quoted value), CSS or an HTML comment'
          : !mustache && inUrl(start)
            ? 'inside a URL, where it can change the scheme or host'
            : !mustache && inRcdata(start)
              ? 'inside <title> or <textarea>, where it can end the element'
              : undefined;
    if (where !== undefined) {
      report(
        'template-structure',
        start,
        `Handlebars may not sit ${where}: it would change the HTML the checks see; put {{…}} in text or in quoted attribute values`,
      );
    }
  }
  return issues;
}
