// Splits a platform font Chrome's batch cache can't keep (over about
// 6.25 MiB, T07-37) into unicode-range chunks under 6 MiB it can. Uses the
// hb-subset WASM of the harfbuzzjs devDependency (Node only: the font build
// and its tests, never the Worker bundle). `keep_everything` keeps every
// table, metric and name record of the source, and the glyph set is cleared
// again so only the chunk's own code points drive the closure: a chunk
// prints each of its code points exactly as the whole font does.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { readCmap } from './sfnt.ts';

/** One chunk of a split font: its file name, CSS unicode-range and bytes. */
export interface FontChunk {
  file: string;
  unicodeRange: string;
  font: Uint8Array;
}

/** The subset exports of harfbuzz-subset.wasm this uses. */
interface Subset {
  memory: WebAssembly.Memory;
  _initialize?: () => void;
  malloc(size: number): number;
  free(ptr: number): void;
  hb_blob_create(
    data: number,
    length: number,
    mode: number,
    userData: number,
    destroy: number,
  ): number;
  hb_blob_destroy(blob: number): void;
  hb_blob_get_data(blob: number, length: number): number;
  hb_blob_get_length(blob: number): number;
  hb_face_create(blob: number, index: number): number;
  hb_face_destroy(face: number): void;
  hb_face_reference_blob(face: number): number;
  hb_set_add(set: number, codePoint: number): void;
  hb_set_clear(set: number): void;
  hb_subset_input_create_or_fail(): number;
  hb_subset_input_destroy(input: number): void;
  hb_subset_input_keep_everything(input: number): void;
  hb_subset_input_set(input: number, setType: number): number;
  hb_subset_input_unicode_set(input: number): number;
  hb_subset_or_fail(face: number, input: number): number;
}

// The fixed chunk plan (T07-37): ideographs are U+3400–4DBF, U+4E00–9FFF,
// U+F900–FAFF and U+20000–3FFFF; part0 takes everything else, part1–part3
// split the ideographs. The ranges together partition Unicode.
const plan = [
  'U+0-33FF, U+4DC0-4DFF, U+A000-F8FF, U+FB00-1FFFF, U+40000-10FFFF',
  'U+3400-4DBF, U+4E00-69FF',
  'U+6A00-87FF',
  'U+8800-9FFF, U+F900-FAFF, U+20000-3FFFF',
] as const;

function parseUnicodeRange(unicodeRange: string): [number, number][] {
  return unicodeRange.split(',').map(part => {
    const match = /^\s*U\+([0-9A-F]+)(?:-([0-9A-F]+))?\s*$/i.exec(part);
    if (!match) throw new Error(`bad unicode-range part ${part}`);
    const start = Number.parseInt(match[1] as string, 16);
    return [start, Number.parseInt(match[2] ?? (match[1] as string), 16)];
  });
}

// ESNext lib types WebAssembly.Module/Instance as abstract; constructible.
const { Module, Instance } = WebAssembly as unknown as {
  Module: new (bytes: BufferSource) => WebAssembly.Module;
  Instance: new (
    module: WebAssembly.Module,
    imports: object,
  ) => WebAssembly.Instance;
};

const require = createRequire(import.meta.url);
const wasmPath = require.resolve('harfbuzzjs/dist/harfbuzz-subset.wasm');
let compiled: WebAssembly.Module | undefined;
function wasmModule(): WebAssembly.Module {
  compiled ??= new Module(readFileSync(wasmPath));
  return compiled;
}

// One subset run. The WASM's memory is a fixed 65 MiB, so each run gets a
// fresh instance; it is simply dropped afterwards (nothing outlives it).
function subset(
  module: WebAssembly.Module,
  font: Uint8Array,
  codePoints: readonly number[],
  file: string,
): Uint8Array {
  const instance = new Instance(module, {});
  const hb = instance.exports as unknown as Subset;
  hb._initialize?.();
  const heap = new Uint8Array(hb.memory.buffer);
  const ptr = hb.malloc(font.length);
  if (ptr === 0) throw new Error(`${file}: malloc(${font.length}) failed`);
  heap.set(font, ptr);
  const blob = hb.hb_blob_create(ptr, font.length, 2 /* readonly */, 0, 0);
  const face = hb.hb_face_create(blob, 0);
  const input = hb.hb_subset_input_create_or_fail();
  hb.hb_subset_input_keep_everything(input);
  // keep_everything fills the glyph-id set; clear it so only the unicode
  // set below drives the subset.
  hb.hb_set_clear(hb.hb_subset_input_set(input, 0));
  const unicode = hb.hb_subset_input_unicode_set(input);
  hb.hb_set_clear(unicode);
  for (const cp of codePoints) hb.hb_set_add(unicode, cp);
  const out = hb.hb_subset_or_fail(face, input);
  if (out === 0) throw new Error(`${file}: hb_subset_or_fail failed`);
  const outBlob = hb.hb_face_reference_blob(out);
  const length = hb.hb_blob_get_length(outBlob);
  const data = hb.hb_blob_get_data(outBlob, 0);
  const bytes = heap.slice(data, data + length); // a copy, not a view
  hb.hb_face_destroy(out);
  hb.hb_subset_input_destroy(input);
  hb.hb_face_destroy(face);
  hb.hb_blob_destroy(blob);
  hb.free(ptr);
  return bytes;
}

/**
 * Splits `font` (named `file`) into the four unicode-range chunks of the
 * fixed plan, each holding exactly the source's code points in its range.
 * A chunk of `maxBytes` or more (default 6 MiB, under Chrome's 6.25 MiB
 * cache floor) throws, naming its file.
 */
export async function splitFont(
  font: Uint8Array,
  file: string,
  { maxBytes = 6 * 1024 * 1024 }: { maxBytes?: number } = {},
): Promise<FontChunk[]> {
  const codePoints = [...readCmap(font).keys()].sort((a, b) => a - b);
  const module = wasmModule();
  return plan.map((unicodeRange, part) => {
    const chunkFile = file.replace(/(\.[^.]*)$/, `.part${part}$1`);
    const ranges = parseUnicodeRange(unicodeRange);
    const own = codePoints.filter(cp =>
      ranges.some(([start, end]) => cp >= start && cp <= end),
    );
    const bytes = subset(module, font, own, chunkFile);
    if (bytes.length >= maxBytes) {
      throw new Error(
        `${chunkFile}: ${bytes.length} bytes, at or over the ${maxBytes}-byte limit`,
      );
    }
    return { file: chunkFile, unicodeRange, font: bytes };
  });
}
