import { Buffer } from 'node:buffer';
import { gtSchema } from '@pdf-generator/contract';
import { describe, expect, test, vi } from 'vitest';
import gtExample from '../../../../packages/contract/examples/gt.valid.json';
import {
  createBatchPrinters,
  createPrinter,
  type Printer,
  PrintFailure,
} from './printer.ts';

const gt = gtSchema.parse(gtExample);
const request: Parameters<Printer['print']>[0] = {
  html: '<html><head></head><body>測試</body></html>',
  page: { size: 'A4', orientation: 'landscape' },
  source: gt.source,
  pack: {
    template: 'pages/report.html',
    files: {
      'pages/report.html': 'PGh0bWw+',
      'fonts/report.woff2': 'AAEAgP8=',
    },
  },
};
const pdf = new Uint8Array([37, 80, 68, 70, 0, 128, 255, 10]);
type Fetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

function answer(session?: string) {
  return Response.json(
    { pageCount: 2, pdf: Buffer.from(pdf).toString('base64'), gt },
    {
      headers: session ? { 'X-Browser-Session': session } : {},
    },
  );
}

describe('print Worker service adapter', () => {
  test('posts the authenticated print contract and decodes binary PDF bytes without corruption', async () => {
    const fetch = vi.fn<Fetch>().mockResolvedValue(answer());
    const result = await createPrinter({ fetch }, 'test-print-token').print(
      request,
    );
    expect(fetch).toHaveBeenCalledTimes(1);
    const call = fetch.mock.calls[0];
    if (!call) throw new Error('No print request');
    const sent = new Request(...call);
    expect(new URL(sent.url).pathname).toBe('/print');
    expect(sent.method).toBe('POST');
    expect(sent.headers.get('authorization')).toBe('Bearer test-print-token');
    expect(sent.headers.get('content-type')).toMatch(/^application\/json\b/i);
    expect(await sent.json()).toEqual(request);
    expect(result).toEqual({ pageCount: 2, pdf, gt });
  });

  test.each([
    { status: 401, code: 'unauthorized' },
    { status: 422, code: 'ground_truth_invalid' },
    { status: 503, code: 'not_configured' },
  ])(
    'preserves HTTP $status and error code $code for retry decisions',
    async ({ status, code }) => {
      const fetch = vi.fn<Fetch>().mockResolvedValue(
        Response.json(
          {
            error: {
              code,
              message: 'Printing failed',
              details: [{ message: 'detail' }],
            },
          },
          { status },
        ),
      );
      const promise = createPrinter({ fetch }, 'token').print(request);
      await expect(promise).rejects.toBeInstanceOf(PrintFailure);
      await expect(promise).rejects.toMatchObject({ status, code });
    },
  );

  test.each([
    {
      label: 'plain-text proxy error',
      response: () => new Response('Unavailable', { status: 503 }),
    },
    {
      label: 'JSON without an error code',
      response: () =>
        Response.json({ message: 'Unavailable' }, { status: 503 }),
    },
    {
      label: 'non-200 successful status',
      response: () => new Response(null, { status: 204 }),
    },
  ])(
    'wraps $label in PrintFailure with a nonempty fallback code',
    async ({ response }) => {
      const value = response();
      const promise = createPrinter(
        { fetch: vi.fn<Fetch>().mockResolvedValue(value) },
        'token',
      ).print(request);
      await expect(promise).rejects.toBeInstanceOf(PrintFailure);
      await expect(promise).rejects.toMatchObject({
        status: value.status,
        code: expect.stringMatching(/\S+/),
      });
    },
  );

  test('maps a rejected service fetch to PrintFailure status zero instead of leaking a transport error', async () => {
    const fetch = vi
      .fn<Fetch>()
      .mockRejectedValue(new TypeError('connection lost'));
    const promise = createPrinter({ fetch }, 'token').print(request);
    await expect(promise).rejects.toBeInstanceOf(PrintFailure);
    await expect(promise).rejects.toMatchObject({
      status: 0,
      code: expect.stringMatching(/\S+/),
    });
  });
});

