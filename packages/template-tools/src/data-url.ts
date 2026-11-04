// T06-13: a data:image/svg+xml URL inside an SVG image renders (Chrome
// decodes the URL and reads it as an SVG document), so the check decodes it
// as Chrome's URL and fetch code do and reads it too. `url` here is already
// the URL parser's view: ASCII tab, LF and CR removed, C0 controls and
// spaces trimmed from the ends (urls.ts's urlParserView does that).
// Everything is one left-to-right pass: percent-decode and base64-decode
// scan byte by byte, so a crafted URL stays linear.
import { decode } from './text.ts';

/** An encoding problem, with its message; `text` when the decode worked. */
export type DataImageSvg = { text: string } | { encoding: string } | undefined;

/** ASCII whitespace (what base64 and a MIME header may space with). */
const asciiWs = (byte: number) =>
  byte === 0x20 || (byte >= 0x09 && byte <= 0x0d);

/** The base64 alphabet, -1 elsewhere (whitespace was already removed). */
const base64Value = (byte: number) =>
  byte >= 0x41 && byte <= 0x5a
    ? byte - 0x41
    : byte >= 0x61 && byte <= 0x7a
      ? byte - 0x61 + 26
      : byte >= 0x30 && byte <= 0x39
        ? byte - 0x30 + 52
        : byte === 0x2b
          ? 62
          : byte === 0x2f
            ? 63
            : -1;

/**
 * Forgiving base64, as the fetch spec decodes it: ASCII whitespace removed,
 * then up to two `=` of padding when the length is 0 mod 4; a length of 1
 * mod 4 or any other non-alphabet byte fails (Chrome then renders nothing, so the caller gets `undefined`).
 */
function base64Decode(bytes: Uint8Array): Uint8Array | undefined {
  // Whitespace first, then padding: "AB= =" is "AB==".
  const clean = new Uint8Array(bytes.length);
  let length = 0;
  for (const byte of bytes) {
    if (!asciiWs(byte)) clean[length++] = byte;
  }
  if (length % 4 === 0) {
    for (let pad = 0; pad < 2 && clean[length - 1] === 0x3d; pad++) length--;
  }
  if (length % 4 === 1) return undefined;
  const out = new Uint8Array(length - Math.floor(length / 4));
  let at = 0;
  let acc = 0;
  let bits = 0;
  for (let i = 0; i < length; i++) {
    const value = base64Value(clean[i] ?? 0);
    if (value < 0) return undefined;
    acc = (acc << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[at++] = (acc >> bits) & 0xff;
    }
  }
  return out.subarray(0, at);
}

const hexDigit = (byte: number) =>
  byte >= 0x30 && byte <= 0x39
    ? byte - 0x30
    : byte >= 0x41 && byte <= 0x46
      ? byte - 0x41 + 10
      : byte >= 0x61 && byte <= 0x66
        ? byte - 0x61 + 10
        : -1;

/** Percent-decode bytes: %XX with two hex digits; a stray % stays. */
function percentDecode(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(bytes.length);
  let at = 0;
  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes[i] ?? 0;
    if (byte === 0x25 && i + 2 < bytes.length) {
      const high = hexDigit(bytes[i + 1] ?? 0);
      const low = hexDigit(bytes[i + 2] ?? 0);
      if (high >= 0 && low >= 0) {
        out[at++] = (high << 4) | low;
        i += 2;
        continue;
      }
    }
    out[at++] = byte;
  }
  return out.subarray(0, at);
}

/** The string as bytes (UTF-8), then percent-decoded. */
function bodyBytes(body: string): Uint8Array {
  return percentDecode(new TextEncoder().encode(body));
}

/**
 * The text a data:image/svg+xml URL decodes to, as Chrome's fetch code
 * decodes it; undefined when it isn't one Chrome would render as an SVG
 * image (another MIME type, no comma, undecodable base64 — Chrome renders
 * nothing then). `encoding` (a message half-sentence) when the bytes stand
 * for text the check cannot count on: a charset other than UTF-8, or bytes
 * that aren't UTF-8 at all.
 */
export function dataImageSvgText(url: string): DataImageSvg {
  // ASCII case-insensitive scheme, as the URL parser normalizes it.
  if (url.slice(0, 5).toLowerCase() !== 'data:') return undefined;
  // The fragment is cut at the first #; the rest never reaches the decoder.
  const cut = url.indexOf('#', 5);
  const resource = cut < 0 ? url : url.slice(0, cut);
  const comma = resource.indexOf(',', 5);
  if (comma < 0) return undefined;
  const header = resource.slice(5, comma).trim();
  const semicolon = header.indexOf(';');
  // The MIME essence: the part before the first ;, case-insensitive.
  const essence = (semicolon < 0 ? header : header.slice(0, semicolon))
    .trim()
    .toLowerCase();
  if (essence !== 'image/svg+xml') return undefined;
  // base64 when the header ends in ";base64" (spaces allowed before it).
  const lower = header.toLowerCase();
  const base64 =
    lower.endsWith('base64') &&
    lower
      .slice(0, lower.length - 'base64'.length)
      .trimEnd()
      .endsWith(';');
  let i = semicolon;
  while (i >= 0) {
    const end = header.indexOf(';', i + 1);
    const parameter = header.slice(i + 1, end < 0 ? header.length : end);
    const equals = parameter.indexOf('=');
    const name = (equals < 0 ? parameter : parameter.slice(0, equals))
      .trim()
      .toLowerCase();
    if (name === 'charset') {
      let value = (equals < 0 ? '' : parameter.slice(equals + 1)).trim();
      const first = value[0];
      if (
        value.length >= 2 &&
        (first === '"' || first === "'") &&
        value.endsWith(first)
      ) {
        value = value.slice(1, -1);
      }
      if (value.toLowerCase() !== 'utf-8' && value.toLowerCase() !== 'utf8') {
        return {
          encoding: `declares charset "${value}": the check reads an SVG as UTF-8; drop the charset parameter`,
        };
      }
    }
    i = end;
  }
  let bytes = bodyBytes(resource.slice(comma + 1));
  if (base64) {
    const decoded = base64Decode(bytes);
    if (decoded === undefined) return undefined;
    bytes = decoded;
  }
  const text = decode(bytes);
  if (text === undefined) {
    return {
      encoding:
        'the body is not valid UTF-8: the check reads an SVG as UTF-8 text',
    };
  }
  return { text };
}
