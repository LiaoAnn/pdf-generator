import { Buffer } from 'node:buffer';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  apiErrorSchema,
  manifestSchema,
  templateSummarySchema,
} from '@pdf-generator/contract';
import { drizzle } from 'drizzle-orm/d1';
import { migrate } from 'drizzle-orm/d1/migrator';
import { strFromU8, strToU8, zipSync } from 'fflate';
import { afterAll, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import { getPlatformProxy } from 'wrangler';
import { createLocalAccess, localServiceToken } from '../access/local.ts';
import { templates } from '../db/schema.ts';
import { fixtureReport, storeFixturePack } from '../templates/fixture-pack.ts';
import { createFetchHandler } from '../worker.ts';

type Files = Record<string, Uint8Array>;
let platform: Awaited<ReturnType<typeof getPlatformProxy<Env>>>;
let valid: Files;
const printToken = 'preview-test-print-token';
const printFetch = vi.fn<typeof fetch>();
// Include non-text bytes to catch accidentally decoding/re-encoding the PDF.
const pdf = new Uint8Array([37, 80, 68, 70, 45, 49, 46, 55, 10, 0, 128, 255]);
const local = createLocalAccess();
const handle = createFetchHandler({
  pages: async () => new Response('Unexpected page handler', { status: 599 }),
  access: () => local.config,
  edge: local.edge,
});

async function readPack(root: URL, prefix = ''): Promise<Files> {
  const files: Files = {};
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = `${prefix}${entry.name}`;
    if (entry.isDirectory()) {
      Object.assign(
        files,
        await readPack(new URL(`${entry.name}/`, root), `${path}/`),
      );
    } else {
      files[path] = new Uint8Array(await readFile(new URL(entry.name, root)));
    }
  }
  return files;
}

function text(files: Files, path: string): string {
  const bytes = files[path];
  if (!bytes) throw new Error(`Missing fixture file ${path}`);
  return strFromU8(bytes);
}

function pack(heading: string, approved = true) {
  const manifest = manifestSchema.parse(
    JSON.parse(text(valid, 'manifest.json')),
  );
  manifest.page.orientation = approved ? 'portrait' : 'landscape';
  // These deliberately differ from the fixture's default paths and zip order.
  manifest.files.sample = 'data/preview-record.json';
  manifest.files.styles = ['styles/z-first.css', 'styles/a-last.css'];
  const styles = [text(valid, 'styles/report.css'), 'p { color: #654321; }'];
  const sample = {
    ...JSON.parse(text(valid, 'data/sample.json')),
    company: `${heading}範例有限公司`,
    revenue: 123456,
    approved,
    rows: [
      { item: '文具', amount: 2345 },
      { item: '設備', amount: 6789 },
    ],
  };
  const template = text(valid, manifest.files.template)
    .replaceAll('公司月報', heading)
    .replace('../styles/report.css', '../styles/z-first.css');
  const files: Files = {
    ...valid,
    'manifest.json': strToU8(JSON.stringify(manifest)),
    [manifest.files.template]: strToU8(template),
    [manifest.files.sample]: strToU8(JSON.stringify(sample)),
    'styles/z-first.css': strToU8(styles[0] ?? ''),
    'styles/a-last.css': strToU8(styles[1] ?? ''),
  };
  delete files['data/sample.json'];
  delete files['styles/report.css'];
  return { files, manifest, heading, approved };
}

function request(path: string, bytes?: Uint8Array) {
  return handle(
    new Request(`https://web.example.test${path}`, {
      method: bytes === undefined ? 'GET' : 'POST',
      headers: {
        'CF-Access-Client-Id': localServiceToken.clientId,
        'CF-Access-Client-Secret': localServiceToken.clientSecret,
        ...(bytes === undefined ? {} : { 'content-type': 'application/zip' }),
      },
      ...(bytes === undefined ? {} : { body: new Uint8Array(bytes) }),
    }),
    {
      ...platform.env,
      PRINT: { fetch: printFetch } as unknown as Env['PRINT'],
      PRINT_TOKEN: printToken,
    },
  );
}

