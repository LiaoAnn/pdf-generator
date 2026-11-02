// compare-gt: compares two dump-gt output folders (see dump-gt.ts) and
// reports every changed fixture, block, table cell and self-check, then the
// counts. A fixture is matched by its '<template>/<NNNN>' key; identical
// means gt.json equal as JSON values (object key order and
// source.templateVersion ignored) and check.json equal. The report is
// deterministic: fixtures sorted by template then index, blocks in the
// fixture's own array order, cells sorted by row then column. The CLI entry
// point is compare-gt-cli.ts.
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface CompareResult {
  /** Report lines, without the trailing newline. */
  lines: string[];
  /** True when anything differed (exit 1). */
  different: boolean;
}

interface FixtureData {
  gt: Record<string, unknown>;
  check: unknown;
}

/// JSON helpers: equality ignoring object key order, and JSON.stringify of
/// a key-sorted copy (arrays keep their order), without spaces.
function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (
    typeof a !== 'object' ||
    typeof b !== 'object' ||
    a === null ||
    b === null
  )
    return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((item, i) => jsonEqual(item, b[i]))
    );
  }
  const aKeys = Object.keys(a as Record<string, unknown>);
  const bKeys = Object.keys(b as Record<string, unknown>);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every(
    key =>
      Object.hasOwn(b, key) &&
      jsonEqual(
        (a as Record<string, unknown>)[key],
        (b as Record<string, unknown>)[key],
      ),
  );
}

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => [key, sorted(item)]),
    );
  }
  return value;
}

const json = (value: unknown): string => JSON.stringify(sorted(value));

const value = (v: unknown): string => (v === undefined ? 'none' : json(v));

/** A gt.json clone without source.templateVersion (re-uploads bump it). */
function normalizeGt(gt: Record<string, unknown>): Record<string, unknown> {
  const source = gt.source;
  if (typeof source !== 'object' || source === null) return gt;
  const { templateVersion: _, ...rest } = source as Record<string, unknown>;
  return { ...gt, source: rest };
}

/** Every '<template>/<NNNN>' fixture folder that holds a gt.json. */
async function loadFixtures(dir: string): Promise<Map<string, FixtureData>> {
  const fixtures = new Map<string, FixtureData>();
  const templates = await readdir(dir, { withFileTypes: true }).catch(
    () => undefined,
  );
  if (templates === undefined) {
    throw new Error(`error: folder does not exist: ${dir}`);
  }
  for (const template of templates.sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  )) {
    if (!template.isDirectory()) continue;
    const sub = await readdir(join(dir, template.name), {
      withFileTypes: true,
    });
    for (const entry of sub.sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    )) {
      if (!entry.isDirectory()) continue;
      const folder = join(dir, template.name, entry.name);
      const gtText = await readFile(join(folder, 'gt.json'), 'utf8').catch(
        () => undefined,
      );
      if (gtText === undefined) continue;
      const checkText = await readFile(
        join(folder, 'check.json'),
        'utf8',
      ).catch(() => undefined);
      fixtures.set(`${template.name}/${entry.name}`, {
        gt: JSON.parse(gtText) as Record<string, unknown>,
        check: checkText === undefined ? null : JSON.parse(checkText),
      });
    }
  }
  return fixtures;
}

async function loadSummary(
  dir: string,
): Promise<{ data: Record<string, unknown>; passed: number; total: number }> {
  const text = await readFile(join(dir, 'summary.json'), 'utf8').catch(
    () => undefined,
  );
  if (text === undefined) {
    throw new Error(`error: not a dump folder (no summary.json): ${dir}`);
  }
  const data = JSON.parse(text) as Record<string, unknown>;
  let total = 0;
  let passed = 0;
  const templates = data.templates;
  if (typeof templates === 'object' && templates !== null) {
    for (const entry of Object.values(templates)) {
      const fixtures = (entry as { fixtures?: unknown }).fixtures;
      if (!Array.isArray(fixtures)) continue;
      for (const fixture of fixtures) {
        total += 1;
        const check = (fixture as { check?: unknown }).check;
        if (
          typeof check === 'object' &&
          check !== null &&
          (check as { passed?: unknown }).passed === true
        ) {
          passed += 1;
        }
      }
    }
  }
  return { data, passed, total };
}

const blockFields = [
  'type',
  'page',
  'bbox',
  'text',
  'order',
  'continues',
  'checked',
  'latex',
] as const;

