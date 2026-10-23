import { Buffer } from 'node:buffer';
import { gtSchema } from '@pdf-generator/contract';
import { describe, expect, test, vi } from 'vitest';
import gtExample from '../../../../packages/contract/examples/gt.valid.json';
import { createPrinter, type Printer, PrintFailure } from './printer.ts';

const gt = gtSchema.parse(gtExample);
const request: Parameters<Printer['print']>[0] = {
  html: '<html><head></head><body>測試</body></html>',
  page: { size: 'A4', orientation: 'landscape' },
  source: gt.source,
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