describe('browser session reuse', () => {
  test('starts new without an idle session and reuses the id returned by the Worker', async () => {
    const sent: string[] = [];
    const fetch: Fetch = async (input, init) => {
      sent.push(
        new Request(input, init).headers.get('X-Browser-Session') ?? '',
      );
      return answer('session-a');
    };
    const printer = createPrinter({ fetch }, 'token');
    await printer.print(request);
    await printer.print(request);
    expect(sent).toEqual(['new', 'session-a']);
  });

  test('never lends an in-flight session twice and recycles each returned id after completion', async () => {
    const pending: {
      session: string | null;
      resolve: (response: Response) => void;
    }[] = [];
    const fetch: Fetch = (input, init) =>
      new Promise(resolve => {
        pending.push({
          session: new Request(input, init).headers.get('X-Browser-Session'),
          resolve,
        });
      });
    const printer = createPrinter({ fetch }, 'token');
    async function call(number: number) {
      const result = printer.print(request);
      await vi.waitFor(() => expect(pending).toHaveLength(number));
      return { result };
    }
    const first = await call(1);
    const second = await call(2);
    expect(pending.map(p => p.session)).toEqual(['new', 'new']);
    pending[0]?.resolve(answer('session-a'));
    await first.result;

    const third = await call(3);
    expect(pending[2]?.session).toBe('session-a');
    const fourth = await call(4);
    expect(pending[3]?.session).toBe('new');

    // Complete in a different order than dispatch: each response owns its own id.
    pending[1]?.resolve(answer('session-b'));
    await second.result;
    const fifth = await call(5);
    expect(pending[4]?.session).toBe('session-b');
    pending[2]?.resolve(answer('session-a'));
    pending[3]?.resolve(answer('session-c'));
    pending[4]?.resolve(answer('session-b'));
    await Promise.all([third.result, fourth.result, fifth.result]);

    const sixth = await call(6);
    const seventh = await call(7);
    const eighth = await call(8);
    expect(new Set(pending.slice(5).map(p => p.session))).toEqual(
      new Set(['session-a', 'session-b', 'session-c']),
    );
    for (const entry of pending.slice(5))
      entry.resolve(answer(entry.session ?? undefined));
    await Promise.all([sixth.result, seventh.result, eighth.result]);
  });
});

