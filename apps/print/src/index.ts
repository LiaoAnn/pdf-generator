// The print Worker. Static assets (fonts, Paged.js, /blank) are served before
// this handler runs. `POST /print` turns a document into a PDF;
// `DELETE /session/<id>` closes a kept-alive browser session.
import { Buffer } from 'node:buffer';
import puppeteer from '@cloudflare/puppeteer';
import type { ApiError } from '@pdf-generator/contract';
// T08's reader; a stub with its signature until @pdf-generator/ground-truth
// merges.
import { readGroundTruth } from './ground-truth-stub.ts';
import { openBrowser, RenderError, renderPdf } from './lib.ts';
import { printRequestSchema } from './request.ts';

interface PrintEnv extends Env {
  /** Bearer token callers of `/print` must send (a secret). */
  PRINT_TOKEN?: string;
  /**
   * Public origin of this Worker, which the browser loads assets from. Only
   * needed when the request's own URL isn't reachable by the browser, e.g.
   * when called through a service binding.
   */
  ASSET_ORIGIN?: string;
}

function apiError(
  status: number,
  code: string,
  message: string,
  details?: NonNullable<ApiError['error']['details']>,
): Response {
  const body: ApiError = {
    error: { code, message, ...(details?.length ? { details } : {}) },
  };
  return Response.json(body, { status });
}

async function authorized(request: Request, token: string): Promise<boolean> {
  const header = request.headers.get('authorization') ?? '';
  const match = /^Bearer (.+)$/.exec(header);
  if (!match?.[1]) return false;
  const encoder = new TextEncoder();
  const [given, expected] = await Promise.all(
    [match[1], token].map(value =>
      crypto.subtle.digest('SHA-256', encoder.encode(value)),
    ),
  );
  return crypto.subtle.timingSafeEqual(
    given as ArrayBuffer,
    expected as ArrayBuffer,
  );
}

// The bearer token check every route shares; undefined when it passes.
async function denied(
  request: Request,
  env: PrintEnv,
): Promise<Response | undefined> {
  if (!env.PRINT_TOKEN) {
    return apiError(503, 'not_configured', 'PRINT_TOKEN is not set');
  }
  if (!(await authorized(request, env.PRINT_TOKEN))) {
    return apiError(401, 'unauthorized', 'Missing or wrong bearer token');
  }
  return undefined;
}

async function print(request: Request, env: PrintEnv): Promise<Response> {
  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return apiError(400, 'invalid_request', 'Body is not valid JSON');
  }
  const parsed = printRequestSchema.safeParse(json);
  if (!parsed.success) {
    return apiError(
      400,
      'invalid_request',
      'Body is not a print request',
      parsed.error.issues.map(issue => ({
        message: issue.message,
        path: issue.path.filter(
          (key): key is string | number => typeof key !== 'symbol',
        ),
      })),
    );
  }
  // X-Browser-Session: `new` or a session id keeps the browser for the next
  // request (a batch); the response names the session to send next time.
  const session = request.headers.get('x-browser-session') ?? undefined;
  const { browser, sessionId, release } = await openBrowser(env.BROWSER, {
    session,
  });
  const { source } = parsed.data;
  try {
    // With a source, the ground truth is read on the paginated tab right
    // before it is printed (T03 Must 3).
    const result = await renderPdf(browser, parsed.data, {
      assetOrigin: env.ASSET_ORIGIN ?? new URL(request.url).origin,
      ...(source ? { inspect: page => readGroundTruth(page, source) } : {}),
    });
    if (result.inspected) {
      return Response.json(
        {
          pageCount: result.pageCount,
          pdf: Buffer.from(result.pdf).toString('base64'),
          gt: result.inspected,
        },
        {
          headers: {
            'X-Page-Count': String(result.pageCount),
            ...(sessionId ? { 'X-Browser-Session': sessionId } : {}),
          },
        },
      );
    }
    return new Response(result.pdf, {
      headers: {
        'Content-Type': 'application/pdf',
        'X-Page-Count': String(result.pageCount),
        ...(sessionId ? { 'X-Browser-Session': sessionId } : {}),
      },
    });
  } catch (error) {
    if (error instanceof RenderError) {
      return apiError(
        422,
        error.code,
        error.message,
        error.details.map(message => ({ message })),
      );
    }
    throw error;
  } finally {
    await release();
  }
}

async function closeSession(env: PrintEnv, id: string): Promise<Response> {
  let browser: Awaited<ReturnType<typeof puppeteer.connect>>;
  try {
    browser = await puppeteer.connect(env.BROWSER, id);
  } catch {
    return apiError(404, 'session_not_found', `No browser session ${id}`);
  }
  await browser.close();
  return new Response(null, { status: 204 });
}

export default {
  async fetch(request, env: PrintEnv) {
    const { pathname } = new URL(request.url);
    const session = /^\/session\/([^/]+)$/.exec(pathname)?.[1];
    if (pathname === '/print' && request.method === 'POST') {
      return (await denied(request, env)) ?? print(request, env);
    }
    if (session && request.method === 'DELETE') {
      return (
        (await denied(request, env)) ??
        closeSession(env, decodeURIComponent(session))
      );
    }
    return apiError(
      404,
      'not_found',
      `No route for ${request.method} ${pathname}`,
    );
  },
} satisfies ExportedHandler<PrintEnv>;
