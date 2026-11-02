// compare-gt end to end: the CLI on two dump folders laid out as dump-gt
// writes them (<template>/<NNNN>/gt.json and check.json, summary.json).
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Fixture, GroundTruth, GtBlock } from '@pdf-generator/contract';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const cli = fileURLToPath(new URL('./compare-gt-cli.ts', import.meta.url));
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

async function run(args: string[]): Promise<Run> {
  const child = spawn(process.execPath, [cli, ...args], { cwd: repoRoot });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => {
    stdout += chunk;
  });
  child.stderr.on('data', chunk => {
    stderr += chunk;
  });
  const [code] = (await once(child, 'close')) as [number | null];
  return { code, stdout, stderr };
}

type DumpGt = Omit<GroundTruth, 'source'> & {
  source: Omit<GroundTruth['source'], 'templateVersion'> & {
    templateVersion?: number;
  };
};

interface Check {
  ok: boolean;
  differences: unknown[];
}

interface DumpFixture {
  gt: DumpGt;
  check?: Check;
}

const passed: Check = { ok: true, differences: [] };

const paragraph = (id: string, order: number, text: string): GtBlock => ({
  id,
  type: 'paragraph',
  page: 1,
  bbox: [10, 20 + order * 30, 300, 40 + order * 30],
  order,
  text,
});

const table: GtBlock = {
  id: 'table-1',
  type: 'table',
  page: 1,
  bbox: [42.52, 106.63, 552.75, 595.72],
  order: 2,
  text: '項目 金額',
  table: {
    rows: 2,
    cols: 2,
    cells: [
      {
        row: 0,
        col: 0,
        rowSpan: 1,
        colSpan: 1,
        header: true,
        text: '項目',
        bbox: [42.52, 106.63, 300, 130],
      },
      {
        row: 0,
        col: 1,
        rowSpan: 1,
        colSpan: 1,
        header: true,
        text: '金額',
        bbox: [300, 106.63, 552.75, 130],
      },
      {
        row: 1,
        col: 0,
        rowSpan: 1,
        colSpan: 1,
        header: false,
        text: '租金',
        bbox: [42.52, 130, 300, 160],
      },
      {
        row: 1,
        col: 1,
        rowSpan: 1,
        colSpan: 1,
        header: false,
        text: '1,000',
        bbox: [300, 130, 552.75, 160],
      },
    ],
  },
};

function gt(templateId: string, index: number, blocks?: GtBlock[]): DumpGt {
  return {
    schemaVersion: 1,
    source: { templateId, seed: 'dump-gt', index },
    pages: [{ width: 595.28, height: 841.89 }],
    blocks: blocks ?? [
      paragraph('title-1', 0, `${templateId} 第${index}份`),
      paragraph('paragraph-1', 1, '內文'),
      table,
    ],
  };
}

const clone = <T>(value: T): T => structuredClone(value);

let scratch: string;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'compare-gt-'));
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

/**
 * Writes a dump: `fixtures` by '<template>/<NNNN>'. The summary lists every
 * fixture as completed with its check, plus `failed` ones as failed.
 */
async function dump(
  name: string,
  fixtures: Record<string, DumpFixture>,
  options: { seed?: string; count?: number; failed?: string[] } = {},
): Promise<string> {
  const dir = join(scratch, name);
  const templates: Record<string, { fixtures: Fixture[] }> = {};
  const add = (key: string, fixture: Fixture) => {
    const [template = ''] = key.split('/');
    templates[template] ??= { fixtures: [] };
    templates[template].fixtures.push(fixture);
  };
  for (const [key, fixture] of Object.entries(fixtures)) {
    const check = fixture.check ?? passed;
    await mkdir(join(dir, key), { recursive: true });
    await writeFile(
      join(dir, key, 'gt.json'),
      `${JSON.stringify(fixture.gt, null, 2)}\n`,
    );
    await writeFile(
      join(dir, key, 'check.json'),
      `${JSON.stringify(check, null, 2)}\n`,
    );
    add(key, {
      index: Number(key.split('/')[1]),
      status: 'completed',
      check: { passed: check.ok, differences: check.differences.length },
    });
  }
  for (const key of options.failed ?? []) {
    add(key, {
      index: Number(key.split('/')[1]),
      status: 'failed',
      error: 'print_failed',
    });
  }
  for (const entry of Object.values(templates)) {
    entry.fixtures.sort((a, b) => a.index - b.index);
  }
  await mkdir(dirname(join(dir, 'summary.json')), { recursive: true });
  await writeFile(
    join(dir, 'summary.json'),
    `${JSON.stringify({ count: options.count ?? 2, seed: options.seed ?? 'dump-gt', templates }, null, 2)}\n`,
  );
  return dir;
}

