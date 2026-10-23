// The print Worker. Static assets (fonts, Paged.js, /blank) are served before
// this handler runs. `POST /print` turns a document into a PDF.
import puppeteer from '@cloudflare/puppeteer';
import type { ApiError } from '@pdf-generator/contract';
import { RenderError, renderPdf } from './lib.ts';
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

async function print(request: Request, env: PrintEnv): Promise<Response> {
  if (!env.PRINT_TOKEN) {
    return apiError(503, 'not_configured', 'PRINT_TOKEN is not set');
  }
  if (!(await authorized(request, env.PRINT_TOKEN))) {
    return apiError(401, 'unauthorized', 'Missing or wrong bearer token');
  }
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
  const browser = await puppeteer.launch(env.BROWSER);
  try {
    const result = await renderPdf(browser, parsed.data, {
      assetOrigin: env.ASSET_ORIGIN ?? new URL(request.url).origin,
    });
    return new Response(result.pdf, {
      headers: {
        'Content-Type': 'application/pdf',
        'X-Page-Count': String(result.pageCount),
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
    await browser.close();
  }
}

export default {
  async fetch(request, env: PrintEnv) {
    const { pathname } = new URL(request.url);
    if (pathname === '/print' && request.method === 'POST') {
      return print(request, env);
    }
    return apiError(
      404,
      'not_found',
      `No route for ${request.method} ${pathname}`,
    );
  },
} satisfies ExportedHandler<PrintEnv>;
