// Chrome writes values into every PDF that change from one print of the same
// HTML to the next: the print time, the tab's URL as the title when the
// document has none (its /pack/<id>/ is new on every print), and DOM node
// ids in the tagged PDF's structure tree. A rerun of a batch must give the
// same bytes (T07-2), so they are blanked out after printing.
// Each edit keeps the length of what it replaces, so the xref table's byte
// offsets stay valid and nothing else in the file moves.
// The file is read as PDF tokens, never searched as text: the document's
// <title>, alt texts and labels are literal strings the pack writes, and
// what they say must never be taken for structure (T07-27).
import { Buffer } from 'node:buffer';

interface Token {
  kind: 'name' | 'string' | 'other' | '[' | ']' | '<<' | '>>';
  start: number;
  end: number;
}

type Value =
  | { kind: 'dict'; entries: Map<string, Entry>; end: number }
  | { kind: 'array'; items: Value[]; end: number }
  | { kind: 'ref'; key: string; end: number }
  | { kind: 'token'; token: Token; end: number };

interface Entry {
  key: Token;
  value: Value;
}

const whitespace = new Set([0, 9, 10, 12, 13, 32]);
const delimiters = new Set([...'()<>[]{}/%'].map(char => char.charCodeAt(0)));
const integer = /^\d+$/;

/** A PDF's tokens, and its indirect objects by `<number> <generation>`. */
class Pdf {
  readonly tokens: Token[] = [];
  /** Each object's body: its tokens [from, to) and bytes [start, end). */
  readonly objects = new Map<
    string,
    { from: number; to: number; start: number; end: number }
  >();

  readonly text: string;

  constructor(text: string) {
    this.text = text;
    this.tokenize();
    this.index();
  }

  word(token: Token | undefined): string | undefined {
    return token && this.text.slice(token.start, token.end);
  }

  private tokenize() {
    const { text, tokens } = this;
    const length = text.length;
    let at = 0;
    const add = (kind: Token['kind'], start: number, end: number) => {
      tokens.push({ kind, start, end });
      at = end;
    };
    while (at < length) {
      const code = text.charCodeAt(at);
      const char = text[at];
      if (whitespace.has(code)) {
        at++;
      } else if (char === '%') {
        while (at < length && text[at] !== '\n' && text[at] !== '\r') at++;
      } else if (char === '(') {
        // Escapes and balanced parentheses, to any depth.
        let end = at + 1;
        for (let depth = 1; end < length && depth > 0; end++) {
          const inner = text[end];
          if (inner === '\\') end++;
          else if (inner === '(') depth++;
          else if (inner === ')') depth--;
        }
        add('string', at, Math.min(end, length));
      } else if (char === '<' && text[at + 1] === '<') {
        add('<<', at, at + 2);
      } else if (char === '>' && text[at + 1] === '>') {
        add('>>', at, at + 2);
      } else if (char === '<') {
        const end = text.indexOf('>', at);
        add('string', at, end < 0 ? length : end + 1);
      } else if (char === '[' || char === ']') {
        add(char, at, at + 1);
      } else if (delimiters.has(code) && char !== '/') {
        at++;
      } else {
        let end = at + 1;
        while (
          end < length &&
          !whitespace.has(text.charCodeAt(end)) &&
          !delimiters.has(text.charCodeAt(end))
        ) {
          end++;
        }
        const stream = text.slice(at, end) === 'stream';
        add(char === '/' ? 'name' : 'other', at, end);
        if (stream) at = this.streamEnd(end);
      }
    }
  }

