// Counting how many stylesheets a pack's @imports would load: Chrome and
// Paged.js load an imported sheet again for every @import of it, so the
// import graph expands far past the pack's files — a ladder of 20 sheets,
// each importing the next twice, is 2^20 loads and stalls Chrome before the
// print can time out (T07-29). The upload check refuses such a pack.

/**
 * The limits: the 6 templates load 1–2 sheets and ≤ 23 KB with no @import;
 * uploads cap text at 64 KB a file and 256 KB a pack, so only repetition
 * gets past 1 MiB; T07-29 measured 23 loads of a 1 MiB sheet at 15 s and
 * 250 loads of 90 KB at 23 s, and a 20-deep ladder (2^20 loads) stalls
 * Chrome.
 */
export const maxStylesheetLoads = 64;
export const maxStylesheetBytes = 1024 * 1024;

type Imports = { source: { file: string }; path: string }[];

/**
 * The stylesheet loads and CSS bytes the pack's @imports expand to, from
 * the references in `roots` (manifest styles in manifest order, then the
 * template's <link> and <style> imports in document order); `bytesOf` is a
 * file's UTF-8 byte length. A root in `repeating` sits in an {{#each}} of
 * the template, so it loads once per item, without a limit the check can
 * count: it is counted as past the load limit. Undefined while the totals
 * stay within the limits; otherwise the totals and the root that expands
 * the most (a repeating root first, else by loads when the load count is
 * over, else by bytes; ties go to the earliest root).
 */
export function importExpansion(
  roots: string[],
  imports: Imports,
  bytesOf: (path: string) => number,
  repeating: ReadonlySet<string>,
): { loads: number; bytes: number; file: string } | undefined {
  const out = new Map<string, string[]>();
  for (const { source, path } of imports) {
    const targets = out.get(source.file);
    if (targets === undefined) out.set(source.file, [path]);
    else targets.push(path);
  }
  // loads(f) = 1 + Σ over f's @imports of loads(target). Walking every
  // expanded path would never finish (a 40-deep ladder is 2^40 loads), so
  // counts are memoized per file and capped just past the limits, and an
  // import back onto the walk's own stack — a cycle, reported on its own —
  // loads nothing more here.
  const memo = new Map<string, { loads: number; bytes: number }>();
  const visiting = new Set<string>();
  const expand = (file: string): { loads: number; bytes: number } => {
    const counted = memo.get(file);
    if (counted !== undefined) return counted;
    if (visiting.has(file)) return { loads: 0, bytes: 0 };
    visiting.add(file);
    let loads = 1;
    let bytes = bytesOf(file);
    for (const target of out.get(file) ?? []) {
      const expanded = expand(target);
      loads += expanded.loads;
      bytes += expanded.bytes;
    }
    visiting.delete(file);
    const capped = {
      loads: Math.min(loads, maxStylesheetLoads + 1),
      bytes: Math.min(bytes, maxStylesheetBytes + 1),
    };
    memo.set(file, capped);
    return capped;
  };
  let loads = 0;
  let bytes = 0;
  // Summed per root file: a sheet the template loads over and over is the
  // one to name, though each of its loads is small.
  const perRoot = new Map<string, { loads: number; bytes: number }>();
  for (const root of roots) {
    const expanded = expand(root);
    // A root inside {{#each}} would load once per item when the template is
    // filled, far past any limit: count it as just past it.
    const loadsOf = repeating.has(root)
      ? maxStylesheetLoads + 1
      : expanded.loads;
    loads += loadsOf;
    bytes += expanded.bytes;
    const sum = perRoot.get(root) ?? { loads: 0, bytes: 0 };
    perRoot.set(root, {
      loads: sum.loads + loadsOf,
      bytes: sum.bytes + expanded.bytes,
    });
  }
  if (loads <= maxStylesheetLoads && bytes <= maxStylesheetBytes) {
    return undefined;
  }
  const byLoads = loads > maxStylesheetLoads;
  let file: string | undefined;
  let most = -1;
  let namedRepeats = false;
  // A repeating root is the one to name, even when another root expands to
  // more; among the rest, the largest expansion. Map order is
  // first-reference order, so ties go to the earliest root.
  for (const [root, sum] of perRoot) {
    const value = byLoads ? sum.loads : sum.bytes;
    const repeats = repeating.has(root);
    if (
      (repeats && !namedRepeats) ||
      (repeats === namedRepeats && value > most)
    ) {
      most = value;
      file = root;
      namedRepeats = repeats;
    }
  }
  return { loads, bytes, file: file ?? '' };
}