const cellFields = [
  'bbox',
  'text',
  'rowSpan',
  'colSpan',
  'header',
  'checkboxes',
] as const;

const asBlocks = (gt: Record<string, unknown>): Record<string, unknown>[] =>
  Array.isArray(gt.blocks) ? (gt.blocks as Record<string, unknown>[]) : [];

/**
 * Report lines for one fixture key present in both dumps. Returns the lines
 * after '<key>: changed' plus per-block counts; empty when identical.
 */
function changedFixtureLines(
  a: FixtureData,
  b: FixtureData,
): { lines: string[]; changed: number; added: number; removed: number } {
  const lines: string[] = [];
  let changed = 0;
  let added = 0;
  let removed = 0;
  const gtA = normalizeGt(a.gt);
  const gtB = normalizeGt(b.gt);
  if (!jsonEqual(gtA.pages, gtB.pages)) {
    lines.push(`  pages: ${json(gtA.pages)} → ${json(gtB.pages)}`);
  }
  if (!jsonEqual(gtA.source, gtB.source)) {
    lines.push(`  source: ${json(gtA.source)} → ${json(gtB.source)}`);
  }
  const blocksA = asBlocks(gtA);
  const blocksB = asBlocks(gtB);
  const byIdA = new Map(blocksA.map(block => [String(block.id), block]));
  const byIdB = new Map(blocksB.map(block => [String(block.id), block]));
  for (const blockA of blocksA) {
    const id = String(blockA.id);
    const blockB = byIdB.get(id);
    if (blockB === undefined) {
      lines.push(
        `  ${id}: removed ${String(blockA.type)} page ${json(blockA.page)} bbox ${json(blockA.bbox)} text ${json(blockA.text)}`,
      );
      removed += 1;
      continue;
    }
    if (jsonEqual(blockA, blockB)) continue;
    changed += 1;
    for (const field of blockFields) {
      if (!jsonEqual(blockA[field], blockB[field])) {
        lines.push(
          `  ${id}: ${field} ${value(blockA[field])} → ${value(blockB[field])}`,
        );
      }
    }
    if (blockA.type === 'table' && blockB.type === 'table') {
      const tableA = blockA.table as {
        rows: unknown;
        cols: unknown;
        cells: unknown;
      };
      const tableB = blockB.table as {
        rows: unknown;
        cols: unknown;
        cells: unknown;
      };
      if (!jsonEqual(tableA.rows, tableB.rows)) {
        lines.push(
          `  ${id}: table.rows ${value(tableA.rows)} → ${value(tableB.rows)}`,
        );
      }
      if (!jsonEqual(tableA.cols, tableB.cols)) {
        lines.push(
          `  ${id}: table.cols ${value(tableA.cols)} → ${value(tableB.cols)}`,
        );
      }
      const cellsA = new Map(
        (Array.isArray(tableA.cells) ? tableA.cells : []).map(cell => {
          const c = cell as { row: number; col: number };
          return [`${c.row},${c.col}`, c];
        }),
      );
      const cellsB = new Map(
        (Array.isArray(tableB.cells) ? tableB.cells : []).map(cell => {
          const c = cell as { row: number; col: number };
          return [`${c.row},${c.col}`, c];
        }),
      );
      const keys = [...new Set([...cellsA.keys(), ...cellsB.keys()])].sort(
        (k1, k2) => {
          const [r1 = 0, c1 = 0] = k1.split(',').map(Number);
          const [r2 = 0, c2 = 0] = k2.split(',').map(Number);
          return r1 - r2 || c1 - c2;
        },
      );
      for (const key of keys) {
        const cellA = cellsA.get(key) as Record<string, unknown> | undefined;
        const cellB = cellsB.get(key) as Record<string, unknown> | undefined;
        const label = `${id} cell r${key.split(',')[0]}c${key.split(',')[1]}`;
        if (cellA === undefined && cellB !== undefined) {
          lines.push(
            `  ${label}: added bbox ${json(cellB.bbox)} text ${json(cellB.text)}`,
          );
          continue;
        }
        if (cellB === undefined && cellA !== undefined) {
          lines.push(
            `  ${label}: removed bbox ${json(cellA.bbox)} text ${json(cellA.text)}`,
          );
          continue;
        }
        if (cellA === undefined || cellB === undefined) continue;
        for (const field of cellFields) {
          if (!jsonEqual(cellA[field], cellB[field])) {
            lines.push(
              `  ${label}: ${field} ${value(cellA[field])} → ${value(cellB[field])}`,
            );
          }
        }
      }
    }
  }
  for (const blockB of blocksB) {
    const id = String(blockB.id);
    if (byIdA.has(id)) continue;
    lines.push(
      `  ${id}: added ${String(blockB.type)} page ${json(blockB.page)} bbox ${json(blockB.bbox)} text ${json(blockB.text)}`,
    );
    added += 1;
  }
  if (!jsonEqual(a.check, b.check)) {
    const ok = (check: unknown): unknown =>
      typeof check === 'object' && check !== null
        ? (check as { ok?: unknown }).ok
        : undefined;
    const differences = (check: unknown): unknown => {
      const d =
        typeof check === 'object' && check !== null
          ? (check as { differences?: unknown }).differences
          : undefined;
      return Array.isArray(d) ? d.length : undefined;
    };
    lines.push(
      `  self-check: ok ${value(ok(a.check))} → ${value(ok(b.check))}, differences ${value(differences(a.check))} → ${value(differences(b.check))}`,
    );
  }
  return { lines, changed, added, removed };
}