  /** Where the data of the stream whose keyword ends at `keywordEnd` ends. */
  private streamEnd(keywordEnd: number): number {
    const { text } = this;
    let start = keywordEnd;
    if (text[start] === '\r') start++;
    if (text[start] === '\n') start++;
    // The stream's dictionary ends right before its keyword.
    const keyword = this.tokens.length - 1;
    let open = keyword - 1;
    for (let depth = 0; open >= 0; open--) {
      const kind = this.tokens[open]?.kind;
      if (kind === '>>') depth++;
      if (kind === '<<' && --depth === 0) break;
    }
    const dict = open >= 0 ? this.parse(open)[0] : undefined;
    const declared =
      dict?.kind === 'dict' ? dict.entries.get('/Length')?.value : undefined;
    const length =
      declared?.kind === 'token' &&
      integer.test(this.word(declared.token) ?? '')
        ? Number(this.word(declared.token))
        : undefined;
    if (length !== undefined) {
      const end = start + length;
      if (/^\s*endstream/.test(text.slice(end, end + 12))) return end;
    }
    const end = text.indexOf('endstream', start);
    return end < 0 ? text.length : end;
  }

  private index() {
    const { tokens } = this;
    for (let at = 2; at < tokens.length; at++) {
      if (
        this.word(tokens[at]) !== 'obj' ||
        !integer.test(this.word(tokens[at - 2]) ?? '') ||
        !integer.test(this.word(tokens[at - 1]) ?? '')
      ) {
        continue;
      }
      const head = tokens[at] as Token;
      let to = at + 1;
      while (to < tokens.length && this.word(tokens[to]) !== 'endobj') to++;
      const end = tokens[to]?.start ?? this.text.length;
      this.objects.set(
        `${this.word(tokens[at - 2])} ${this.word(tokens[at - 1])}`,
        { from: at + 1, to, start: head.end, end },
      );
      at = to;
    }
  }

  /** The value whose first token is `at`, and the token after it. */
  parse(at: number): [Value | undefined, number] {
    const { tokens } = this;
    const token = tokens[at];
    if (!token) return [undefined, at + 1];
    if (token.kind === '<<') {
      const entries = new Map<string, Entry>();
      let next = at + 1;
      while (next < tokens.length && tokens[next]?.kind !== '>>') {
        const key = tokens[next] as Token;
        if (key.kind !== 'name') {
          next++;
          continue;
        }
        const [value, after] = this.parse(next + 1);
        if (value) entries.set(this.word(key) ?? '', { key, value });
        next = after;
      }
      return [
        { kind: 'dict', entries, end: tokens[next]?.end ?? token.end },
        next + 1,
      ];
    }
    if (token.kind === '[') {
      const items: Value[] = [];
      let next = at + 1;
      while (next < tokens.length && tokens[next]?.kind !== ']') {
        const [value, after] = this.parse(next);
        if (value) items.push(value);
        next = after;
      }
      return [
        { kind: 'array', items, end: tokens[next]?.end ?? token.end },
        next + 1,
      ];
    }
    const [generation, r] = [tokens[at + 1], tokens[at + 2]];
    if (
      integer.test(this.word(token) ?? '') &&
      integer.test(this.word(generation) ?? '') &&
      this.word(r) === 'R'
    ) {
      return [
        {
          kind: 'ref',
          key: `${this.word(token)} ${this.word(generation)}`,
          end: (r as Token).end,
        },
        at + 3,
      ];
    }
    return [{ kind: 'token', token, end: token.end }, at + 1];
  }

  /** `value`, or the object it refers to. */
  resolve(value: Value | undefined): Value | undefined {
    if (value?.kind !== 'ref') return value;
    const object = this.objects.get(value.key);
    return object && this.parse(object.from)[0];
  }
}

/**
 * `pdf` as Chrome printed it from `documentUrl`, without what differs between
 * two prints of the same HTML: `/CreationDate` and `/ModDate`, `/Title` when
 * it is the URL Chrome falls back to (a document's own `<title>` stays), and
 * the DOM node ids that name the tagged PDF's structure elements.
 */