async function upload(value = pack('預覽月報')) {
  const response = await request('/api/templates', zipSync(value.files));
  expect(
    response.status,
    response.status === 201 ? undefined : await response.clone().text(),
  ).toBe(201);
  return templateSummarySchema.parse(await response.json());
}

function preview(id: string, version: number | string) {
  return request(`/api/templates/${id}/versions/${version}/preview.pdf`);
}

async function error(response: Response, status: number, code: string) {
  expect(response.status).toBe(status);
  expect(response.headers.get('content-type')).toMatch(/^application\/json\b/i);
  const body = apiErrorSchema.parse(await response.json());
  expect(body.error.code).toBe(code);
  expect(body.error.message.trim().length).toBeGreaterThan(0);
  return body.error;
}

beforeAll(async () => {
  valid = await readPack(
    new URL(
      '../../../../packages/template-tools/fixtures/valid/',
      import.meta.url,
    ),
  );
  valid['assets/report.woff2'] = new Uint8Array(
    await readFile(
      new URL(
        '../../../print/src/test-fixtures/pack-font/report.woff2',
        import.meta.url,
      ),
    ),
  );
  platform = await getPlatformProxy<Env>({
    configPath: fileURLToPath(new URL('../../wrangler.jsonc', import.meta.url)),
    persist: false,
  });
  await migrate(drizzle(platform.env.DB), {
    migrationsFolder: fileURLToPath(new URL('../../drizzle', import.meta.url)),
  });
}, 60_000);

beforeEach(async () => {
  await drizzle(platform.env.DB).delete(templates);
  printFetch.mockReset();
  printFetch.mockImplementation(
    async () =>
      new Response(new Uint8Array(pdf), {
        headers: { 'content-type': 'application/pdf' },
      }),
  );
});

afterAll(async () => {
  await platform?.dispose();
}, 30_000);

test('preview prints each version’s own pack files and linked stylesheets with its filled sample and unchanged PDF bytes', async () => {
  const v1 = pack('第一版月報');
  const v2 = pack('第二版月報', false);
  const first = await upload(v1);
  const second = await upload(v2);
  expect([first.version, second.version]).toEqual([1, 2]);

  for (const [version, value, other] of [
    [first.version, v1, v2],
    [second.version, v2, v1],
  ] as const) {
    const response = await preview(first.id, version);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(
      /^application\/pdf\b/i,
    );
    expect(response.headers.get('content-disposition')).toMatch(
      new RegExp(
        `^inline;\\s*filename="?${first.id}-v${version}-preview\\.pdf"?(?:;|$)`,
        'i',
      ),
    );
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(pdf);
    expect(printFetch).toHaveBeenCalledTimes(version);
    const call = printFetch.mock.calls.at(-1);
    if (!call) throw new Error('Preview did not call PRINT');
    const sent = new Request(call[0], call[1]);
    expect(new URL(sent.url).pathname).toBe('/print');
    expect(sent.method).toBe('POST');
    expect(sent.headers.get('authorization')).toBe(`Bearer ${printToken}`);
    expect(sent.headers.get('content-type')).toMatch(/^application\/json\b/i);
    const body = (await sent.json()) as { html: string; page: unknown };
    expect(body).toEqual({
      html: expect.any(String),
      page: value.manifest.page,
      pack: {
        template: value.manifest.files.template,
        files: Object.fromEntries(
          Object.entries(value.files).map(([path, bytes]) => [
            path,
            Buffer.from(bytes).toString('base64'),
          ]),
        ),
      },
    });
    expect(body.html).toContain(`<h1 data-gt="title">${value.heading}</h1>`);
    expect(body.html).toContain(`${value.heading}範例有限公司`);
    expect(body.html).toContain('營收：123,456 元');
    expect(body.html).toContain('<tr><td>文具</td><td>2,345</td></tr>');
    expect(body.html).toContain('<tr><td>設備</td><td>6,789</td></tr>');
    expect(body.html).toContain(value.approved ? '>已核准</p>' : '>待核准</p>');
    expect(body.html).not.toContain(
      value.approved ? '>待核准</p>' : '>已核准</p>',
    );
    expect(body.html).not.toContain(other.heading);
    expect(body.html).not.toContain('{{');
    const head = /<head\b[^>]*>([\s\S]*?)<\/head>/i.exec(body.html)?.[1] ?? '';
    expect(head).not.toMatch(/<style\b/i);
    expect(head).toMatch(
      /<link rel="stylesheet" href="\.\.\/styles\/z-first\.css">\s*<link rel="stylesheet" href="\.\.\/styles\/a-last\.css">\s*$/,
    );
  }
});