/** Compares the two dump folders; throws on unreadable input. */
export async function compareGt(
  aDir: string,
  bDir: string,
): Promise<CompareResult> {
  const summaryA = await loadSummary(aDir);
  const summaryB = await loadSummary(bDir);
  const fixturesA = await loadFixtures(aDir);
  const fixturesB = await loadFixtures(bDir);
  const lines: string[] = [];
  if (!jsonEqual(summaryA.data.seed, summaryB.data.seed)) {
    lines.push(
      `seed: ${json(summaryA.data.seed)} → ${json(summaryB.data.seed)}`,
    );
  }
  if (!jsonEqual(summaryA.data.count, summaryB.data.count)) {
    lines.push(
      `count: ${json(summaryA.data.count)} → ${json(summaryB.data.count)}`,
    );
  }
  const compareKey = (k1: string, k2: string): number => {
    const [t1 = '', n1 = ''] = k1.split('/');
    const [t2 = '', n2 = ''] = k2.split('/');
    if (t1 !== t2) return t1 < t2 ? -1 : 1;
    return Number(n1) - Number(n2);
  };
  const keys = [...new Set([...fixturesA.keys(), ...fixturesB.keys()])].sort(
    compareKey,
  );
  let identical = 0;
  let changedFixtures = 0;
  let onlyInA = 0;
  let onlyInB = 0;
  let blocksChanged = 0;
  let blocksAdded = 0;
  let blocksRemoved = 0;
  // Total blocks across all of a's gt.json files, also fixtures only in a.
  let blocksTotalA = 0;
  for (const fixture of fixturesA.values()) {
    blocksTotalA += asBlocks(normalizeGt(fixture.gt)).length;
  }
  for (const key of keys) {
    const a = fixturesA.get(key);
    const b = fixturesB.get(key);
    if (a === undefined && b !== undefined) {
      onlyInB += 1;
      lines.push(`${key}: only in b`);
      continue;
    }
    if (b === undefined && a !== undefined) {
      onlyInA += 1;
      lines.push(`${key}: only in a`);
      continue;
    }
    if (a === undefined || b === undefined) continue;
    const gtEqual = jsonEqual(normalizeGt(a.gt), normalizeGt(b.gt));
    const checkEqual = jsonEqual(a.check, b.check);
    if (gtEqual && checkEqual) {
      identical += 1;
      continue;
    }
    changedFixtures += 1;
    lines.push(`${key}: changed`);
    const detail = changedFixtureLines(a, b);
    lines.push(...detail.lines);
    blocksChanged += detail.changed;
    blocksAdded += detail.added;
    blocksRemoved += detail.removed;
  }
  lines.push(
    `fixtures: ${identical}/${keys.length} identical, ${changedFixtures} changed, ${onlyInA} only in a, ${onlyInB} only in b`,
  );
  lines.push(
    `blocks: ${blocksChanged} changed, ${blocksAdded} added, ${blocksRemoved} removed, of ${blocksTotalA} in a`,
  );
  lines.push(
    `self-check: a ${summaryA.passed}/${summaryA.total} passed, b ${summaryB.passed}/${summaryB.total} passed`,
  );
  // Everything above the counts: any fixture or seed/count line means a
  // difference.
  return { lines, different: lines.length > 3 };
}
