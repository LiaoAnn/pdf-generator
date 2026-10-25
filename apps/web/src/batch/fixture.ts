// One fixture of a batch: fake data → filled template → printed PDF and
// ground truth → R2. Same job, same bytes for data.json and gt.json.
import { type FakeRecord, generate } from '@pdf-generator/fake-data';
import { fill, headEnd } from '@pdf-generator/template-tools';
import type { TemplatePack, TemplateSourceApi } from '../templates/source.ts';
import type { Checker } from './check.ts';
import type { Printer } from './printer.ts';

export interface FixtureJob {
  batchId: string;
  templateId: string;
  templateVersion: number;
  /** The batch's seed; each fixture derives its own (fixtureSeed). */
  seed: string;
  index: number;
}

export type FixtureFile =
  | 'data.json'
  | 'gt.json'
  | 'fixture.pdf'
  | 'check.json';

export interface FixtureFiles {
  pageCount: number;
  dataSha256: string;
  gtSha256: string;
  pdfSha256: string;
  checkPassed: boolean;
  checkDifferences: number;
}

const encoder = new TextEncoder();

async function sha256(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * The fake-data seed of fixture `index`: SHA-256 hex of the batch seed and
 * the index, so it is 64 characters of [0-9a-f] (a valid seed) whatever the
 * batch seed's length.
 */
export function fixtureSeed(seed: string, index: number): Promise<string> {
  return sha256(encoder.encode(`${seed}\n${index}`));
}

/** Where a fixture's file lives in R2. */
export function fixtureKey(
  batchId: string,
  index: number,
  file: FixtureFile,
): string {
  return `${batchPrefix(batchId)}${String(index).padStart(4, '0')}/${file}`;
}

export function batchPrefix(batchId: string): string {
  return `batches/${batchId}/`;
}

// The URL of pack file `path` relative to the folder of pack file `from`.
function relativeUrl(from: string, path: string): string {
  const base = from.split('/').slice(0, -1);
  const target = path.split('/');
  let shared = 0;
  while (
    shared < base.length &&
    shared < target.length - 1 &&
    base[shared] === target[shared]
  ) {
    shared++;
  }
  return [
    ...base.slice(shared).map(() => '..'),
    ...target.slice(shared).map(encodeURIComponent),
  ].join('/');
}

// The pack's stylesheets are linked from the document head: the print Worker
// serves the pack's files, so their url()s resolve as in the pack. checkPack
// makes sure the template writes out the head's end tag.
function linkStyles(html: string, template: string, styles: string[]): string {
  const head = headEnd(html);
  if (head === undefined) throw new Error('the template has no </head>');
  const tags = styles
    .map(
      path => `<link rel="stylesheet" href="${relativeUrl(template, path)}">\n`,
    )
    .join('');
  return html.slice(0, head) + tags + html.slice(head);
}

/** The document a pack prints for a record: filled, stylesheets linked. */
export function render(pack: TemplatePack, record: FakeRecord): string {
  const { template, styles } = pack.manifest.files;
  const html = fill(pack.template, record, { file: template });
  return linkStyles(html, template, styles);
}

export async function makeFixture(
  job: FixtureJob,
  deps: {
    templates: TemplateSourceApi;
    printer: Printer;
    files: R2Bucket;
    checker: Checker;
  },
): Promise<FixtureFiles> {
  const pack = await deps.templates.get(job.templateId, job.templateVersion);
  if (!pack) {
    throw new Error(
      `no template ${job.templateId} version ${job.templateVersion}`,
    );
  }
  const record = generate(pack.rules, await fixtureSeed(job.seed, job.index));
  const printed = await deps.printer.print({
    html: render(pack, record),
    page: pack.manifest.page,
    source: {
      templateId: job.templateId,
      templateVersion: job.templateVersion,
      seed: job.seed,
      index: job.index,
    },
    pack: { template: pack.manifest.files.template, files: pack.files },
  });
  const report = await deps.checker.check(printed.pdf, printed.gt, pack.fonts);
  const files: [FixtureFile, Uint8Array<ArrayBuffer>][] = [
    ['data.json', encoder.encode(`${JSON.stringify(record, null, 2)}\n`)],
    ['gt.json', encoder.encode(`${JSON.stringify(printed.gt, null, 2)}\n`)],
    ['fixture.pdf', printed.pdf],
    ['check.json', encoder.encode(`${JSON.stringify(report, null, 2)}\n`)],
  ];
  const [dataSha256, gtSha256, pdfSha256] = await Promise.all(
    files.map(async ([file, bytes]) => {
      await deps.files.put(fixtureKey(job.batchId, job.index, file), bytes);
      return sha256(bytes);
    }),
  );
  return {
    pageCount: printed.pageCount,
    dataSha256: dataSha256 ?? '',
    gtSha256: gtSha256 ?? '',
    pdfSha256: pdfSha256 ?? '',
    checkPassed: report.ok,
    checkDifferences: report.differences.length,
  };
}
