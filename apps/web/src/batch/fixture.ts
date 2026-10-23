// One fixture of a batch: fake data → filled template → printed PDF and
// ground truth → R2. Same job, same bytes for data.json and gt.json.
import { generate } from '@pdf-generator/fake-data';
import { fill } from '../templates/fill.ts';
import type { TemplatePack, TemplateSourceApi } from '../templates/source.ts';
import type { Printer } from './printer.ts';

export interface FixtureJob {
  batchId: string;
  templateId: string;
  templateVersion: number;
  /** The batch's seed; each fixture derives its own (fixtureSeed). */
  seed: string;
  index: number;
}

export type FixtureFile = 'data.json' | 'gt.json' | 'fixture.pdf';

export interface FixtureFiles {
  pageCount: number;
  dataSha256: string;
  gtSha256: string;
  pdfSha256: string;
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

function batchPrefix(batchId: string): string {
  return `batches/${batchId}/`;
}

// The pack's stylesheets go into the document head: the print Worker takes
// one self-contained HTML document.
function inlineStyles(html: string, styles: string[]): string {
  const head = html.search(/<\/head>/i);
  if (head < 0) throw new Error('the template has no </head>');
  if (styles.some(css => /<\/style/i.test(css))) {
    throw new Error('a stylesheet contains </style');
  }
  const tags = styles.map(css => `<style>\n${css}</style>\n`).join('');
  return html.slice(0, head) + tags + html.slice(head);
}

function render(pack: TemplatePack, record: Parameters<typeof fill>[1]) {
  return inlineStyles(fill(pack.template, record), pack.styles);
}

export async function makeFixture(
  job: FixtureJob,
  deps: { templates: TemplateSourceApi; printer: Printer; files: R2Bucket },
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
  });
  const files: [FixtureFile, Uint8Array<ArrayBuffer>][] = [
    ['data.json', encoder.encode(`${JSON.stringify(record, null, 2)}\n`)],
    ['gt.json', encoder.encode(`${JSON.stringify(printed.gt, null, 2)}\n`)],
    ['fixture.pdf', printed.pdf],
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
  };
}
