// The Worker's request pipeline in front of TanStack Start: a public health
// check, then the Cloudflare Access gate, then the API or the pages.
import { Effect } from 'effect';
import { type AccessConfig, authenticate } from './access/verify.ts';
import { ApiFailure, apiErrorResponse } from './api/errors.ts';
import { isApiPath, routeApi } from './api/router.ts';
import { provideServices } from './services.ts';

export interface FetchHandlerOptions {
  /** TanStack Start's handler: pages and assets. */
  pages: (request: Request) => Promise<Response>;
  /** The Access application to verify against; undefined refuses everything. */
  access: (env: Env) => AccessConfig | undefined;
  /** Runs before verification: the local Access stand-in in dev, absent in production. */
  edge?: (request: Request) => Promise<Request | Response>;
  /** Where the "not signed in" page sends people; Access's own login by default. */
  loginUrl?: string;
}

export function createFetchHandler(
  options: FetchHandlerOptions,
): (request: Request, env: Env) => Promise<Response> {
  const loginUrl = options.loginUrl ?? '/';

  return async (incoming, env) => {
    const { pathname } = new URL(incoming.url);
    if (incoming.method === 'GET' && pathname === '/health') {
      return Response.json({ status: 'ok', service: 'web' });
    }
    const api = isApiPath(pathname);

    // The edge sits in front of the Worker, as the real Access edge does.
    const request = options.edge ? await options.edge(incoming) : incoming;
    if (request instanceof Response) return request;

    const config = options.access(env);
    if (!config) {
      return refuse(api, {
        status: 503,
        code: 'access_not_configured',
        message: 'Cloudflare Access is not configured for this site.',
        page: '<p>網站尚未設定 Cloudflare Access，暫不開放。</p>',
      });
    }

    const handle = Effect.gen(function* () {
      const identity = yield* authenticate(request, config);
      if (api) {
        return yield* routeApi({ request, identity }).pipe(
          provideServices(env),
        );
      }
      return yield* Effect.promise(() => options.pages(request));
    });

    return Effect.runPromise(
      handle.pipe(
        Effect.catchTag('Unauthenticated', () =>
          Effect.succeed(
            refuse(api, {
              status: 401,
              code: 'unauthenticated',
              message:
                'Sign in with Cloudflare Access or send a service token.',
              page: `<p>請先登入。</p><p><a href="${loginUrl}">登入</a></p>`,
            }),
          ),
        ),
        Effect.catchTag('ApiFailure', failure =>
          Effect.succeed(apiErrorResponse(failure)),
        ),
      ),
    );
  };
}

function refuse(
  api: boolean,
  error: { status: number; code: string; message: string; page: string },
): Response {
  if (api) {
    return apiErrorResponse(
      new ApiFailure({
        status: error.status,
        code: error.code,
        message: error.message,
      }),
    );
  }
  return new Response(
    `<!doctype html><html lang="zh-Hant-TW"><head><meta charset="utf-8"><title>PDF Fixtures</title></head><body>${error.page}</body></html>`,
    {
      status: error.status,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    },
  );
}
