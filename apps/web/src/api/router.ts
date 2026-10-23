// The platform API under /api. Each route is an Effect that answers with a
// Response or fails with an ApiFailure. Feature tickets add their routes to
// `routes` (T15: templates, T16: batches).
import { Effect } from 'effect';
import type { Identity } from '../access/verify.ts';
import { ApiFailure } from './errors.ts';

export interface ApiRequest {
  request: Request;
  identity: Identity;
}

type Route = (input: ApiRequest) => Effect.Effect<Response, ApiFailure>;

const routes: Record<string, Route> = {
  'GET /api/me': ({ identity }) => Effect.succeed(Response.json({ identity })),
};

export function isApiPath(pathname: string): boolean {
  return pathname === '/api' || pathname.startsWith('/api/');
}

export function routeApi(
  input: ApiRequest,
): Effect.Effect<Response, ApiFailure> {
  const { pathname } = new URL(input.request.url);
  const route = routes[`${input.request.method} ${pathname}`];
  if (!route) {
    return Effect.fail(
      new ApiFailure({
        status: 404,
        code: 'not_found',
        message: `No API route for ${input.request.method} ${pathname}.`,
      }),
    );
  }
  return route(input);
}
