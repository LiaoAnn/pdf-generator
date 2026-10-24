import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  type GroundTruth,
  gtSchema,
  seedSchema,
} from '@pdf-generator/contract';
import { generate } from '@pdf-generator/fake-data';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { getPlatformProxy } from 'wrangler';
import gtExample from '../../../../packages/contract/examples/gt.valid.json';
import { fixtureReport, fixtureTemplates } from '../templates/fixture-pack.ts';
import type { TemplatePack } from '../templates/source.ts';
import {
  type FixtureJob,
  fixtureKey,
  fixtureSeed,
  makeFixture,
} from './fixture.ts';
import type { Printer } from './printer.ts';

type LocalPlatform = Awaited<ReturnType<typeof getPlatformProxy<Env>>>;
let platform: LocalPlatform;
const job: FixtureJob = {
  batchId: 'b1',
  templateId: 'fixture-report',
  templateVersion: 1,
  seed: 'batch_seed',
  index: 7,
};
const source = {
  templateId: job.templateId,
  templateVersion: job.templateVersion,
  seed: job.seed,
  index: job.index,
};
const gt: GroundTruth = gtSchema.parse({ ...gtExample, source });
const pdf = new Uint8Array([37, 80, 68, 70, 45, 0, 128, 255, 10]);
const hash = (bytes: Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex');

beforeAll(async () => {
  platform = await getPlatformProxy<Env>({
    configPath: fileURLToPath(new URL('../../wrangler.jsonc', import.meta.url)),
    persist: false,
  });
}, 60_000);
afterAll(async () => {
  await platform?.dispose();
}, 30_000);

async function stored(
  batchId: string,
  index: number,
  file: 'data.json' | 'gt.json' | 'fixture.pdf',
) {
  // Literal prefix expectation prevents a shared bug in fixtureKey and makeFixture hiding misplaced files.
  const object = await platform.env.FILES.get(
    `batches/${batchId}/${String(index).padStart(4, '0')}/${file}`,
  );
  expect(object, file).not.toBeNull();
  if (!object) throw new Error(`Missing ${file}`);
  return new Uint8Array(await object.arrayBuffer());
}

describe('makeFixture with local R2', () => {
  test('stores a reproducible fixture with exact printer bytes, matching source and hashes', async () => {
    const print = vi
      .fn<Printer['print']>()
      .mockResolvedValue({ pageCount: 2, pdf, gt });
    const get = vi.fn(fixtureTemplates.get);
    const deps = {
      templates: { get },
      printer: { print },
      files: platform.env.FILES,
    };
    const expectedRecord = generate(
      fixtureReport.rules,
      await fixtureSeed(job.seed, job.index),
    );

    const first = await makeFixture(job, deps);
    expect(get).toHaveBeenCalledExactlyOnceWith(
      job.templateId,
      job.templateVersion,
    );
    expect(print).toHaveBeenCalledTimes(1);
    const request = print.mock.calls[0]?.[0];
    expect(request).toMatchObject({
      page: fixtureReport.manifest.page,
      source,
    });
    if (!request) throw new Error('Printer was not called');
    expect(request.html).not.toContain('{{');
    for (const value of Object.values(expectedRecord)) {
      const scalars =
        typeof value === 'object' && value !== null
          ? Object.values(value)
          : [value];
      for (const scalar of scalars)
        expect(request.html).toContain(String(scalar));
    }
    const head =
      /<head\b[^>]*>([\s\S]*?)<\/head>/i.exec(request.html)?.[1] ?? '';
    for (const css of fixtureReport.styles) expect(head).toContain(css);
    expect(head).toMatch(/<style\b[^>]*>[\s\S]*<\/style>/i);

    const dataBytes = await stored(job.batchId, job.index, 'data.json');
    const gtBytes = await stored(job.batchId, job.index, 'gt.json');
    const pdfBytes = await stored(job.batchId, job.index, 'fixture.pdf');
    expect(JSON.parse(new TextDecoder().decode(dataBytes))).toEqual(
      expectedRecord,
    );
    const storedGt = JSON.parse(new TextDecoder().decode(gtBytes));
    expect(gtSchema.parse(storedGt)).toEqual(gt);
    expect(storedGt.source).toEqual(source);
    expect(pdfBytes).toEqual(pdf);
    expect(first).toEqual({
      pageCount: 2,
      dataSha256: hash(dataBytes),
      gtSha256: hash(gtBytes),
      pdfSha256: hash(pdfBytes),
    });
    expect(
      (await platform.env.FILES.list({ prefix: 'batches/b1/' })).objects
        .map(o => o.key)
        .sort(),
    ).toEqual([
      'batches/b1/0007/data.json',
      'batches/b1/0007/fixture.pdf',
      'batches/b1/0007/gt.json',
    ]);

    const second = await makeFixture(job, deps);
    expect(await stored(job.batchId, job.index, 'data.json')).toEqual(
      dataBytes,
    );
    expect(await stored(job.batchId, job.index, 'gt.json')).toEqual(gtBytes);
    expect(second).toEqual(first);
    expect(print).toHaveBeenCalledTimes(2);
  });

  test('uses the selected pack rules and inlines every stylesheet in order while escaping generated text', async () => {
    const pack: TemplatePack = {
      ...fixtureReport,
      template: '<html><head></head><body>{{ contact.name }}</body></html>',
      styles: ['body { color: red; }', 'body { color: blue; }'],
      rules: {
        schemaVersion: 1,
        fields: {
          contact: {
            type: 'object',
            fields: { name: { type: 'constant', value: '<b>&"\'' } },
          },
        },
      },
    };
    const get = vi.fn().mockResolvedValue(pack);
    const print = vi
      .fn<Printer['print']>()
      .mockResolvedValue({ pageCount: 2, pdf, gt });
    await makeFixture(
      { ...job, batchId: 'custom', templateId: 'custom', templateVersion: 3 },
      {
        templates: { get },
        printer: { print },
        files: platform.env.FILES,
      },
    );
    expect(get).toHaveBeenCalledExactlyOnceWith('custom', 3);
    const html = print.mock.calls[0]?.[0].html ?? '';
    expect(html).toMatch(
      /<body>&lt;b&gt;&amp;&quot;(?:&#39;|&#x27;|&apos;)<\/body>/,
    );
    const head = /<head\b[^>]*>([\s\S]*?)<\/head>/i.exec(html)?.[1] ?? '';
    const inlined = [...head.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)]
      .map(match => match[1])
      .join('\n');
    expect(inlined).toContain(pack.styles[0]);
    expect(inlined).toContain(pack.styles[1]);
    expect(inlined.indexOf(pack.styles[0] ?? '')).toBeLessThan(
      inlined.indexOf(pack.styles[1] ?? ''),
    );
  });

  test('rejects an unknown template without printing or storing a partial fixture', async () => {
    const print = vi.fn<Printer['print']>();
    const get = vi.fn(fixtureTemplates.get);
    await expect(
      makeFixture(
        { ...job, batchId: 'unknown', templateVersion: 999 },
        {
          templates: { get },
          printer: { print },
          files: platform.env.FILES,
        },
      ),
    ).rejects.toBeInstanceOf(Error);
    expect(get).toHaveBeenCalledExactlyOnceWith(job.templateId, 999);
    expect(print).not.toHaveBeenCalled();
    expect(
      (await platform.env.FILES.list({ prefix: 'batches/unknown/' })).objects,
    ).toEqual([]);
  });

  test('propagates the printer error unchanged without storing a partial fixture', async () => {
    const error = new Error('print unavailable');
    const print = vi.fn<Printer['print']>().mockRejectedValue(error);
    await expect(
      makeFixture(
        { ...job, batchId: 'failed' },
        {
          templates: fixtureTemplates,
          printer: { print },
          files: platform.env.FILES,
        },
      ),
    ).rejects.toBe(error);
    expect(print).toHaveBeenCalledTimes(1);
    expect(
      (await platform.env.FILES.list({ prefix: 'batches/failed/' })).objects,
    ).toEqual([]);
  });
});

test('fixtureSeed is repeatable, separates seed/index pairs and fits the contract at maximum seed length', async () => {
  const pairs = [
    ['a', 0],
    ['a', 1],
    ['a1', 0],
    ['a', 10],
    ['a'.repeat(64), 0],
    ['a'.repeat(64), 9999],
  ] as const;
  const seeds = await Promise.all(
    pairs.map(([seed, index]) => fixtureSeed(seed, index)),
  );
  for (const seed of seeds) expect(seedSchema.parse(seed)).toBe(seed);
  expect(new Set(seeds).size).toBe(pairs.length);
  expect(
    await Promise.all(pairs.map(([seed, index]) => fixtureSeed(seed, index))),
  ).toEqual(seeds);
});

test('fixtureKey pads short indexes without truncating larger indexes or mixing batches', () => {
  expect(fixtureKey('b1', 7, 'gt.json')).toBe('batches/b1/0007/gt.json');
  expect(fixtureKey('b2', 0, 'data.json')).toBe('batches/b2/0000/data.json');
  expect(fixtureKey('b2', 10000, 'fixture.pdf')).toBe(
    'batches/b2/10000/fixture.pdf',
  );
});
