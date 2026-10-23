// The data-gt rule: everything a template prints sits inside exactly one
// element marked with a contract block type, and the attributes T08 and T13
// read from that element are well formed. Checked on the template source, so
// every issue points at a line and column the pack author wrote.
import { blockTypes } from '@pdf-generator/contract';
import { attributeOf, type Html, type TemplateHtml } from './html.ts';
import type { PackIssue } from './issues.ts';
import { isRefused } from './policy.ts';
import { position } from './text.ts';

/** Subtrees that print nothing. */
const exempt = new Set(['head', 'script', 'style', 'template', 'noscript']);
/** Elements that print without a text node. */
const media = new Set([
  'img',
  'svg',
  'canvas',
  'picture',
  'video',
  'object',
  'embed',
  'iframe',
  'input',
  'select',
  'textarea',
  'math',
]);
const types = new Set<string>(blockTypes);
/** The data-gt attributes T08 and T13 read; any other data-gt-* is a typo. */
const known = new Set([
  'data-gt',
  'data-gt-id',
  'data-gt-checked',
  'data-gt-latex',
  'data-gt-text',
]);
/** Which block type each detail attribute belongs on. */
const detailOf: Record<string, string> = {
  'data-gt-checked': 'checkbox',
  'data-gt-latex': 'formula',
  'data-gt-text': 'image',
};
/** T08 suffixes a repeated id with -2, -3, …; gt.json ids are 1-64 long. */
const maxIdLength = 60;

