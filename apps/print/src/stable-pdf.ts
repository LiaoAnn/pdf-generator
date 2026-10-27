// Chrome writes values into every PDF that change from one print of the same
// HTML to the next: the print time, and the tab's URL as the title when the
// document has none (its /pack/<id>/ is new on every print). A rerun of a
// batch must give the same bytes (T07-2), so they are blanked out after
// printing. Each edit keeps the length of what it replaces, so the xref
// table's byte offsets stay valid and nothing else in the file moves.
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
 * two prints of the same HTML: `/CreationDate` and `/ModDate`, and `/Title`
 * when it is the URL Chrome falls back to. A document's own `<title>` stays.
 */
export function stablePdf(pdf: Uint8Array, documentUrl: string): Uint8Array {
  const text = Buffer.from(pdf).toString('latin1');
  const masked = structureOnly(text);
  const blanks: [number, number][] = [];
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
      blanks.push([start + entry.index, start + entry.index + entry[0].length]);
    }
  }
  if (blanks.length === 0) return pdf;
  let result = '';
  let from = 0;
  for (const [start, end] of blanks) {
    result += text.slice(from, start) + ' '.repeat(end - start);
    from = end;
  }
  return new Uint8Array(Buffer.from(result + text.slice(from), 'latin1'));
}
