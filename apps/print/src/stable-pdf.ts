// Chrome writes values into every PDF that change from one print of the same
// HTML to the next: the print time, the tab's URL as the title when the
// document has none (its /pack/<id>/ is new on every print), and DOM node
// ids in the tagged PDF's structure tree. A rerun of a batch must give the
// same bytes (T07-2), so they are blanked out after printing.
// Each edit keeps the length of what it replaces, so the xref table's byte
// offsets stay valid and nothing else in the file moves.
import { Buffer } from 'node:buffer';

// PDF literal strings: escapes and balanced parentheses (Chrome escapes the
// unbalanced ones).
const literal = String.raw`\((?:[^\\()]|\\[\s\S]|\((?:[^\\()]|\\[\s\S])*\))*\)`;

/**
 * The PDF with its stream data overwritten by NULs, so that searches only
 * see the file's structure, never compressed bytes that happen to look like
 * it.
 */
function structureOnly(text: string): string {
  let masked = '';
  let from = 0;
  const start = /\bstream\r?\n/g;
  for (;;) {
    const match = start.exec(text);
    if (!match) break;
    const dataStart = match.index + match[0].length;
    const end = text.indexOf('endstream', dataStart);
    if (end < 0) break;
    masked += text.slice(from, dataStart) + '\0'.repeat(end - dataStart);
    from = end;
    start.lastIndex = end;
  }
  return masked + text.slice(from);
}

/** The [start, end) of the body of indirect object `number` `generation`. */
function objectBody(
  masked: string,
  number: string,
  generation: string,
): [number, number] | undefined {
  const head = new RegExp(
    String.raw`(?:^|\s)${number}\s+${generation}\s+obj\b`,
  ).exec(masked);
  if (!head) return;
  const start = head.index + head[0].length;
  // Strings are skipped whole: a document's <title> can hold "endobj".
  const body = new RegExp(`(?:${literal}|[^(])*?endobj`, 'y');
  body.lastIndex = start;
  const match = body.exec(masked);
  return match ? [start, start + match[0].length - 'endobj'.length] : undefined;
}

/**
 * `pdf` as Chrome printed it from `documentUrl`, without what differs between
 * two prints of the same HTML: `/CreationDate` and `/ModDate`, `/Title` when
 * it is the URL Chrome falls back to (a document's own `<title>` stays), and
 * the DOM node ids that name the tagged PDF's structure elements.
 */
export function stablePdf(pdf: Uint8Array, documentUrl: string): Uint8Array {
  const text = Buffer.from(pdf).toString('latin1');
  const masked = structureOnly(text);
  // [offset, what to write there]: each as long as what it overwrites.
  const edits: [number, string][] = [];
  // The last trailer is the one in force.
  const [, number, generation] =
    [...masked.matchAll(/trailer\s*<<[\s\S]*?\/Info\s+(\d+)\s+(\d+)\s+R/g)].at(
      -1,
    ) ?? [];
  const body = number && generation && objectBody(masked, number, generation);
  if (body) {
    const [start, end] = body;
    const dict = masked.slice(start, end);
    // Chrome writes the URL without its scheme, escaped as a literal string.
    const fallback = `(${documentUrl
      .replace(/^[a-z][a-z\d+.-]*:\/\//i, '')
      .replace(/[\\()]/g, String.raw`\$&`)})`;
    for (const entry of dict.matchAll(
      new RegExp(String.raw`/(CreationDate|ModDate|Title)\s*(${literal})`, 'g'),
    )) {
      if (entry[1] === 'Title' && entry[2] !== fallback) continue;
      edits.push([start + entry.index, ' '.repeat(entry[0].length)]);
    }
  }
  // Chrome names each structure element /ID (node<n>), its DOM node's id,
  // lists those names in the IDTree, and names a table cell's header cells
  // by them (/Headers). The browser hands the ids out on demand, so their
  // order changes from print to print (a rerun of 100 fixtures differed in
  // 5). All three are removed, the IDTree's objects becoming null; the rest
  // of the structure tree stays.
  const blank = (index: number, length: number) => {
    edits.push([index, ' '.repeat(length)]);
  };
  for (const id of masked.matchAll(
    /\/ID\s*\(node\d+\)|\/Headers\s*\[(?:\s*\(node\d+\))*\s*\]/g,
  )) {
    blank(id.index, id[0].length);
  }
  const trees: [string, string][] = [];
  for (const root of masked.matchAll(/\/IDTree\s+(\d+)\s+(\d+)\s+R/g)) {
    blank(root.index, root[0].length);
    trees.push([root[1] ?? '', root[2] ?? '']);
  }
  const seen = new Set<string>();
  for (let tree = trees.pop(); tree; tree = trees.pop()) {
    const [number, generation] = tree;
    if (seen.has(`${number} ${generation}`)) continue;
    seen.add(`${number} ${generation}`);
    const body = objectBody(masked, number, generation);
    if (!body) continue;
    const [start, end] = body;
    const kids = /\/Kids\s*\[([^\]]*)\]/.exec(masked.slice(start, end))?.[1];
    for (const kid of kids?.matchAll(/(\d+)\s+(\d+)\s+R/g) ?? []) {
      trees.push([kid[1] ?? '', kid[2] ?? '']);
    }
    edits.push([start, ` null${' '.repeat(end - start - ' null'.length)}`]);
  }
  if (edits.length === 0) return pdf;
  edits.sort(([a], [b]) => a - b);
  let result = '';
  let from = 0;
  for (const [start, replacement] of edits) {
    result += text.slice(from, start) + replacement;
    from = start + replacement.length;
  }
  return new Uint8Array(Buffer.from(result + text.slice(from), 'latin1'));
}