export function stablePdf(pdf: Uint8Array, documentUrl: string): Uint8Array {
  const text = Buffer.from(pdf).toString('latin1');
  const file = new Pdf(text);
  // [offset, what to write there]: each as long as what it overwrites.
  const edits: [number, string][] = [];
  const blank = (start: number, end: number) => {
    edits.push([start, ' '.repeat(end - start)]);
  };
  const dict = (value: Value | undefined) => {
    const resolved = file.resolve(value);
    return resolved?.kind === 'dict' ? resolved.entries : undefined;
  };
  // The last trailer is the one in force.
  const trailer = file.tokens.findLastIndex(
    (token, at) =>
      file.word(token) === 'trailer' && file.tokens[at + 1]?.kind === '<<',
  );
  const entries = trailer < 0 ? undefined : dict(file.parse(trailer + 1)[0]);
  // Chrome writes the URL without its scheme, escaped as a literal string.
  const fallback = `(${documentUrl
    .replace(/^[a-z][a-z\d+.-]*:\/\//i, '')
    .replace(/[\\()]/g, String.raw`\$&`)})`;
  for (const [name, { key, value }] of dict(entries?.get('/Info')?.value) ??
    []) {
    if (
      value.kind !== 'token' ||
      !file.word(value.token)?.startsWith('(') ||
      !['/CreationDate', '/ModDate', '/Title'].includes(name) ||
      (name === '/Title' && file.word(value.token) !== fallback)
    ) {
      continue;
    }
    blank(key.start, value.end);
  }
  // Chrome names each structure element /ID (node<n>), its DOM node's id,
  // lists those names in the IDTree, and names a table cell's header cells
  // by them (/Headers). The browser hands the ids out on demand, so their
  // order changes from print to print (a rerun of 100 fixtures differed in
  // 5). All three are removed, the IDTree's objects becoming null; the rest
  // of the structure tree stays. Only the structure tree the catalog names
  // is read.
  const root = dict(
    dict(entries?.get('/Root')?.value)?.get('/StructTreeRoot')?.value,
  );
  const nodeId = (value: Value) =>
    value.kind === 'token' &&
    /^\(node\d+\)$/.test(file.word(value.token) ?? '');
  // Each object is read once, so a reference loop ends.
  const seen = new Set<string>();
  const unseen = (value: Value) => {
    if (value.kind !== 'ref') return true;
    if (seen.has(value.key)) return false;
    seen.add(value.key);
    return true;
  };
  const items = (value: Value | undefined) => {
    const resolved = file.resolve(value);
    return resolved?.kind === 'array' ? resolved.items : value ? [value] : [];
  };
  const tree = root?.get('/IDTree');
  const trees: Value[] = [];
  if (tree?.value.kind === 'ref') {
    blank(tree.key.start, tree.value.end);
    trees.push(tree.value);
  }
  for (let node = trees.pop(); node; node = trees.pop()) {
    const object = node.kind === 'ref' && file.objects.get(node.key);
    if (!object || !unseen(node)) continue;
    const kids = dict(node)?.get('/Kids')?.value;
    trees.push(...items(kids).filter(kid => kid.kind === 'ref'));
    const { start, end } = object;
    edits.push([start, ` null${' '.repeat(end - start - ' null'.length)}`]);
  }
  const elements = items(root?.get('/K')?.value);
  for (let element = elements.pop(); element; element = elements.pop()) {
    if (!unseen(element)) continue;
    const resolved = file.resolve(element);
    if (resolved?.kind === 'array') {
      elements.push(...resolved.items);
      continue;
    }
    if (resolved?.kind !== 'dict') continue;
    const id = resolved.entries.get('/ID');
    if (id && nodeId(id.value)) blank(id.key.start, id.value.end);
    for (const owner of items(resolved.entries.get('/A')?.value)) {
      const headers = unseen(owner) && dict(owner)?.get('/Headers');
      if (
        headers &&
        headers.value.kind === 'array' &&
        headers.value.items.every(nodeId)
      ) {
        blank(headers.key.start, headers.value.end);
      }
    }
    elements.push(...items(resolved.entries.get('/K')?.value));
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
