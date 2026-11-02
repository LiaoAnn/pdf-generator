// The document's operation budget (T14-10): counted from the raw PDF before
// pdf.js reads it, so a document too large to measure is refused before any
// of its work is done.

/**
 * The most content operators one document may produce, counted through every
 * form, soft mask, tiling pattern, Type 3 glyph and annotation appearance that
 * draws them (the 6 packs' largest fixture: 13,250 pdf.js operators).
 */
export const maxOperations = 1 << 18;

/** The deepest forms (and masks, patterns, appearances) may be drawn inside one another. */
export const maxNesting = 64;

/** The most decoded content-stream bytes one document may hold. */
export const maxContentBytes = 1 << 24;

export type OperationCount =
  | {
      ok: true;
      /** Content operators, each form's counted again at every use. */
      operations: number;
      /** The deepest nesting of forms, masks, patterns and appearances. */
      nesting: number;
      /** Decoded bytes of the content streams read, each once. */
      contentBytes: number;
    }
  | {
      ok: false;
      /** Which limit refused it; `structure`: the scan can't read the file. */
      limit: 'operations' | 'nesting' | 'content' | 'structure';
      /** For people. */
      reason: string;
    };

type Limit = Extract<OperationCount, { ok: false }>['limit'];

/** A refusal: caught by `countOperations` and reported as `{ ok: false }`. */
class Refused extends Error {
  readonly limit: Limit;
  constructor(limit: Limit, reason: string) {
    super(reason);
    this.limit = limit;
  }
}

// A function declaration: TS7's narrowing misses const-arrow never returns.
function refuse(limit: Limit, reason: string): never {
  throw new Refused(limit, reason);
}

// ---------------------------------------------------------------------------
// Bytes and tokens

const isWhite = (b: number) =>
  b === 0x00 ||
  b === 0x09 ||
  b === 0x0a ||
  b === 0x0c ||
  b === 0x0d ||
  b === 0x20;
const isDelimiter = (b: number) =>
  b === 0x28 || // (
  b === 0x29 || // )
  b === 0x3c || // <
  b === 0x3e || // >
  b === 0x5b || // [
  b === 0x5d || // ]
  b === 0x7b || // {
  b === 0x7d || // }
  b === 0x2f || // /
  b === 0x25; // %

type Token =
  | { kind: 'name'; name: string; start: number; end: number }
  | { kind: 'num'; value: number; start: number; end: number }
  | { kind: 'word'; word: string; start: number; end: number }
  | {
      kind: 'str' | 'hex' | '<<' | '>>' | '[' | ']';
      start: number;
      end: number;
    };

const numberText = /^[+-]?(?:\d+\.?\d*|\.\d+)$/;

const latin1 = (bytes: Uint8Array, start: number, end: number) => {
  let out = '';
  for (let i = start; i < end; i++) out += String.fromCharCode(bytes[i] ?? 0);
  return out;
};

/**
 * The classic PDF tokeniser, over the raw bytes. `next()` honours one level of
 * pushback (number+number+R lookahead for references).
 */