/** alpha and beta, 2 fixtures each: 12 blocks. */
function base(): Record<string, DumpFixture> {
  return {
    'alpha/0000': { gt: gt('alpha', 0) },
    'alpha/0001': { gt: gt('alpha', 1) },
    'beta/0000': { gt: gt('beta', 0) },
    'beta/0001': { gt: gt('beta', 1) },
  };
}

describe('compare-gt', () => {
  it('reports identical dumps with the counts and exits 0', async () => {
    const a = await dump('a', base());
    const reordered = base();
    // Key order and source.templateVersion don't matter.
    const fixture = reordered['beta/0001'];
    if (!fixture) throw new Error('missing fixture');
    fixture.gt = JSON.parse(
      JSON.stringify({
        blocks: fixture.gt.blocks,
        pages: fixture.gt.pages,
        source: { ...fixture.gt.source, templateVersion: 7 },
        schemaVersion: 1,
      }),
    );
    const b = await dump('b', reordered);
    const result = await run([a, b]);
    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
    expect(result.stdout).toBe(
      [
        'fixtures: 4/4 identical, 0 changed, 0 only in a, 0 only in b',
        'blocks: 0 changed, 0 added, 0 removed, of 12 in a',
        'self-check: a 4/4 passed, b 4/4 passed',
        '',
      ].join('\n'),
    );
  });

  it('lists a changed bbox and a changed text with old and new values', async () => {
    const a = await dump('a', base());
    const changed = base();
    const blocks = changed['alpha/0001']?.gt.blocks ?? [];
    const title = blocks[0];
    const body = blocks[1];
    if (!title || !body) throw new Error('missing block');
    title.bbox = [10, 20, 300, 41.5];
    body.text = '內文改了';
    const b = await dump('b', changed);
    const result = await run([a, b]);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe(
      [
        'alpha/0001: changed',
        '  title-1: bbox [10,20,300,40] → [10,20,300,41.5]',
        '  paragraph-1: text "內文" → "內文改了"',
        'fixtures: 3/4 identical, 1 changed, 0 only in a, 0 only in b',
        'blocks: 2 changed, 0 added, 0 removed, of 12 in a',
        'self-check: a 4/4 passed, b 4/4 passed',
        '',
      ].join('\n'),
    );
  });

  it('lists added and removed blocks and other changed fields', async () => {
    const a = await dump('a', base());
    const changed = base();
    const fixture = changed['beta/0000'];
    if (!fixture) throw new Error('missing fixture');
    const [title, body, tableBlock] = fixture.gt.blocks;
    if (!title || !body || !tableBlock) throw new Error('missing block');
    fixture.gt.blocks = [
      { ...title, type: 'title', order: 1 },
      { ...tableBlock, page: 2 },
      paragraph('note-1', 0, '附註'),
    ];
    fixture.gt.pages = [
      { width: 595.28, height: 841.89 },
      { width: 595.28, height: 841.89 },
    ];
    const b = await dump('b', changed);
    const result = await run([a, b]);
    expect(result.code).toBe(1);
    const lines = result.stdout.split('\n');
    const start = lines.indexOf('beta/0000: changed');
    expect(start).toBeGreaterThanOrEqual(0);
    expect(lines.slice(start, start + 7)).toEqual([
      'beta/0000: changed',
      '  pages: [{"height":841.89,"width":595.28}] → [{"height":841.89,"width":595.28},{"height":841.89,"width":595.28}]',
      '  title-1: type "paragraph" → "title"',
      '  title-1: order 0 → 1',
      '  paragraph-1: removed paragraph page 1 bbox [10,50,300,70] text "內文"',
      '  table-1: page 1 → 2',
      '  note-1: added paragraph page 1 bbox [10,20,300,40] text "附註"',
    ]);
    expect(result.stdout).toContain(
      'blocks: 2 changed, 1 added, 1 removed, of 12 in a\n',
    );
  });

  it('lists changed, added and removed table cells by row and column', async () => {
    const a = await dump('a', base());
    const changed = base();
    const blocks = changed['alpha/0000']?.gt.blocks ?? [];
    const tableBlock = clone(table);
    if (tableBlock.type !== 'table') throw new Error('not a table');
    const cells = tableBlock.table.cells;
    const amount = cells[3];
    if (!amount) throw new Error('missing cell');
    amount.bbox = [300.25, 130, 552.75, 160];
    amount.text = '1,200';
    tableBlock.table.cells = [
      ...cells.slice(0, 2),
      amount,
      {
        row: 2,
        col: 0,
        rowSpan: 1,
        colSpan: 2,
        header: false,
        text: '合計',
        bbox: [42.52, 160, 552.75, 190],
      },
    ];
    tableBlock.table.rows = 3;
    blocks[2] = tableBlock;
    const b = await dump('b', changed);
    const result = await run([a, b]);
    expect(result.code).toBe(1);
    expect(result.stdout.split('\n').slice(0, 6)).toEqual([
      'alpha/0000: changed',
      '  table-1: table.rows 2 → 3',
      '  table-1 cell r1c0: removed bbox [42.52,130,300,160] text "租金"',
      '  table-1 cell r1c1: bbox [300,130,552.75,160] → [300.25,130,552.75,160]',
      '  table-1 cell r1c1: text "1,000" → "1,200"',
      '  table-1 cell r2c0: added bbox [42.52,160,552.75,190] text "合計"',
    ]);
    expect(result.stdout).toContain(
      'blocks: 1 changed, 0 added, 0 removed, of 12 in a\n',
    );
  });

  it('reports a changed self-check and the pass counts from each summary', async () => {
    const a = await dump('a', base());
    const changed = base();
    const fixture = changed['beta/0001'];
    if (!fixture) throw new Error('missing fixture');
    fixture.check = {
      ok: false,
      differences: [
        { kind: 'font', page: 1, font: 'Times', text: '內' },
        { kind: 'font', page: 1, font: 'Times', text: '文' },
      ],
    };
    const b = await dump('b', changed);
    const result = await run([a, b]);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe(
      [
        'beta/0001: changed',
        '  self-check: ok true → false, differences 0 → 2',
        'fixtures: 3/4 identical, 1 changed, 0 only in a, 0 only in b',
        'blocks: 0 changed, 0 added, 0 removed, of 12 in a',
        'self-check: a 4/4 passed, b 3/4 passed',
        '',
      ].join('\n'),
    );
  });

  it('reports blocks that only moved in the array', async () => {
    const a = await dump('a', base());
    const changed = base();
    const fixture = changed['alpha/0000'];
    if (!fixture) throw new Error('missing fixture');
    const [title, body, tableBlock] = fixture.gt.blocks;
    if (!title || !body || !tableBlock) throw new Error('missing block');
    // Same blocks, same order fields; only their place in the array moved.
    fixture.gt.blocks = [body, title, tableBlock];
    const b = await dump('b', changed);
    const result = await run([a, b]);
    expect(result.code).toBe(1);
    expect(result.stdout.split('\n').slice(0, 3)).toEqual([
      'alpha/0000: changed',
      '  block array order: ["title-1","paragraph-1","table-1"] → ["paragraph-1","title-1","table-1"]',
      'fixtures: 3/4 identical, 1 changed, 0 only in a, 0 only in b',
    ]);
    expect(result.stdout).toContain(
      'blocks: 0 changed, 0 added, 0 removed, of 12 in a\n',
    );
  });

  it('shows the self-check differences when only their content changed', async () => {
    const before = { kind: 'font', page: 1, font: 'Times', text: '內' };
    const after = { kind: 'font', page: 1, font: 'Arial', text: '內' };
    const failing = (difference: object): Record<string, DumpFixture> => {
      const fixtures = base();
      const fixture = fixtures['beta/0000'];
      if (!fixture) throw new Error('missing fixture');
      fixture.check = { ok: false, differences: [difference] };
      return fixtures;
    };
    const a = await dump('a', failing(before));
    const b = await dump('b', failing(after));
    const result = await run([a, b]);
    expect(result.code).toBe(1);
    expect(result.stdout.split('\n').slice(0, 4)).toEqual([
      'beta/0000: changed',
      '  self-check: ok false → false, differences 1 → 1',
      '  self-check differences: [{"font":"Times","kind":"font","page":1,"text":"內"}] → [{"font":"Arial","kind":"font","page":1,"text":"內"}]',
      'fixtures: 3/4 identical, 1 changed, 0 only in a, 0 only in b',
    ]);
  });

  it('reports fixtures and templates only in one dump, and a different seed or count', async () => {
    const a = await dump('a', base(), { count: 2 });
    const changed = base();
    delete changed['alpha/0001'];
    changed['gamma/0000'] = { gt: gt('gamma', 0) };
    const b = await dump('b', changed, {
      seed: 'other',
      count: 3,
      failed: ['alpha/0001'],
    });
    const result = await run([a, b]);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe(
      [
        'seed: "dump-gt" → "other"',
        'count: 2 → 3',
        'alpha/0001: only in a',
        'gamma/0000: only in b',
        'fixtures: 3/5 identical, 0 changed, 1 only in a, 1 only in b',
        'blocks: 0 changed, 0 added, 0 removed, of 12 in a',
        'self-check: a 4/4 passed, b 4/5 passed',
        '',
      ].join('\n'),
    );
  });

  it('exits 2 when a folder is missing or is not a dump', async () => {
    const a = await dump('a', base());
    const missing = join(scratch, 'vanished');
    const gone = await run([a, missing]);
    expect(gone.code).toBe(2);
    expect(gone.stderr).toContain(missing);

    const notDump = join(scratch, 'plain');
    await mkdir(notDump);
    const plain = await run([notDump, a]);
    expect(plain.code).toBe(2);
    expect(plain.stderr).toContain('summary.json');

    const usage = await run([a]);
    expect(usage.code).toBe(2);
    expect(usage.stderr).toMatch(/usage/i);
  });
});
