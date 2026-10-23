// The data-gt rule: everything a template prints sits inside exactly one
// element marked with a contract block type. Checked on the template source,
// so every issue points at a line and column the pack author wrote.
import { blockTypes } from '@pdf-generator/contract';
import type { Html, TemplateHtml } from './html.ts';
import type { PackIssue } from './issues.ts';
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

/** Whitespace in source text, including the no-break space as an entity. */
const blank = /^(?:\s|&nbsp;|&#160;|&#x0*a0;)*/i;

/** Every place the template breaks the data-gt rule. */
export function markIssues(
  source: string,
  { html, document }: TemplateHtml,
  file: string,
): PackIssue[] {
  const issues: PackIssue[] = [];
  const report = (code: string, offset: number, message: string) =>
    issues.push({ code, file, ...position(source, offset), message });

  const visit = (node: Html.ParentNode, marked: boolean) => {
    for (const child of node.childNodes) {
      if (child.nodeName === '#text') {
        const text = child as Html.TextNode;
        const location = text.sourceCodeLocation;
        if (marked || !/\S/.test(text.value) || !location) continue;
        const slice = html.slice(location.startOffset, location.endOffset);
        report(
          'gt-unmarked',
          location.startOffset + (blank.exec(slice)?.[0].length ?? 0),
          `text "${text.value.trim().slice(0, 40)}" is not inside an element with data-gt`,
        );
        continue;
      }
      if (!('tagName' in child)) continue;
      const element = child as Html.Element;
      if (exempt.has(element.tagName)) continue;
      const location = element.sourceCodeLocation;
      const attribute = (name: string) =>
        element.attrs.find(attr => attr.name === name);
      const attributeAt = (name: string) =>
        location?.attrs?.[name]?.startOffset ?? location?.startOffset ?? 0;

      const id = attribute('data-gt-id');
      if (id !== undefined && id.value === '') {
        report('gt-id', attributeAt('data-gt-id'), 'data-gt-id is empty');
      }
      const mark = attribute('data-gt');
      if (mark !== undefined) {
        if (marked) {
          report(
            'gt-nested',
            attributeAt('data-gt'),
            'data-gt inside another data-gt element: its text would be counted twice',
          );
        } else if (!types.has(mark.value)) {
          report(
            'gt-type',
            attributeAt('data-gt'),
            `data-gt="${mark.value}" is not a block type; use one of ${blockTypes.join(', ')}`,
          );
        }
        visit(element, true);
        continue;
      }
      if (!marked && media.has(element.tagName)) {
        report(
          'gt-unmarked',
          location?.startOffset ?? 0,
          `<${element.tagName}> is not inside an element with data-gt`,
        );
        continue;
      }
      visit(element, marked);
    }
  };
  visit(document, false);
  return issues;
}
