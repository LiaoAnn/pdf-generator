// The print Worker. Static assets (fonts, Paged.js, blank.html) are served
// before this handler runs; the print endpoint comes with T07's next slice.
export default {
  fetch() {
    return new Response('Not found', { status: 404 });
  },
} satisfies ExportedHandler<Env>;