test('the bundled platform-font pack previews with its root-relative stylesheet and complete files', async () => {
  await storeFixturePack(platform.env);
  const response = await preview(fixtureReport.manifest.id, 1);
  expect(response.status).toBe(200);
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(pdf);
  expect(printFetch).toHaveBeenCalledOnce();
  const call = printFetch.mock.calls[0];
  if (!call) throw new Error('Preview did not call PRINT');
  const body = (await new Request(...call).json()) as {
    html: string;
    pack: unknown;
  };
  expect(body.pack).toEqual({
    template: 'template.hbs',
    files: fixtureReport.files,
  });
  expect(body.html).toMatch(
    /<link rel="stylesheet" href="styles\.css">\s*<\/head>/,
  );
  expect(body.html).not.toMatch(/<style\b/i);
});

test.each([
  {
    status: 422,
    code: 'font_not_loaded',
    message: 'Some font faces did not load',
    details: ['Report Sans normal: error', 'Report Sans bold: error'],
  },
  {
    status: 413,
    code: 'pack_too_large',
    message: 'Pack exceeds the print size limit',
    details: [
      'assets/report.woff2 exceeds the file size limit',
      'Pack decoded size exceeds the total limit',
    ],
  },
])(
  'printer $status $code becomes preview_failed preserving the summary and ordered file details',
  async ({ status, code, message, details }) => {
    const uploaded = await upload();
    printFetch.mockResolvedValueOnce(
      Response.json(
        {
          error: {
            code,
            message,
            details: details.map(message => ({ message })),
          },
        },
        { status },
      ),
    );
    const failure = await error(
      await preview(uploaded.id, uploaded.version),
      422,
      'preview_failed',
    );
    expect(failure.details).toEqual([
      { message: `${code}: ${message}` },
      ...details.map(message => ({ message })),
    ]);
    expect(printFetch).toHaveBeenCalledOnce();
  },
);

test.each(['throws', 'non-JSON 502'])(
  'an unavailable printer (%s) returns a readable print_unavailable API error',
  async failure => {
    const uploaded = await upload();
    if (failure === 'throws') {
      printFetch.mockRejectedValueOnce(new Error('PRINT connection refused'));
    } else {
      printFetch.mockResolvedValueOnce(
        new Response('<html>Bad Gateway</html>', {
          status: 502,
          headers: { 'content-type': 'text/html' },
        }),
      );
    }
    await error(
      await preview(uploaded.id, uploaded.version),
      503,
      'print_unavailable',
    );
    expect(printFetch).toHaveBeenCalledOnce();
  },
);

test.each([
  ['unknown id', 'never-uploaded', '1'],
  ['absent version', 'taiwan-monthly-report', '2'],
  ['fractional version', 'taiwan-monthly-report', '1.5'],
  ['non-numeric version', 'taiwan-monthly-report', '1oops'],
])(
  '%s returns template_not_found without calling PRINT',
  async (_case, id, version) => {
    await upload();
    await error(await preview(id, version), 404, 'template_not_found');
    expect(printFetch).not.toHaveBeenCalled();
  },
);