describe('browser session cleanup', () => {
  test.each([200, 422])(
    'closes all idle HTTP %s sessions with authenticated encoded DELETEs exactly once',
    async status => {
      const ids = ['session/a?x=1', 'session-b'];
      const calls: Request[] = [];
      const fetch: Fetch = async (input, init) => {
        const sent = new Request(input, init);
        calls.push(sent);
        if (sent.method === 'DELETE')
          return new Response(null, { status: 204 });
        const id = ids.shift();
        return status === 200
          ? answer(id)
          : Response.json(
              { error: { code: 'invalid_layout', message: 'bad layout' } },
              { status, headers: { 'x-browser-session': id ?? '' } },
            );
      };
      const printer = createPrinter({ fetch }, 'cleanup-token');
      const results = await Promise.allSettled([
        printer.print(request),
        printer.print(request),
      ]);
      expect(results.map(result => result.status)).toEqual(
        status === 200 ? ['fulfilled', 'fulfilled'] : ['rejected', 'rejected'],
      );
      await printer.close();
      await printer.close();
      const deletes = calls.filter(call => call.method === 'DELETE');
      expect(deletes.map(call => call.url).sort()).toEqual(
        [
          'https://print.internal/session/session%2Fa%3Fx%3D1',
          'https://print.internal/session/session-b',
        ].sort(),
      );
      for (const sent of deletes)
        expect(sent.headers.get('authorization')).toBe('Bearer cleanup-token');
    },
  );

  test.each([200, 422])(
    'deletes a session returned by an in-flight HTTP %s print after close',
    async status => {
      const deletes: string[] = [];
      let respond: ((response: Response) => void) | undefined;
      const fetch: Fetch = async (input, init) => {
        const sent = new Request(input, init);
        if (sent.method === 'DELETE') {
          deletes.push(sent.url);
          return new Response(null, { status: 204 });
        }
        return new Promise(resolve => {
          respond = resolve;
        });
      };
      const printer = createPrinter({ fetch }, 'token');
      const result = Promise.allSettled([printer.print(request)]);
      await vi.waitFor(() => expect(respond).toBeDefined());
      await printer.close();
      expect(deletes).toEqual([]);
      respond?.(
        status === 200
          ? answer('late-session')
          : Response.json(
              { error: { code: 'invalid_layout', message: 'bad layout' } },
              { status, headers: { 'x-browser-session': 'late-session' } },
            ),
      );
      expect((await result)[0]?.status).toBe(
        status === 200 ? 'fulfilled' : 'rejected',
      );
      await vi.waitFor(() =>
        expect(deletes).toEqual([
          'https://print.internal/session/late-session',
        ]),
      );
      await printer.close();
      expect(deletes).toHaveLength(1);
    },
  );

  test.each(['throw', '404'] as const)(
    'cleanup %s does not reject, skip other sessions, or DELETE twice',
    async failure => {
      const deletes: string[] = [];
      let next = 0;
      const fetch: Fetch = async (input, init) => {
        const sent = new Request(input, init);
        if (sent.method !== 'DELETE') return answer(`session-${next++}`);
        deletes.push(sent.url);
        if (deletes.length === 1) {
          if (failure === 'throw') throw new Error('connection lost');
          return Response.json(
            { error: { code: 'session_not_found' } },
            { status: 404 },
          );
        }
        return new Response(null, { status: 204 });
      };
      const printer = createPrinter({ fetch }, 'token');
      await Promise.all([printer.print(request), printer.print(request)]);
      await expect(printer.close()).resolves.toBeUndefined();
      await expect(printer.close()).resolves.toBeUndefined();
      expect(deletes.sort()).toEqual([
        'https://print.internal/session/session-0',
        'https://print.internal/session/session-1',
      ]);
    },
  );
});

const digest = 'd'.repeat(64);

/**
 * A print Worker for batch printers: PUT /batch/<id>/pack answers `upload`
 * (the digest by default), POST /print answers `printed` (a PDF with a new
 * session by default), DELETE answers 204. Records every request.
 */
function printWorker({
  upload = async () => Response.json({ digest }),
  printed,
}: {
  upload?: (sent: Request) => Promise<Response>;
  printed?: (sent: Request) => Promise<Response>;
} = {}) {
  const calls: Request[] = [];
  let next = 0;
  const fetch: Fetch = async (input, init) => {
    const sent = new Request(input, init);
    calls.push(new Request(input, init));
    if (sent.method === 'DELETE') return new Response(null, { status: 204 });
    if (sent.method === 'PUT') return upload(sent);
    if (printed) return printed(sent);
    const session = sent.headers.get('x-browser-session');
    return answer(
      session === 'new' ? `session-${next++}` : (session ?? undefined),
    );
  };
  const of = (method: string) => calls.filter(call => call.method === method);
  return { fetch, calls, of };
}

const reference = (batch: string) => ({
  template: request.pack.template,
  batch,
  digest,
});