/** Whitespace in source text, including the no-break space as an entity. */
const blank = /^(?:\s|&nbsp;|&#160;|&#x0*a0;)*/i;

const isGtAttribute = (name: string) =>
  name === 'data-gt' || name.startsWith('data-gt-');

function* descendants(node: Html.ParentNode): Generator<Html.ChildNode> {
  for (const child of node.childNodes) {
    yield child;
    if ('childNodes' in child) yield* descendants(child);
  }
}

/** Every place the template breaks the data-gt rule. */
export function markIssues(
  source: string,
  { html, document, branchAt, inBranch }: TemplateHtml,
  file: string,
): PackIssue[] {
  const issues: PackIssue[] = [];
  const report = (code: string, offset: number, message: string) =>
    issues.push({ code, file, ...position(source, offset), message });

  /** Offset of the first non-blank character of a text node, if any. */
  const textStart = (text: Html.TextNode) => {
    const location = text.sourceCodeLocation;
    if (!/\S/.test(text.value) || !location) return undefined;
    const slice = html.slice(location.startOffset, location.endOffset);
    return location.startOffset + (blank.exec(slice)?.[0].length ?? 0);
  };

  /** Offset of the last printed thing inside an element, if any. */
  const lastContent = (element: Html.Element) => {
    let last: number | undefined;
    for (const node of descendants(element)) {
      const location = node.sourceCodeLocation;
      if (!location) continue;
      if (node.nodeName === '#text') {
        const slice = html.slice(location.startOffset, location.endOffset);
        const trailing = /\S\s*$/.exec(slice);
        if (trailing) last = location.startOffset + trailing.index;
      } else if ('tagName' in node) last = location.startOffset;
    }
    return last;
  };

  /** The detail checks of a marked element of a known type. */
  const details = (
    element: Html.Element,
    type: string,
    at: (name: string) => number,
  ) => {
    const checked = attributeOf(element, 'data-gt-checked');
    const latex = attributeOf(element, 'data-gt-latex');
    const text = attributeOf(element, 'data-gt-text');
    for (const attr of [checked, latex, text]) {
      if (attr !== undefined && detailOf[attr.name] !== type) {
        report(
          'gt-attribute',
          at(attr.name),
          `${attr.name} belongs on data-gt="${detailOf[attr.name]}", not "${type}"`,
        );
      }
    }
    const inside = [...descendants(element)];
    if (type === 'checkbox') {
      if (
        checked !== undefined &&
        !['true', 'false'].includes(checked.value) &&
        !checked.value.includes('{{')
      ) {
        report(
          'gt-attribute',
          at('data-gt-checked'),
          'data-gt-checked must be true, false or a {{field}}',
        );
      }
      const inputs = inside.filter(
        node =>
          'tagName' in node &&
          node.tagName === 'input' &&
          ['checkbox', 'radio'].includes(
            attributeOf(node, 'type')?.value.toLowerCase() ?? '',
          ),
      );
      if (checked === undefined && inputs.length !== 1) {
        report(
          'gt-checkbox',
          at('data-gt'),
          `a checkbox block needs data-gt-checked, or exactly one <input type="checkbox|radio"> (found ${inputs.length})`,
        );
      }
    }
    if (type === 'formula') {
      if (latex !== undefined && latex.value === '') {
        report('gt-attribute', at('data-gt-latex'), 'data-gt-latex is empty');
      }
      const annotated = inside.some(
        node =>
          'tagName' in node &&
          node.tagName === 'annotation' &&
          attributeOf(node, 'encoding')?.value === 'application/x-tex',
      );
      if (latex === undefined && !annotated) {
        report(
          'gt-formula',
          at('data-gt'),
          'a formula block needs data-gt-latex, or a KaTeX <annotation encoding="application/x-tex">',
        );
      }
    }
    if (type === 'image' && text !== undefined) {
      for (const node of inside) {
        const start =
          node.nodeName === '#text'
            ? textStart(node as Html.TextNode)
            : undefined;
        if (start !== undefined) {
          report(
            'gt-image-text',
            start,
            'an image block with data-gt-text must not contain printed text',
          );
          break;
        }
      }
    }
    if (type === 'table' && element.tagName !== 'table') {
      report(
        'gt-table',
        at('data-gt'),
        `data-gt="table" must be on a <table>, not <${element.tagName}>`,
      );
    }
  };

  const visit = (node: Html.ParentNode, marked: boolean, table: boolean) => {
    for (const child of node.childNodes) {
      if (child.nodeName === '#text') {
        const start = marked ? undefined : textStart(child as Html.TextNode);
        if (start !== undefined) {
          const text = (child as Html.TextNode).value.trim().slice(0, 40);
          report(
            'gt-unmarked',
            start,
            `text "${text}" is not inside an element with data-gt`,
          );
        }
        continue;
      }
      if (!('tagName' in child)) continue;
      const element = child as Html.Element;
      // Refused elements are the allowlist's to report (policy.ts).
      if (exempt.has(element.tagName) || isRefused(element)) continue;
      const location = element.sourceCodeLocation;
      const at = (name: string) =>
        location?.attrs?.[name]?.startOffset ?? location?.startOffset ?? 0;

      // An element prints whole or not at all only if its tags are in one
      // Handlebars branch (statements inside a tag are template-structure).
      if (location?.startTag) {
        const branch = branchAt(location.startTag.startOffset);
        // Without an end tag, the element runs on to its last content,
        // which must then be printed whenever the start tag is.
        const last = location.endTag ? undefined : lastContent(element);
        if (
          branchAt(location.startTag.endOffset - 1) !== branch ||
          (location.endTag &&
            branchAt(location.endTag.startOffset) !== branch) ||
          (last !== undefined && !inBranch(last, branch))
        ) {
          report(
            'gt-branch',
            location.startOffset,
            `<${element.tagName}> must open and close in the same {{#…}}/{{else}} branch`,
          );
        }
      }

      const gtAttrs = element.attrs.filter(attr => isGtAttribute(attr.name));
      if (table && ['td', 'th'].includes(element.tagName) && gtAttrs.length) {
        for (const attr of gtAttrs) {
          report(
            'gt-table',
            at(attr.name),
            `table cells carry no ${attr.name}: the table block describes them`,
          );
        }
        visit(element, marked, table);
        continue;
      }

      const mark = attributeOf(element, 'data-gt');
      if (mark !== undefined && marked) {
        report(
          'gt-nested',
          at('data-gt'),
          'data-gt inside another data-gt element: its text would be counted twice',
        );
        visit(element, true, table);
        continue;
      }
      for (const attr of gtAttrs) {
        if (attr.name === 'data-gt') continue;
        if (!known.has(attr.name)) {
          report(
            'gt-attribute',
            at(attr.name),
            `${attr.name} is not a ground-truth attribute; use data-gt, data-gt-id, data-gt-checked, data-gt-latex or data-gt-text`,
          );
        } else if (mark === undefined) {
          report(
            'gt-attribute',
            at(attr.name),
            `${attr.name} needs data-gt on the same element`,
          );
        }
      }
      if (mark === undefined) {
        if (!marked && media.has(element.tagName)) {
          report(
            'gt-unmarked',
            location?.startOffset ?? 0,
            `<${element.tagName}> is not inside an element with data-gt`,
          );
          continue;
        }
        visit(element, marked, table);
        continue;
      }

      const id = attributeOf(element, 'data-gt-id');
      if (id !== undefined) {
        const literal = id.value.replace(/\{\{[\s\S]*?\}\}/g, '');
        if (id.value === '') {
          report('gt-id', at('data-gt-id'), 'data-gt-id is empty');
        } else if (
          !/^[A-Za-z0-9_-]*$/.test(literal) ||
          literal.length > maxIdLength
        ) {
          report(
            'gt-id',
            at('data-gt-id'),
            `data-gt-id may use only A-Z a-z 0-9 _ - and at most ${maxIdLength} characters`,
          );
        }
      }
      if (types.has(mark.value)) details(element, mark.value, at);
      else {
        report(
          'gt-type',
          at('data-gt'),
          `data-gt="${mark.value}" is not a block type; use one of ${blockTypes.join(', ')}`,
        );
      }
      visit(element, true, mark.value === 'table');
    }
  };
  visit(document, false, false);
  return issues;
}
