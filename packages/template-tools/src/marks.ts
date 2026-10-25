// The data-gt rule: everything a template prints sits inside exactly one
// element marked with a contract block type, and the attributes T08 and T13
// read from that element are well formed. Checked on the template source, so
// every issue points at a line and column the pack author wrote.
import { blockTypes } from '@pdf-generator/contract';
import {
  attributeOf,
  descendants,
  type Html,
  type TemplateHtml,
} from './html.ts';
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
/** Slots the print runtime fills with the page's number or the page count. */
const slots = new Set(['data-gt-page-number', 'data-gt-page-count']);
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

/**
 * A data-gt-checked value: a state, or one the data decides, made of
 * statements only (literal text around one prints neither true nor false).
 */
const checkedValue = (value: string) =>
  value === 'true' ||
  value === 'false' ||
  (value.includes('{{') && value.replace(/\{\{[\s\S]*?\}\}/g, '') === '');

const isToggle = (node: Html.Node): node is Html.Element =>
  'tagName' in node &&
  node.tagName === 'input' &&
  ['checkbox', 'radio'].includes(
    attributeOf(node, 'type')?.value.toLowerCase() ?? '',
  );

/**
 * Whether a literal data-gt-checked state disagrees with the `checked`
 * attribute of one of `inputs`, which T13 refuses when it prints.
 */
const contradicts = (value: string, inputs: Html.Element[]) =>
  (value === 'true' || value === 'false') &&
  inputs.some(
    input =>
      (attributeOf(input, 'checked') !== undefined) !== (value === 'true'),
  );

const isGtAttribute = (name: string) =>
  name === 'data-gt' || name.startsWith('data-gt-');

/** Whether an ancestor of the element is a page_number block. */
const inPageNumber = (element: Html.Element) => {
  for (let node = element.parentNode; node; ) {
    if (!('tagName' in node)) return false;
    if (attributeOf(node, 'data-gt')?.value === 'page_number') return true;
    node = node.parentNode;
  }
  return false;
};

/** What is wrong with a page-number slot, if anything. */
const slotProblem = (element: Html.Element, name: string, value: string) => {
  if (attributeOf(element, 'data-gt') !== undefined || !inPageNumber(element)) {
    return `${name} goes on an unmarked element inside a data-gt="page_number" element`;
  }
  if (value !== '') return `${name} takes no value`;
  if (element.childNodes.length > 0) {
    return `an element with ${name} must be empty: the print runtime writes the number into it`;
  }
  return undefined;
};

/** Every place the template breaks the data-gt rule. */
export function markIssues(
  source: string,
  { html, document, printedCount }: TemplateHtml,
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
    /** Whether the template prints exactly one of `nodes`, however it goes. */
    const exactlyOne = (nodes: Html.Node[]) => {
      const { min, max } = printedCount(
        element.sourceCodeLocation?.startOffset ?? 0,
        nodes.map(node => node.sourceCodeLocation?.startOffset ?? 0),
      );
      return min === 1 && max === 1;
    };
    if (type === 'checkbox') {
      if (checked !== undefined && !checkedValue(checked.value)) {
        report(
          'gt-attribute',
          at('data-gt-checked'),
          'data-gt-checked must be true, false or a {{field}}',
        );
      }
      // T13 counts the block itself when it is the input.
      const inputs = [element, ...inside].filter(isToggle);
      if (checked === undefined && !exactlyOne(inputs)) {
        report(
          'gt-checkbox',
          at('data-gt'),
          `a checkbox block needs data-gt-checked, or exactly one <input type="checkbox|radio"> in every branch (found ${inputs.length})`,
        );
      }
      if (checked !== undefined && contradicts(checked.value, inputs)) {
        report(
          'gt-checkbox',
          at('data-gt-checked'),
          `data-gt-checked="${checked.value}" disagrees with the checked state of an input inside it`,
        );
      }
    }
    if (type === 'formula') {
      if (latex !== undefined && latex.value === '') {
        report('gt-attribute', at('data-gt-latex'), 'data-gt-latex is empty');
      }
      const annotations = inside.filter(
        node =>
          'tagName' in node &&
          node.tagName === 'annotation' &&
          attributeOf(node, 'encoding')?.value === 'application/x-tex',
      );
      if (latex === undefined && !exactlyOne(annotations)) {
        report(
          'gt-formula',
          at('data-gt'),
          'a formula block needs data-gt-latex, or exactly one KaTeX <annotation encoding="application/x-tex"> in every branch',
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

  /**
   * `table`: inside a table block; `cell`: inside one of its cells, where an
   * element may mark a printed checkbox with data-gt-checked alone (T13);
   * `nested`: inside a table within a cell, whose cells T13 doesn't read.
   */
  const visit = (
    node: Html.ParentNode,
    marked: boolean,
    table: boolean,
    cell = false,
    nested = false,
  ) => {
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

      const gtAttrs = element.attrs.filter(attr => isGtAttribute(attr.name));
      for (const attr of gtAttrs) {
        if (!slots.has(attr.name)) continue;
        const problem = slotProblem(element, attr.name, attr.value);
        if (problem) report('gt-attribute', at(attr.name), problem);
      }
      const isCell = table && ['td', 'th'].includes(element.tagName);
      if (isCell && gtAttrs.length) {
        for (const attr of gtAttrs) {
          report(
            'gt-table',
            at(attr.name),
            `table cells carry no ${attr.name}: the table block describes them`,
          );
        }
        visit(element, marked, table, true);
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
        if (attr.name === 'data-gt' || slots.has(attr.name)) continue;
        if (!known.has(attr.name)) {
          report(
            'gt-attribute',
            at(attr.name),
            `${attr.name} is not a ground-truth attribute; use data-gt, data-gt-id, data-gt-checked, data-gt-latex, data-gt-text, data-gt-page-number or data-gt-page-count`,
          );
        } else if (
          mark === undefined &&
          nested &&
          attr.name === 'data-gt-checked'
        ) {
          report(
            'gt-table',
            at(attr.name),
            'data-gt-checked inside a table nested in a cell: only the cells of the table block itself carry checkboxes',
          );
        } else if (
          mark === undefined &&
          cell &&
          attr.name === 'data-gt-checked'
        ) {
          if (!checkedValue(attr.value)) {
            report(
              'gt-attribute',
              at(attr.name),
              'data-gt-checked must be true, false or a {{field}}',
            );
          } else if (
            contradicts(attr.value, [
              ...(isToggle(element) ? [element] : []),
              ...[...descendants(element)].filter(isToggle),
            ])
          ) {
            report(
              'gt-checkbox',
              at(attr.name),
              `data-gt-checked="${attr.value}" disagrees with the checked state of its input`,
            );
          }
        } else if (mark === undefined) {
          report(
            'gt-attribute',
            at(attr.name),
            `${attr.name} needs data-gt on the same element${attr.name === 'data-gt-checked' ? ' (or must be inside a table cell)' : ''}`,
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
        if (table && element.tagName === 'table') {
          visit(element, marked, false, false, true);
        } else visit(element, marked, table, cell || isCell, nested);
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