describe('batch-owned printers', () => {
  test('reuses within a batch, isolates other batches, and forgets a closed batch without closing its neighbor', async () => {
    const worker = printWorker();
    const batches = createBatchPrinters(worker, 'token');
    await batches.for('a').print(request);
    await batches.for('a').print(request);
    await batches.for('b').print(request);
    await batches.close('a');
    await batches.close('a');
    await batches.close('unknown');
    await batches.for('b').print(request);
    await batches.for('a').print(request);
    expect(
      worker.of('POST').map(call => call.headers.get('x-browser-session')),
    ).toEqual(['new', 'session-0', 'new', 'session-1', 'new']);
    expect(
      worker
        .of('DELETE')
        .map(call => call.url)
        .filter(url => url.includes('/session/')),
    ).toEqual(['https://print.internal/session/session-0']);
  });

  test('forgets a batch even when its session DELETE throws', async () => {
    const sessions: (string | null)[] = [];
    const fetch: Fetch = async (input, init) => {
      const sent = new Request(input, init);
      if (sent.method === 'DELETE') throw new Error('offline');
      if (sent.method === 'PUT') return Response.json({ digest });
      sessions.push(sent.headers.get('x-browser-session'));
      return answer('old-session');
    };
    const batches = createBatchPrinters({ fetch }, 'token');
    await batches.for('a').print(request);
    await expect(batches.close('a')).resolves.toBeUndefined();
    await batches.for('a').print(request);
    expect(sessions).toEqual(['new', 'new']);
  });
});

