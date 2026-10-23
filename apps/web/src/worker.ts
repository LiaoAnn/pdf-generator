// The Worker's request pipeline in front of TanStack Start.
export interface FetchHandlerOptions {
  /** TanStack Start's handler: pages and assets. */
  pages: (request: Request) => Promise<Response>;
}

export function createFetchHandler(
  options: FetchHandlerOptions,
): (request: Request, env: Env) => Promise<Response> {
  return async request => {
    const { pathname } = new URL(request.url);
    if (request.method === 'GET' && pathname === '/health') {
      return Response.json({ status: 'ok', service: 'web' });
    }
    return options.pages(request);
  };
}
