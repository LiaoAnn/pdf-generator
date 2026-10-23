// Placeholder Worker until T09 replaces this app with TanStack Start.
export default {
  fetch(request, _env, _ctx) {
    if (new URL(request.url).pathname === '/health') {
      return Response.json({ status: 'ok', service: 'web' });
    }
    return new Response('pdf-generator web: placeholder');
  },
} satisfies ExportedHandler<Env>;
