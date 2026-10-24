import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  type GroundTruth,
  gtSchema,
  seedSchema,
} from '@pdf-generator/contract';
import { generate } from '@pdf-generator/fake-data';
import type { SelfCheckReport } from '@pdf-generator/self-check';
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
  render,
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

const passingReport: SelfCheckReport = { ok: true, differences: [] };

function fakeChecker(report: SelfCheckReport = passingReport) {
  return vi.fn(async (_pdf: Uint8Array, _gt: GroundTruth) => report);
}

// A missing call is asserted separately. Comparing the absent argument to gt
// would dump the whole ground-truth document into the failure.
function expectCheckCall(
  check: ReturnType<typeof fakeChecker>,
  nth: number,
  pdfBytes: Uint8Array,
  groundTruth: GroundTruth,
) {
  const call = check.mock.calls[nth];
  if (!call) return;
  expect(call[0]).toEqual(pdfBytes);
  expect(call[1]).toEqual(groundTruth);
}

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
  file: 'data.json' | 'gt.json' | 'fixture.pdf' | 'check.json',
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
    // Regression: makeFixture stores the PDF without check.json, or returns
    // FixtureFiles without checkPassed and checkDifferences.
    const print = vi
      .fn<Printer['print']>()
      .mockResolvedValue({ pageCount: 2, pdf, gt });
    const get = vi.fn(fixtureTemplates.get);
    const check = fakeChecker();
    const deps = {
      templates: { get },
      printer: { print },
      files: platform.env.FILES,
      checker: { check },
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
    expect(head).toMatch(/<link rel="stylesheet" href="styles\.css">\s*$/);
    expect(head).not.toMatch(/<style\b/i);

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
    const checkKey = `batches/${job.batchId}/${String(job.index).padStart(4, '0')}/check.json`;
    expect.soft(first).toEqual({
      pageCount: 2,
      dataSha256: hash(dataBytes),
      gtSha256: hash(gtBytes),
      pdfSha256: hash(pdfBytes),
      checkPassed: passingReport.ok,
      checkDifferences: passingReport.differences.length,
    });
    expect
      .soft(
        (await platform.env.FILES.list({ prefix: 'batches/b1/' })).objects
          .map(o => o.key)
          .sort(),
      )
      .toEqual([
        'batches/b1/0007/check.json',
        'batches/b1/0007/data.json',
        'batches/b1/0007/fixture.pdf',
        'batches/b1/0007/gt.json',
      ]);
    const checkObject = await platform.env.FILES.get(checkKey);
    expect.soft(checkObject, 'check.json').not.toBeNull();
    const checkBytes = checkObject
      ? new Uint8Array(await checkObject.arrayBuffer())
      : undefined;
    if (checkBytes) {
      expect(new TextDecoder().decode(checkBytes)).toBe(
        `${JSON.stringify(passingReport, null, 2)}\n`,
      );
    }

    const second = await makeFixture(job, deps);
    expect(await stored(job.batchId, job.index, 'data.json')).toEqual(
      dataBytes,
    );
    expect(await stored(job.batchId, job.index, 'gt.json')).toEqual(gtBytes);
    expect(second).toEqual(first);
    expect(print).toHaveBeenCalledTimes(2);
    const secondCheck = await platform.env.FILES.get(checkKey);
    expect.soft(secondCheck, 'check.json after the second run').not.toBeNull();
    if (checkBytes && secondCheck) {
      expect(new Uint8Array(await secondCheck.arrayBuffer())).toEqual(
        checkBytes,
      );
    }
    expect.soft(check.mock.calls.map(([bytes]) => bytes)).toEqual([pdf, pdf]);
    expectCheckCall(check, 0, pdf, gt);
    expectCheckCall(check, 1, pdf, gt);
  });

  test('stores a failing self-check as check.json and returns its pass flag and difference count', async () => {
    // Regression: a difference makes makeFixture throw or drop the PDF, or
    // checkPassed and checkDifferences are not report.ok and differences.length.
    const mismatchReport: SelfCheckReport = {
      ok: false,
      differences: [
        {
          kind: 'text',
          page: 1,
          blockId: 'title',
          expected: '臺灣示範股份有限公司 月報',
          actual: '月報',
          message:
            'Block title on page 1: the PDF text is not the ground truth',
        },
        {
          kind: 'page_count',
          expected: 2,
          actual: 1,
          message: 'The PDF has 1 page; gt.json has 2',
        },
      ],
    };
    const print = vi
      .fn<Printer['print']>()
      .mockResolvedValue({ pageCount: 2, pdf, gt });
    const check = fakeChecker(mismatchReport);
    const mismatchJob = { ...job, batchId: 'mismatch' };
    const result = await makeFixture(mismatchJob, {
      templates: fixtureTemplates,
      printer: { print },
      files: platform.env.FILES,
      checker: { check },
    });
    expect(
      await stored(mismatchJob.batchId, mismatchJob.index, 'fixture.pdf'),
    ).toEqual(pdf);
    expect.soft(result).toMatchObject({
      checkPassed: mismatchReport.ok,
      checkDifferences: mismatchReport.differences.length,
    });
    expect.soft(check.mock.calls.map(([bytes]) => bytes)).toEqual([pdf]);
    expectCheckCall(check, 0, pdf, gt);
    const checkKey = `batches/${mismatchJob.batchId}/${String(mismatchJob.index).padStart(4, '0')}/check.json`;
    const checkObject = await platform.env.FILES.get(checkKey);
    expect.soft(checkObject, 'check.json').not.toBeNull();
    if (checkObject) {
      expect(new TextDecoder().decode(await checkObject.arrayBuffer())).toBe(
        `${JSON.stringify(mismatchReport, null, 2)}\n`,
      );
    }
    expect
      .soft(
        (await platform.env.FILES.list({ prefix: 'batches/mismatch/' })).objects
          .map(o => o.key)
          .sort(),
      )
      .toEqual([
        'batches/mismatch/0007/check.json',
        'batches/mismatch/0007/data.json',
        'batches/mismatch/0007/fixture.pdf',
        'batches/mismatch/0007/gt.json',
      ]);
  });

  test('uses the selected pack rules and links every stylesheet in order while escaping generated text', async () => {
    const pack: TemplatePack = {
      ...fixtureReport,
      template: '<html><head></head><body>{{ contact.name }}</body></html>',
      manifest: {
        ...fixtureReport.manifest,
        files: {
          ...fixtureReport.manifest.files,
          styles: ['z-first.css', 'a-last.css'],
        },
      },
      files: {
        ...fixtureReport.files,
        'z-first.css': btoa('body { color: red; }'),
        'a-last.css': btoa('body { color: blue; }'),
      },
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
    const check = fakeChecker();
    await makeFixture(
      { ...job, batchId: 'custom', templateId: 'custom', templateVersion: 3 },
      {
        templates: { get },
        printer: { print },
        files: platform.env.FILES,
        checker: { check },
      },
    );
    expect(get).toHaveBeenCalledExactlyOnceWith('custom', 3);
    const html = print.mock.calls[0]?.[0].html ?? '';
    expect(html).toMatch(
      /<body>&lt;b&gt;&amp;&quot;(?:&#39;|&#x27;|&apos;)<\/body>/,
    );
    const head = /<head\b[^>]*>([\s\S]*?)<\/head>/i.exec(html)?.[1] ?? '';
    expect(head).toMatch(
      /<link rel="stylesheet" href="z-first\.css">\s*<link rel="stylesheet" href="a-last\.css">\s*$/,
    );
    expect(head).not.toMatch(/<style\b/i);
  });

  test('rejects an unknown template without printing or storing a partial fixture', async () => {
    // Regression: the checker runs before the template is resolved, or a miss
    // still writes check.json.
    const print = vi.fn<Printer['print']>();
    const get = vi.fn(fixtureTemplates.get);
    const check = fakeChecker();
    await expect(
      makeFixture(
        { ...job, batchId: 'unknown', templateVersion: 999 },
        {
          templates: { get },
          printer: { print },
          files: platform.env.FILES,
          checker: { check },
        },
      ),
    ).rejects.toBeInstanceOf(Error);
    expect(get).toHaveBeenCalledExactlyOnceWith(job.templateId, 999);
    expect(print).not.toHaveBeenCalled();
    expect(check).not.toHaveBeenCalled();
    expect(
      (await platform.env.FILES.list({ prefix: 'batches/unknown/' })).objects,
    ).toEqual([]);
  });

  test('propagates the printer error unchanged without storing a partial fixture', async () => {
    // Regression: a printer failure still runs the checker or leaves check.json.
    const error = new Error('print unavailable');
    const print = vi.fn<Printer['print']>().mockRejectedValue(error);
    const check = fakeChecker();
    await expect(
      makeFixture(
        { ...job, batchId: 'failed' },
        {
          templates: fixtureTemplates,
          printer: { print },
          files: platform.env.FILES,
          checker: { check },
        },
      ),
    ).rejects.toBe(error);
    expect(print).toHaveBeenCalledTimes(1);
    expect(check).not.toHaveBeenCalled();
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

// The route covers sibling folders and root templates. These cases catch path
// algorithms that always prepend ../, use pack-root URLs, or encode slashes.
test.each([
  { template: 'a/b/t.hbs', styles: ['a/b/c/s.css'], links: ['c/s.css'] },
  {
    template: 'a/b/t.hbs',
    styles: ['a/styles/報表 1.css', 'a/b/樣式 #1%.css'],
    links: [
      '../styles/%E5%A0%B1%E8%A1%A8%201.css',
      '%E6%A8%A3%E5%BC%8F%20%231%25.css',
    ],
  },
])(
  'render resolves and segment-encodes stylesheet paths relative to $template: $styles',
  ({ template, styles, links }) => {
    const pack: TemplatePack = {
      ...fixtureReport,
      template:
        '<html><head><title>keep</title></head><body>{{company}}</body></html>',
      manifest: {
        ...fixtureReport.manifest,
        files: { ...fixtureReport.manifest.files, template, styles },
      },
      files: Object.fromEntries(
        styles.map(path => [path, btoa('body { color: red; }')]),
      ),
    };
    const html = render(pack, { company: '測試' });
    expect(html.replace(/>\s+</g, '><')).toBe(
      `<html><head><title>keep</title>${links.map(href => `<link rel="stylesheet" href="${href}">`).join('')}</head><body>測試</body></html>`,
    );
  },
);