// T07-5: a batch sends its pack's files to the print Worker once and prints
// by reference to them, so the browser can keep them between prints.
describe('batch pack upload', () => {
  // Regression: resending the files with every print (up to 24 MiB each)
  // is what the batch-scoped upload replaces.
  test('uploads the pack once for 10 prints and sends each print only its reference', async () => {
    const worker = printWorker();
    const printer = createBatchPrinters(worker, 'batch-token').for('batch-1');
    for (let i = 0; i < 10; i++) await printer.print(request);

    const puts = worker.of('PUT');
    expect(puts).toHaveLength(1);
    const [put] = puts;
    if (!put) throw new Error('No upload');
    expect(put.url).toBe('https://print.internal/batch/batch-1/pack');
    expect(put.headers.get('authorization')).toBe('Bearer batch-token');
    expect(put.headers.get('content-type')).toMatch(/^application\/json\b/i);
    expect(await put.json()).toEqual({ files: request.pack.files });

    const posts = worker.of('POST');
    expect(posts).toHaveLength(10);
    for (const post of posts) {
      expect(await post.json()).toEqual({
        ...request,
        pack: reference('batch-1'),
      });
    }
  });

  // Regression: each of the first concurrent prints (a queue delivery runs
  // up to 4 at once) uploading the pack itself.
  test('concurrent first prints share one upload', async () => {
    let finish: (response: Response) => void = () => {};
    const worker = printWorker({
      upload: () =>
        new Promise(resolve => {
          finish = resolve;
        }),
    });
    const printer = createBatchPrinters(worker, 'token').for('batch-1');
    const prints = Promise.all(
      Array.from({ length: 4 }, () => printer.print(request)),
    );
    await vi.waitFor(() => expect(worker.of('PUT')).toHaveLength(1));
    finish(Response.json({ digest }));
    await prints;
    expect(worker.of('PUT')).toHaveLength(1);
    expect(worker.of('POST')).toHaveLength(4);
  });

  // Regression: a print Worker that lost the copy (swept, or ended by
  // another isolate) failing the rest of the batch; or retrying forever.
  test('uploads again once when print answers pack_not_uploaded, then gives up', async () => {
    const notUploaded = () =>
      Response.json(
        { error: { code: 'pack_not_uploaded', message: 'gone' } },
        { status: 409 },
      );
    let refusals = 1;
    const worker = printWorker({
      printed: async () => (refusals-- > 0 ? notUploaded() : answer()),
    });
    const printer = createBatchPrinters(worker, 'token').for('batch-1');
    await expect(printer.print(request)).resolves.toMatchObject({
      pageCount: 2,
    });
    expect(worker.of('PUT')).toHaveLength(2);
    expect(worker.of('POST')).toHaveLength(2);

    refusals = 2;
    const failed = printer.print(request);
    await expect(failed).rejects.toBeInstanceOf(PrintFailure);
    await expect(failed).rejects.toMatchObject({
      status: 409,
      code: 'pack_not_uploaded',
    });
    expect(worker.of('PUT')).toHaveLength(3);
    expect(worker.of('POST')).toHaveLength(4);
  });

  // Regression: a printer that keeps the first upload's digest for another
  // pack prints the old template's files.
  test('a pack with other files is uploaded again', async () => {
    const worker = printWorker();
    const printer = createBatchPrinters(worker, 'token').for('batch-1');
    const changed = {
      ...request,
      pack: {
        ...request.pack,
        files: { ...request.pack.files, 'fonts/report.woff2': 'AAEAgP4=' },
      },
    };
    await printer.print(request);
    await printer.print(changed);
    await printer.print(changed);
    const uploads = await Promise.all(worker.of('PUT').map(put => put.json()));
    expect(uploads).toEqual([
      { files: request.pack.files },
      { files: changed.pack.files },
    ]);
  });

  // Regression: an upload failure surfacing as an unreadable body (no retry
  // decision possible), or a failed upload remembered for the whole batch.
  test('a failed upload fails the print with its status and code, and the next print uploads again', async () => {
    let refuse = true;
    const worker = printWorker({
      upload: async () =>
        refuse
          ? Response.json(
              {
                error: {
                  code: 'pack_too_large',
                  message: 'too large',
                  details: [{ message: 'fonts/report.woff2 is too large' }],
                },
              },
              { status: 413 },
            )
          : Response.json({ digest }),
    });
    const printer = createBatchPrinters(worker, 'token').for('batch-1');
    const failed = printer.print(request);
    await expect(failed).rejects.toBeInstanceOf(PrintFailure);
    await expect(failed).rejects.toMatchObject({
      status: 413,
      code: 'pack_too_large',
      details: ['fonts/report.woff2 is too large'],
    });
    expect(worker.of('POST')).toHaveLength(0);

    refuse = false;
    await printer.print(request);
    expect(worker.of('PUT')).toHaveLength(2);
    expect(worker.of('POST')).toHaveLength(1);
  });

  test('an unreachable print Worker during the upload is status zero', async () => {
    const worker = printWorker({
      upload: async () => {
        throw new Error('offline');
      },
    });
    const failed = createBatchPrinters(worker, 'token')
      .for('batch-1')
      .print(request);
    await expect(failed).rejects.toMatchObject({
      status: 0,
      code: 'print_unreachable',
    });
  });

  // Regression: the copy outliving its batch until the print Worker's sweep
  // (a day), also when another isolate printed the batch's fixtures.
  test('closing a batch ends its pack copy at the print Worker, also for a batch this isolate never printed, and never rejects', async () => {
    const worker = printWorker();
    const batches = createBatchPrinters(worker, 'close-token');
    await batches.for('batch-1').print(request);
    await batches.close('batch-1');
    await batches.close('batch-2');
    const ends = worker
      .of('DELETE')
      .filter(call => !call.url.includes('/session/'));
    expect(ends.map(call => call.url)).toEqual([
      'https://print.internal/batch/batch-1',
      'https://print.internal/batch/batch-2',
    ]);
    for (const end of ends) {
      expect(end.headers.get('authorization')).toBe('Bearer close-token');
    }

    const offline = createBatchPrinters(
      {
        fetch: async () => {
          throw new Error('offline');
        },
      },
      'token',
    );
    await expect(offline.close('batch-1')).resolves.toBeUndefined();
  });

  // Regression: the preview (no batch) depending on an upload it never
  // ends; it keeps sending its files inline.
  test('a printer without a batch keeps sending the files inline', async () => {
    const worker = printWorker();
    await createPrinter(worker, 'token').print(request);
    expect(worker.of('PUT')).toHaveLength(0);
    const [post] = worker.of('POST');
    expect(await post?.json()).toEqual(request);
  });
});
