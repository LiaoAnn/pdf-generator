// The platform API under /api. Each route is an Effect that answers with a
// Response or fails with an ApiFailure. Feature tickets add their routes to
// `routes` (T15: templates, T16: batches); `:name` segments are parameters.
import { Effect } from 'effect';
import type { Identity } from '../access/verify.ts';
import type { Services } from '../services.ts';
import {
  createBatch,
  downloadBatch,
  getBatch,
  listBatches,
  listFixtures,
  rerunBatch,
} from './batches.ts';
import { ApiFailure } from './errors.ts';
import { status } from './status.ts';
import {
  downloadPack,
  getTemplate,
  listTemplates,
  uploadTemplate,
} from './templates.ts';

export interface ApiRequest {
  request: Request;
  identity: Identity;
  /** Values of the route's `:name` segments, decoded. */
  params: Record<string, string>;
}

type Route = (
  input: ApiRequest,
) => Effect.Effect<Response, ApiFailure, Services>;

const routes: Record<string, Route> = {
  'GET /api/me': ({ identity }) => Effect.succeed(Response.json({ identity })),
  'GET /api/templates': () => listTemplates,
  'POST /api/templates': ({ request }) => uploadTemplate(request),
  'GET /api/templates/:id': ({ params }) => getTemplate(params.id ?? ''),
  'GET /api/templates/:id/versions/:version/pack.zip': ({ params }) =>
    downloadPack(params.id ?? '', params.version ?? ''),
  'GET /api/status': () => status,
  'GET /api/batches': () => listBatches,
  'POST /api/batches': ({ request }) => createBatch(request),
  'GET /api/batches/:id': ({ params }) => getBatch(params.id ?? ''),
  'GET /api/batches/:id/fixtures': ({ params }) =>
    listFixtures(params.id ?? ''),
  'POST /api/batches/:id/rerun': ({ params }) => rerunBatch(params.id ?? ''),
  'GET /api/batches/:id/zip': ({ params }) => downloadBatch(params.id ?? ''),
};

export function isApiPath(pathname: string): boolean {
  return pathname === '/api' || pathname.startsWith('/api/');
}

// The route for `method pathname` and its parameters, if one matches.
function match(
  method: string,
  pathname: string,
): { route: Route; params: Record<string, string> } | undefined {
  const segments = pathname.split('/');
  for (const [key, route] of Object.entries(routes)) {
    const [routeMethod, pattern = ''] = key.split(' ');
    const parts = pattern.split('/');
    if (routeMethod !== method || parts.length !== segments.length) continue;
    const params: Record<string, string> = {};
    const matches = parts.every((part, i) => {
      const segment = segments[i] ?? '';
      if (!part.startsWith(':')) return part === segment;
      if (segment === '') return false;
      try {
        params[part.slice(1)] = decodeURIComponent(segment);
      } catch {
        return false;
      }
      return true;
    });
    if (matches) return { route, params };
  }
  return undefined;
}

export function routeApi(
  input: Omit<ApiRequest, 'params'>,
): Effect.Effect<Response, ApiFailure, Services> {
  const { method } = input.request;
  const { pathname } = new URL(input.request.url);
  const found = match(method, pathname);
  if (!found) {
    return Effect.fail(
      new ApiFailure({
        status: 404,
        code: 'not_found',
        message: `No API route for ${method} ${pathname}.`,
      }),
    );
  }
  return found.route({ ...input, params: found.params });
}
