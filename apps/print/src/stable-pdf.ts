// Chrome writes values into every PDF that change from one print of the same
// HTML to the next: the print time, the tab's URL as the title when the
// document has none (its /pack/<id>/ is new on every print), and DOM node
// ids in the tagged PDF's structure tree. A rerun of a batch must give the
// same bytes (T07-2), so they are blanked out or renumbered after printing.
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
  const end = masked.indexOf('endobj', start);
  return end < 0 ? undefined : [start, end];
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
  // Each structure element's /ID is `node<n>`, n counting the nodes the
  // browser has made, so a restarted browser shifts every id (T07-2's source,
  // PR #11). Renumbered by rank at the same width, they keep the order the
  // IDTree's sorted /Names and /Limits rely on.
  const ids = new Map<string, string>();
  for (const [, digits = ''] of masked.matchAll(/\/ID\s*\(node(\d+)\)/g)) {
    ids.set(digits, digits);
  }
  [...ids.keys()]
    .sort((a, b) => a.length - b.length || (a < b ? -1 : 1))
    .forEach((digits, rank) => {
      ids.set(digits, String(rank).padStart(digits.length, '0'));
    });
  // The same strings in the IDTree, wherever it is written (a document's own
  // string that equals one of them is renumbered with it, which is still the
  // same on every print).
  for (const name of masked.matchAll(/\(node(\d+)\)/g)) {
    const digits = name[1] ?? '';
    const renumbered = ids.get(digits);
    if (renumbered !== undefined && renumbered !== digits) {
      edits.push([name.index + '(node'.length, renumbered]);
    }
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