class TokenStream {
  pos = 0;
  private readonly back: Token[] = [];
  readonly bytes: Uint8Array;
  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
  }

  seek(pos: number) {
    this.pos = pos;
    this.back.length = 0;
  }

  next(): Token | undefined {
    const back = this.back.pop();
    if (back) return back;
    const bytes = this.bytes;
    const pos = this.skipSpace(this.pos);
    if (pos >= bytes.length) return undefined;
    const b = bytes[pos] ?? 0;
    let token: Token;
    if (b === 0x2f) {
      // / name until a delimiter, with #xx escapes
      let end = pos + 1;
      while (
        end < bytes.length &&
        !isWhite(bytes[end] ?? 0) &&
        !isDelimiter(bytes[end] ?? 0)
      )
        end++;
      let name = '';
      for (let i = pos + 1; i < end; i++) {
        const c = bytes[i] ?? 0;
        if (c === 0x23 && i + 2 < end) {
          name += String.fromCharCode(
            Number.parseInt(latin1(bytes, i + 1, i + 3), 16),
          );
          i += 2;
        } else {
          name += String.fromCharCode(c);
        }
      }
      token = { kind: 'name', name, start: pos, end };
    } else if (b === 0x28) {
      // ( literal string: nested parens and backslash escapes
      let depth = 1;
      let end = pos + 1;
      while (end < bytes.length && depth > 0) {
        const c = bytes[end] ?? 0;
        if (c === 0x5c) {
          end += 2;
          continue;
        }
        if (c === 0x28) depth++;
        else if (c === 0x29) depth--;
        end++;
      }
      if (depth > 0) refuse('structure', 'unterminated literal string');
      token = { kind: 'str', start: pos, end };
    } else if (b === 0x3c) {
      if (bytes[pos + 1] === 0x3c) {
        token = { kind: '<<', start: pos, end: pos + 2 };
      } else {
        let end = pos + 1;
        while (end < bytes.length && bytes[end] !== 0x3e) end++;
        if (end >= bytes.length) refuse('structure', 'unterminated hex string');
        token = { kind: 'hex', start: pos, end: end + 1 };
      }
    } else if (b === 0x3e) {
      token =
        bytes[pos + 1] === 0x3e
          ? { kind: '>>', start: pos, end: pos + 2 }
          : { kind: 'word', word: '>', start: pos, end: pos + 1 };
    } else if (b === 0x5b) {
      token = { kind: '[', start: pos, end: pos + 1 };
    } else if (b === 0x5d) {
      token = { kind: ']', start: pos, end: pos + 1 };
    } else {
      let end = pos;
      while (
        end < bytes.length &&
        !isWhite(bytes[end] ?? 0) &&
        !isDelimiter(bytes[end] ?? 0)
      )
        end++;
      const text = latin1(bytes, pos, end);
      token = numberText.test(text)
        ? { kind: 'num', value: Number.parseFloat(text), start: pos, end }
        : { kind: 'word', word: text, start: pos, end };
    }
    this.pos = token.end;
    return token;
  }

  push(token: Token) {
    this.back.push(token);
  }

  private skipSpace(pos: number) {
    const bytes = this.bytes;
    for (;;) {
      if (pos >= bytes.length) return pos;
      const b = bytes[pos] ?? 0;
      if (isWhite(b)) {
        pos++;
      } else if (b === 0x25) {
        // % comment to end of line
        while (pos < bytes.length && bytes[pos] !== 0x0a && bytes[pos] !== 0x0d)
          pos++;
      } else {
        return pos;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Object syntax

type PdfValue =
  | { kind: 'dict'; map: Map<string, PdfValue> }
  | { kind: 'array'; items: PdfValue[] }
  | { kind: 'name'; name: string }
  | { kind: 'num'; value: number }
  | { kind: 'data' } // literal and hex strings: their contents never matter
  | { kind: 'const' } // true, false, null
  | { kind: 'ref'; num: number }
  | { kind: 'stream'; map: Map<string, PdfValue>; dataStart: number };

type Resolved = { num?: number; value: PdfValue } | undefined;

/** Reads one PDF value starting at the stream's next token. */
const readValue = (ts: TokenStream, depth: number): PdfValue => {
  if (depth > 200) refuse('structure', 'object nesting too deep');
  const token = ts.next();
  if (!token) refuse('structure', 'unexpected end of file in an object');
  switch (token.kind) {
    case '<<': {
      const map = new Map<string, PdfValue>();
      for (;;) {
        const key = ts.next();
        if (!key) refuse('structure', 'unterminated dictionary');
        if (key.kind === '>>') break;
        if (key.kind !== 'name')
          refuse('structure', 'dictionary key is not a name');
        map.set(key.name, readValue(ts, depth + 1));
      }
      return { kind: 'dict', map };
    }
    case '[': {
      const items: PdfValue[] = [];
      for (;;) {
        const item = ts.next();
        if (!item) refuse('structure', 'unterminated array');
        if (item.kind === ']') break;
        ts.push(item);
        items.push(readValue(ts, depth + 1));
      }
      return { kind: 'array', items };
    }
    case 'name':
      return { kind: 'name', name: token.name };
    case 'str':
    case 'hex':
      return { kind: 'data' };
    case 'word':
      if (
        token.word === 'true' ||
        token.word === 'false' ||
        token.word === 'null'
      )
        return { kind: 'const' };
      refuse('structure', `unexpected keyword ${JSON.stringify(token.word)}`);
      break;
    case 'num': {
      // A number followed by a number and `R` is an indirect reference.
      const second = ts.next();
      if (second?.kind !== 'num') {
        if (second) ts.push(second);
        return { kind: 'num', value: token.value };
      }
      const third = ts.next();
      if (third?.kind === 'word' && third.word === 'R')
        return { kind: 'ref', num: token.value };
      if (third) ts.push(third);
      ts.push(second);
      return { kind: 'num', value: token.value };
    }
    case '>>':
    case ']':
      refuse('structure', 'unexpected closing token');
  }
};

interface Use {
  op: 'Do' | 'gs' | 'scn' | 'SCN' | 'Tf';
  name: string;
}

interface StreamTokens {
  ops: number;
  uses: Use[];
}

/** Counts content operators and records the names Do/gs/scn/SCN/Tf draw with. */
const tokenizeContent = (data: Uint8Array): StreamTokens => {
  const ts = new TokenStream(data);
  let ops = 0;
  const uses: Use[] = [];
  let lastName: string | undefined;
  for (;;) {
    const token = ts.next();
    if (!token) break;
    switch (token.kind) {
      // The name a Do/gs/scn/SCN/Tf draws with: the most recent name operand
      // (for Tf the name comes first: `/T3 12 Tf`), other operands leave it.
      case 'name':
        lastName = token.name;
        break;
      case 'num':
      case 'str':
      case 'hex':
      case '[':
      case ']':
      case '<<':
      case '>>':
        break;
      case 'word': {
        const word = token.word;
        if (word === 'true' || word === 'false' || word === 'null') {
          lastName = undefined;
          break;
        }
        ops++;
        // pdf.js adds a dependency operator for the font it sets.
        if (word === 'Tf') ops++;
        if (word === 'BI') {
          ts.pos = skipInlineImage(ts, data);
        } else if (
          (word === 'Do' ||
            word === 'gs' ||
            word === 'scn' ||
            word === 'SCN' ||
            word === 'Tf') &&
          lastName !== undefined
        ) {
          uses.push({ op: word, name: lastName });
        }
        lastName = undefined;
      }
    }
  }
  return { ops, uses };
};

/**
 * After `BI`, reads the name/value header pairs up to `ID`, one whitespace
 * byte, the binary data, and `EI` (the whole thing is one operator, already
 * counted). Returns the position after `EI`.
 */
const skipInlineImage = (ts: TokenStream, data: Uint8Array) => {
  for (;;) {
    const token = ts.next();
    if (!token) refuse('structure', 'unterminated inline image header');
    if (token.kind === 'word' && token.word === 'ID') break;
    if (token.kind !== 'name')
      refuse('structure', 'malformed inline image header');
    const value = ts.next();
    if (!value) refuse('structure', 'unterminated inline image header');
    if (value.kind === '[' || value.kind === '<<') {
      let depth = 1;
      while (depth > 0) {
        const inner = ts.next();
        if (!inner) refuse('structure', 'unterminated inline image header');
        if (inner.kind === '[' || inner.kind === '<<') depth++;
        else if (inner.kind === ']' || inner.kind === '>>') depth--;
      }
    }
  }
  // One whitespace byte after ID, then binary data up to whitespace + EI +
  // (whitespace or end of data).
  let pos = ts.pos;
  if (pos < data.length && isWhite(data[pos] ?? 0)) pos++;
  for (let i = pos; i + 2 < data.length; i++) {
    if (
      isWhite(data[i] ?? 0) &&
      data[i + 1] === 0x45 && // E
      data[i + 2] === 0x49 && // I
      (i + 3 === data.length || isWhite(data[i + 3] ?? 0))
    ) {
      return i + 3;
    }
  }
  refuse('structure', 'unterminated inline image data');
};

// ---------------------------------------------------------------------------
// The scan

interface Nesting {
  /** Operators this stream's content adds, forms inside expanded. */
  cost: number;
  /** Deepest relative nesting reached inside this stream. */
  span: number;
}

/** Add with saturation: budgets refuse long before this number matters. */
const SATURATE = Number.MAX_SAFE_INTEGER / 2;
const satAdd = (a: number, b: number) => (a >= SATURATE - b ? SATURATE : a + b);

const NO_RESOURCES = new Map<string, PdfValue>();

/** The operator list, predicted from the raw bytes. */
class Counter {
  private readonly ts: TokenStream;
  /** xref entries: object number → offset, `null` for free entries. */
  private readonly entries = new Map<number, number | null>();
  private readonly objects = new Map<number, PdfValue>();
  private readonly parsing = new Set<number>();
  private readonly tokens = new Map<number, StreamTokens>();
  private readonly memo = new WeakMap<
    Map<string, PdfValue>,
    Map<number, Nesting>
  >();
  private readonly active = new Set<number>();
  private readonly fontsCounted = new Set<number>();
  private maxDepth = 0;
  private contentBytes = 0;

  private readonly bytes: Uint8Array;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
    this.ts = new TokenStream(bytes);
  }

  async run(): Promise<OperationCount> {
    this.checkHeader();
    const trailer = this.readXref(this.findStartxref());
    this.checkObjectStreams();
    const root = this.resolve(trailer.map.get('Root'));
    const catalog = root?.value;
    if (catalog?.kind !== 'dict')
      refuse('structure', 'the trailer has no readable /Root');
    const pagesNode = this.resolve(catalog.map.get('Pages'));
    const pagesRoot = pagesNode?.value;
    if (pagesRoot?.kind !== 'dict')
      refuse('structure', 'the catalog has no readable /Pages');
    const pages: {
      dict: Map<string, PdfValue>;
      resources: Map<string, PdfValue>;
    }[] = [];
    this.walkPages(pagesRoot, undefined, new Set(), pages);
    if (pages.length === 0) refuse('structure', 'no page found');
    let total = 0;
    for (const page of pages) {
      for (const num of this.contentRefs(page.dict)) {
        total = satAdd(
          total,
          (await this.streamCost(num, page.resources, 0)).cost,
        );
        if (total > maxOperations)
          refuse('operations', `over ${maxOperations} operators`);
      }
      total = satAdd(total, await this.appearanceCost(page));
      if (total > maxOperations)
        refuse('operations', `over ${maxOperations} operators`);
    }
    return {
      ok: true,
      operations: total,
      nesting: this.maxDepth,
      contentBytes: this.contentBytes,
    };
  }

  // -- structure ------------------------------------------------------------

  private checkHeader() {
    const head = Math.min(1024, this.bytes.length);
    for (let i = 0; i + 5 <= head; i++) {
      if (
        this.bytes[i] === 0x25 && // %
        this.bytes[i + 1] === 0x50 && // P
        this.bytes[i + 2] === 0x44 && // D
        this.bytes[i + 3] === 0x46 && // F
        this.bytes[i + 4] === 0x2d // -
      )
        return;
    }
    refuse('structure', 'not a PDF');
  }

  private findStartxref() {
    const bytes = this.bytes;
    const needle = 'startxref';
    const windowStart = Math.max(0, bytes.length - 65_536);
    for (let i = bytes.length - needle.length; i >= windowStart; i--) {
      let match = true;
      for (let j = 0; j < needle.length; j++) {
        if (bytes[i + j] !== needle.charCodeAt(j)) {
          match = false;
          break;
        }
      }
      if (match) {
        this.ts.seek(i + needle.length);
        const token = this.ts.next();
        if (token?.kind !== 'num' || !Number.isInteger(token.value))
          refuse('structure', 'no offset after startxref');
        if (token.value < 0 || token.value >= bytes.length)
          refuse('structure', 'startxref points outside the file');
        return token.value;
      }
    }
    refuse('structure', 'no startxref');
  }

  /** Reads the xref sections from the newest, following /Prev; newer entries win. */
  private readXref(offset: number): { map: Map<string, PdfValue> } {
    const visited = new Set<number>();
    let root: PdfValue | undefined;
    let pos = offset;
    for (;;) {
      if (visited.has(pos)) refuse('structure', 'circular /Prev chain');
      visited.add(pos);
      this.ts.seek(pos);
      const keyword = this.ts.next();
      // An xref stream here is a plain `N G obj`: refused on purpose, its
      // syntax is not read.
      if (keyword?.kind !== 'word' || keyword.word !== 'xref')
        refuse('structure', 'no xref table at the startxref offset');
      for (;;) {
        const head = this.ts.next();
        if (!head) refuse('structure', 'unterminated xref table');
        if (head.kind === 'word' && head.word === 'trailer') break;
        if (head.kind !== 'num')
          refuse('structure', 'malformed xref subsection');
        const count = this.ts.next();
        if (count?.kind !== 'num')
          refuse('structure', 'malformed xref subsection');
        for (let i = 0; i < count.value; i++) {
          const rowOffset = this.ts.next();
          const gen = this.ts.next();
          const flag = this.ts.next();
          if (
            rowOffset?.kind !== 'num' ||
            gen?.kind !== 'num' ||
            flag?.kind !== 'word' ||
            (flag.word !== 'n' && flag.word !== 'f')
          )
            refuse('structure', 'malformed xref entry');
          const num = head.value + i;
          if (!this.entries.has(num))
            this.entries.set(num, flag.word === 'n' ? rowOffset.value : null);
        }
      }
      const trailer = readValue(this.ts, 0);
      if (trailer.kind !== 'dict') refuse('structure', 'no trailer dictionary');
      if (root === undefined) root = trailer.map.get('Root');
      const prev = trailer.map.get('Prev');
      if (prev === undefined) break;
      if (prev.kind !== 'num') refuse('structure', 'bad /Prev in a trailer');
      pos = prev.value;
    }
    if (root === undefined) refuse('structure', 'the trailer has no /Root');
    return { map: new Map([['Root', root]]) };
  }

  /**
   * Any object stream makes the file unreadable for this scan: check the
   * header dictionary of every in-use xref entry (never its stream data, which
   * may spell fake objects or fake types).
   */
  private checkObjectStreams() {
    for (const [num, offset] of this.entries) {
      if (offset === null) continue;
      const value = this.readObjectAt(num, offset, false);
      const map =
        value.kind === 'dict'
          ? value.map
          : value.kind === 'stream'
            ? value.map
            : undefined;
      if (map?.get('Type')?.kind === 'name' && typeName(map) === 'ObjStm')
        refuse('structure', `object ${num} is an object stream`);
    }
  }

  /** Reads the object at a known xref offset; the object cache is used when `cache`. */
  private readObjectAt(num: number, offset: number, cache: boolean): PdfValue {
    this.ts.seek(offset);
    const header = this.ts.next();
    const gen = this.ts.next();
    const keyword = this.ts.next();
    if (
      header?.kind !== 'num' ||
      header.value !== num ||
      gen?.kind !== 'num' ||
      keyword?.kind !== 'word' ||
      keyword.word !== 'obj'
    )
      refuse('structure', `object ${num} not found at its xref offset`);
    const value = readValue(this.ts, 0);
    let result = value;
    if (value.kind === 'dict') {
      const next = this.ts.next();
      if (next?.kind === 'word' && next.word === 'stream') {
        let dataStart = next.end;
        const b = this.bytes;
        if (b[dataStart] === 0x0d)
          dataStart += b[dataStart + 1] === 0x0a ? 2 : 1;
        else if (b[dataStart] === 0x0a) dataStart += 1;
        else refuse('structure', `object ${num}: stream not followed by EOL`);
        result = { kind: 'stream', map: value.map, dataStart };
      } else if (next) {
        this.ts.push(next);
      }
    }
    if (cache) this.objects.set(num, result);
    return result;
  }

  /** Reads and caches object `num`; absent or free entries are `undefined`. */
  private object(num: number): PdfValue | undefined {
    const cached = this.objects.get(num);
    if (cached) return cached;
    const offset = this.entries.get(num);
    if (offset === undefined || offset === null) return undefined;
    if (this.parsing.has(num))
      refuse('structure', `circular reference to ${num}`);
    this.parsing.add(num);
    try {
      return this.readObjectAt(num, offset, true);
    } finally {
      this.parsing.delete(num);
    }
  }

  /** Resolves references to their object (one object, by number if indirect). */
  private resolve(value: PdfValue | undefined): Resolved {
    let num: number | undefined;
    for (let hops = 0; hops < 8; hops++) {
      if (value === undefined) return undefined;
      if (value.kind !== 'ref') return { num, value };
      num = value.num;
      value = this.object(value.num);
    }
    refuse('structure', 'reference chain too long');
  }

  /** A dictionary's `/Resources`, inherited when absent. */
  private resourcesOf(
    value: PdfValue,
    inherited: Map<string, PdfValue> | undefined,
  ) {
    if (value.kind === 'dict' || value.kind === 'stream') {
      const own = this.resolve(value.map.get('Resources'));
      if (own?.value.kind === 'dict') return own.value.map;
    }
    return inherited;
  }

  /** A stream's `/Length`: an integer, or an indirect reference to one. */
  private streamLength(stream: {
    map: Map<string, PdfValue>;
    dataStart: number;
  }) {
    const length = this.resolve(stream.map.get('Length'));
    if (length?.value.kind !== 'num' || !Number.isInteger(length.value.value))
      refuse('structure', 'stream without a readable /Length');
    const value = length.value.value;
    if (value < 0 || stream.dataStart + value > this.bytes.length)
      refuse('structure', 'stream /Length points outside the file');
    return value;
  }

  private walkPages(
    node: PdfValue,
    inheritedResources: Map<string, PdfValue> | undefined,
    stack: Set<object>,
    pages: { dict: Map<string, PdfValue>; resources: Map<string, PdfValue> }[],
  ) {
    if (node.kind !== 'dict')
      refuse('structure', 'page tree node is not a dictionary');
    if (stack.has(node)) refuse('structure', 'cycle in the page tree');
    stack.add(node);
    try {
      const resources = this.resourcesOf(node, inheritedResources);
      const kids = node.map.get('Kids');
      if (kids !== undefined) {
        const array = this.resolve(kids);
        const list = array?.value;
        if (list?.kind !== 'array')
          refuse('structure', 'page tree /Kids is not an array');
        for (const kid of list.items) {
          const child = this.resolve(kid);
          const childNode = child?.value;
          if (childNode?.kind !== 'dict')
            refuse('structure', 'page tree kid is not a dictionary');
          this.walkPages(childNode, resources, stack, pages);
        }
        return;
      }
      const type = node.map.get('Type');
      if (
        (type?.kind === 'name' && type.name === 'Page') ||
        node.map.has('Contents')
      ) {
        pages.push({ dict: node.map, resources: resources ?? NO_RESOURCES });
        return;
      }
      refuse('structure', 'page tree node is neither /Pages nor /Page');
    } finally {
      stack.delete(node);
    }
  }

  /** A page's /Contents: one stream or an array of them. */
  private contentRefs(dict: Map<string, PdfValue>) {
    const contents = dict.get('Contents');
    if (contents === undefined) return [];
    const value = this.resolve(contents);
    if (value === undefined) return [];
    const resolved = value.value;
    if (resolved.kind === 'stream')
      return value.num === undefined ? [] : [value.num];
    if (resolved.kind !== 'array')
      refuse('structure', 'page /Contents is not a stream or an array');
    return resolved.items.map(item => {
      const ref = this.resolve(item);
      if (ref?.value.kind !== 'stream' || ref.num === undefined)
        refuse('structure', 'page /Contents array holds a non-stream');
      return ref.num;
    });
  }

  // -- counting ---------------------------------------------------------------

  private noteDepth(depth: number) {
    if (depth > maxNesting) refuse('nesting', `nesting past ${maxNesting}`);
    if (depth > this.maxDepth) this.maxDepth = depth;
  }

  private async streamCost(
    num: number,
    resources: Map<string, PdfValue>,
    depth: number,
  ): Promise<Nesting> {
    this.noteDepth(depth);
    let forResources = this.memo.get(resources);
    const known = forResources?.get(num);
    if (known) {
      // A subtree reused deeper down still nests as deep as its own span here.
      this.noteDepth(depth + known.span);
      return known;
    }
    if (this.active.has(num))
      refuse(
        'structure',
        `object ${num} draws itself, directly or through others`,
      );
    const object = this.object(num);
    if (object?.kind !== 'stream')
      refuse('structure', `content object ${num} is not a stream`);
    const stream: { map: Map<string, PdfValue>; dataStart: number } = object;
    this.active.add(num);
    try {
      const tokens = await this.streamTokens(num, stream);
      let cost = tokens.ops;
      let span = 0;
      for (const use of tokens.uses) {
        const nested = await this.useCost(use, resources, depth);
        cost = satAdd(cost, nested.cost);
        if (nested.span > span) span = nested.span;
      }
      const result = { cost, span };
      forResources = forResources ?? new Map<number, Nesting>();
      if (!this.memo.has(resources)) this.memo.set(resources, forResources);
      forResources.set(num, result);
      return result;
    } finally {
      this.active.delete(num);
    }
  }

  /** The extra cost of the resource a `Do`/`gs`/`scn`/`SCN`/`Tf` names. */
  private async useCost(
    use: Use,
    resources: Map<string, PdfValue>,
    depth: number,
  ): Promise<Nesting> {
    const zero = { cost: 0, span: 0 };
    const lookup = (key: string): Resolved => {
      const dict = this.resolve(resources.get(key));
      if (dict?.value.kind !== 'dict') return undefined;
      return this.resolve(dict.value.map.get(use.name));
    };
    const nestedForm = async (
      num: number,
      value: PdfValue,
    ): Promise<Nesting> => {
      const inside = await this.streamCost(
        num,
        this.resourcesOf(value, resources) ?? resources,
        depth + 1,
      );
      return { cost: satAdd(4, inside.cost), span: inside.span + 1 };
    };
    switch (use.op) {
      case 'Do': {
        const target = lookup('XObject');
        if (
          target?.value.kind === 'stream' &&
          target.num !== undefined &&
          nameOf(target.value.map.get('Subtype')) === 'Form'
        )
          return nestedForm(target.num, target.value);
        // pdf.js adds a dependency operator before the image it paints.
        if (target?.value.kind === 'stream') return { cost: 1, span: 0 };
        return zero;
      }
      case 'gs': {
        const state = lookup('ExtGState');
        if (state?.value.kind !== 'dict') return zero;
        const mask = this.resolve(state.value.map.get('SMask'));
        if (mask === undefined || mask.value.kind === 'name') return zero;
        if (mask.value.kind !== 'dict') return zero;
        const group = this.resolve(mask.value.map.get('G'));
        if (group?.value.kind !== 'stream' || group.num === undefined)
          return zero;
        return nestedForm(group.num, group.value);
      }
      case 'scn':
      case 'SCN': {
        const pattern = lookup('Pattern');
        if (pattern?.value.kind !== 'stream' || pattern.num === undefined)
          return zero;
        const type = pattern.value.map.get('PatternType');
        if (type?.kind !== 'num' || type.value !== 1) return zero;
        return nestedForm(pattern.num, pattern.value);
      }
      case 'Tf': {
        const font = lookup('Font');
        if (
          font?.value.kind !== 'dict' ||
          font.num === undefined ||
          nameOf(font.value.map.get('Subtype')) !== 'Type3' ||
          this.fontsCounted.has(font.num)
        )
          return zero;
        this.fontsCounted.add(font.num);
        const inside = this.resourcesOf(font.value, resources) ?? resources;
        const procs = this.resolve(font.value.map.get('CharProcs'));
        if (procs?.value.kind !== 'dict') return zero;
        let cost = 0;
        let span = 0;
        for (const proc of procs.value.map.values()) {
          const stream = this.resolve(proc);
          if (stream?.value.kind !== 'stream' || stream.num === undefined)
            continue;
          const counted = await this.streamCost(stream.num, inside, depth + 1);
          cost = satAdd(cost, counted.cost);
          if (counted.span + 1 > span) span = counted.span + 1;
        }
        return { cost, span };
      }
    }
  }

  /** Annotation appearances: each /N, /D, /R entry at nesting 1. */
  private async appearanceCost(page: {
    dict: Map<string, PdfValue>;
    resources: Map<string, PdfValue>;
  }) {
    let total = 0;
    const annots = this.resolve(page.dict.get('Annots'));
    if (annots?.value.kind !== 'array') return 0;
    for (const item of annots.value.items) {
      const annot = this.resolve(item);
      if (annot?.value.kind !== 'dict') continue;
      const ap = this.resolve(annot.value.map.get('AP'));
      if (ap?.value.kind !== 'dict') continue;
      for (const state of ['N', 'D', 'R']) {
        const appearance = this.resolve(ap.value.map.get(state));
        const streams: { num: number; value: PdfValue }[] = [];
        if (appearance?.value.kind === 'stream' && appearance.num !== undefined)
          streams.push({ num: appearance.num, value: appearance.value });
        if (appearance?.value.kind === 'dict') {
          for (const variant of appearance.value.map.values()) {
            const stream = this.resolve(variant);
            if (stream?.value.kind === 'stream' && stream.num !== undefined)
              streams.push({ num: stream.num, value: stream.value });
          }
        }
        for (const stream of streams) {
          const counted = await this.streamCost(
            stream.num,
            this.resourcesOf(stream.value, page.resources) ?? page.resources,
            1,
          );
          total = satAdd(total, satAdd(4, counted.cost));
        }
      }
    }
    return total;
  }

  // -- decoding ---------------------------------------------------------------

  /** Decodes (once per object) and tokenizes a content stream. */
  private async streamTokens(
    num: number,
    object: { map: Map<string, PdfValue>; dataStart: number },
  ): Promise<StreamTokens> {
    const cached = this.tokens.get(num);
    if (cached) return cached;
    const length = this.streamLength(object);
    const end = object.dataStart + length;
    if (end > this.bytes.length)
      refuse('structure', `stream ${num} runs past the end of the file`);
    const filter = this.resolve(object.map.get('Filter'));
    let data: Uint8Array;
    if (filter === undefined) {
      this.account(length);
      data = this.bytes.subarray(object.dataStart, end);
    } else {
      const names = filterNames(filter.value);
      if (
        names === undefined ||
        names.length !== 1 ||
        names[0] !== 'FlateDecode'
      )
        refuse('structure', `stream ${num} has an unsupported /Filter`);
      const predictor = this.resolve(object.map.get('DecodeParms'));
      refuseOnPredictor(predictor?.value);
      data = await this.inflate(
        this.bytes.subarray(object.dataStart, end),
        num,
      );
    }
    const tokens = tokenizeContent(data);
    this.tokens.set(num, tokens);
    return tokens;
  }

  private account(bytes: number) {
    if (this.contentBytes + bytes > maxContentBytes)
      refuse('content', `decoded content over ${maxContentBytes} bytes`);
    this.contentBytes += bytes;
  }

  private async inflate(data: Uint8Array, num: number): Promise<Uint8Array> {
    // A copy: Blob takes only ArrayBuffer-backed views (workers types).
    const stream = new Blob([data.slice()])
      .stream()
      .pipeThrough(new DecompressionStream('deflate'));
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (this.contentBytes + length > maxContentBytes)
          refuse('content', `decoded content over ${maxContentBytes} bytes`);
        chunks.push(value);
      }
    } catch (error) {
      if (error instanceof Refused) throw error;
      refuse(
        'structure',
        `stream ${num}: bad FlateDecode data: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    this.contentBytes += length;
    const out = new Uint8Array(length);
    for (let at = 0, i = 0; i < chunks.length; i++) {
      out.set(chunks[i] ?? new Uint8Array(), at);
      at += chunks[i]?.byteLength ?? 0;
    }
    return out;
  }
}

const typeName = (map: Map<string, PdfValue>): string | undefined =>
  nameOf(map.get('Type'));

const nameOf = (value: PdfValue | undefined): string | undefined =>
  value?.kind === 'name' ? value.name : undefined;

/** `/Filter`: a name, or an array (only a one-name array is readable here). */
const filterNames = (value: PdfValue): string[] | undefined => {
  if (value.kind === 'name') return [value.name];
  if (value.kind === 'array')
    return value.items.map(item => nameOf(item) ?? '');
  return undefined;
};

/** Any /DecodeParms entry with /Predictor > 1 leaves bytes this scan can't read. */
const refuseOnPredictor = (value: PdfValue | undefined) => {
  const dicts =
    value?.kind === 'dict'
      ? [value]
      : value?.kind === 'array'
        ? value.items.filter(
            (item): item is Extract<PdfValue, { kind: 'dict' }> =>
              item.kind === 'dict',
          )
        : [];
  for (const dict of dicts) {
    const predictor = dict.map.get('Predictor');
    if (predictor?.kind === 'num' && predictor.value > 1)
      refuse('structure', 'a /DecodeParms /Predictor over 1');
  }
};

/** Counts the operators pdf.js will produce for `pdf`, or says which limit refuses it. */
export async function countOperations(
  pdf: Uint8Array,
): Promise<OperationCount> {
  try {
    return await new Counter(pdf).run();
  } catch (error) {
    if (error instanceof Refused)
      return { ok: false, limit: error.limit, reason: error.message };
    return {
      ok: false,
      limit: 'structure',
      reason: `cannot read the PDF: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
