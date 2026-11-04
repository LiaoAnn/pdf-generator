// Chromium prints a repeating-linear-gradient() or a
// repeating-radial-gradient() as a function-based PDF shading, which
// pdf.js — the self-check's renderer — misreads: a linear one samples
// once per stripe, so the printed stripes read as solid black or blank
// (T14-11), and T10-5 measured the radial form misread the same way
// (pdf.js 0.31 ink vs PDFium's 0.50, its rings a scrambled pattern), so
// the ground truth no longer matches either way (T06-14). The upload
// check refuses both tokens wherever the print reads CSS (T06-12; the
// issue is raised at the call site, in assets.ts, which hands this
// finder every such CSS text).
//
// One linear pass, strings, comments and unquoted url() content skipped —
// csstree.tokenize cannot stand in: its balance-table fill walks from an
// opener to each closing bracket, so its cost grows with nesting depth
// (~2 s on 40,000 balanced var() pairs, where the flat scan below is
// milliseconds). Offsets are into the CSS text as given, so issues point
// at the source as written.

/** CSS whitespace: not the no-break space or other Unicode spaces. */
const cssSpace = /[ \t\n\r\f]/;

/** A name character (letters, digits, `-`, `_`, non-ASCII), as in CSS. */
const nameChar = /[a-zA-Z0-9_\-\u0080-\uffff]/;

/** A newline in CSS: CR and FF end a line as LF does. */
const newline = /[\n\r\f]/;

/** A hex digit, as "consume an escaped code point" reads one. */
const isHexDigit = (code: number) =>
  (code >= 0x30 && code <= 0x39) ||
  (code >= 0x41 && code <= 0x46) ||
  (code >= 0x61 && code <= 0x66);

/**
 * The whitespace one escape consumes after its hex digits: space, tab, LF,
 * FF, and CR LF as one (css syntax "consume as much whitespace as
 * possible", where CR LF is one newline).
 */
const newlineLength = (text: string, at: number) => {
  const code = text.charCodeAt(at);
  if (code === 0x0d) return text.charCodeAt(at + 1) === 0x0a ? 2 : 1;
  return [0x20, 0x09, 0x0a, 0x0c].includes(code) ? 1 : 0;
};

/**
 * The identifier the CSS parser reads for the raw name as written: every
 * backslash consumed per CSS Syntax 3 "consume an escaped code point" — one
 * to six hex digits and one optional whitespace give that code point (0,
 * surrogates and beyond 0x10FFFF give U+FFFD), anything else is the escaped
 * character itself.
 */
const unescapeName = (raw: string): string => {
  let name = '';
  let i = 0;
  while (i < raw.length) {
    if (raw.charCodeAt(i) !== 0x5c) {
      name += raw[i] ?? '';
      i++;
      continue;
    }
    let digits = 0;
    let value = 0;
    while (
      i + 1 < raw.length &&
      digits < 6 &&
      isHexDigit(raw.charCodeAt(i + 1))
    ) {
      value = value * 16 + Number.parseInt(raw.charAt(i + 1), 16);
      digits++;
      i++;
    }
    if (digits > 0) {
      i += 1 + newlineLength(raw, i + 1);
      name += String.fromCodePoint(
        value === 0 || value > 0x10ffff || (value >= 0xd800 && value <= 0xdfff)
          ? 0xfffd
          : value,
      );
    } else {
      i += 2;
      name += raw[i - 1] ?? '';
    }
  }
  return name;
};

/**
 * ASCII case folding only (A—Z → a—z): the function name is ASCII, and a
 * full Unicode fold (toLowerCase) could turn a different name into it.
 */
const foldCase = (name: string) =>
  name.replace(/[A-Z]/g, char => char.toLowerCase());

// T06-14: T10-5 measured repeating-radial-gradient misread the same way.
/** The function names the upload refuses, vendor prefix included. */
const repeatingGradient = /^(?:-[a-z]+-)?repeating-(?:linear|radial)-gradient$/;

/**
 * The index after the escape that starts at `at` (css[at] is `\` and the
 * next character is not a newline): one to six hex digits and one optional
 * whitespace, else the one escaped character.
 */
const escapedEnd = (text: string, at: number): number => {
  let digits = 0;
  while (digits < 6 && isHexDigit(text.charCodeAt(at + 1 + digits))) digits++;
  return digits > 0
    ? at + 1 + digits + newlineLength(text, at + 1 + digits)
    : at + 2;
};

/**
 * The offset of each repeating-linear-gradient( or
 * repeating-radial-gradient( function in `css`, vendor-prefixed or not,
 * in either case, escapes in the name included. Function tokens only:
 * the name inside a comment or string, or not followed immediately by
 * `(`, is not a function and never matches.
 */
export function repeatingGradients(css: string): number[] {
  const offsets: number[] = [];
  let i = 0;
  while (i < css.length) {
    const c = css[i] ?? '';
    if (c === '/' && css[i + 1] === '*') {
      const end = css.indexOf('*/', i + 2);
      i = end < 0 ? css.length : end + 2;
    } else if (c === '"' || c === "'") {
      let end = i + 1;
      // CR and form feed end a line in CSS as LF does; \" stays inside.
      while (
        end < css.length &&
        css[end] !== c &&
        !newline.test(css[end] ?? '')
      ) {
        if (css[end] === '\\') end++;
        end++;
      }
      i = end + 1;
    } else if (
      nameChar.test(c) ||
      (c === '\\' && !newline.test(css[i + 1] ?? '\n'))
    ) {
      const start = i;
      // A name runs over name characters and valid escapes.
      if (c === '\\') {
        i = escapedEnd(css, i);
      } else {
        i++;
      }
      while (i < css.length) {
        const next = css[i] ?? '';
        if (nameChar.test(next)) {
          i++;
          continue;
        }
        if (next === '\\' && !newline.test(css[i + 1] ?? '\n')) {
          i = escapedEnd(css, i);
          continue;
        }
        break;
      }
      if (css[i] !== '(') continue;
      const name = foldCase(unescapeName(css.slice(start, i)));
      if (name === 'url') {
        // An unquoted url()'s text is one token: a gradient-looking name in
        // it is bad-url content (or bad-url remnants after whitespace), not
        // a function. A quoted url( is a function; its string is skipped
        // above on the next pass.
        let at = i + 1;
        while (cssSpace.test(css[at] ?? '')) at++;
        if (css[at] !== '"' && css[at] !== "'") {
          while (at < css.length && css[at] !== ')') {
            if (css[at] === '\\') at++;
            at++;
          }
          i = at + 1;
        }
        continue;
      }
      if (repeatingGradient.test(name)) offsets.push(start);
    } else {
      i++;
    }
  }
  return offsets;
}
