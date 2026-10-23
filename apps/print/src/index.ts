// Placeholder Worker until T07 builds the print service.
export default {
  fetch() {
    return new Response('pdf-generator print: placeholder');
  },
} satisfies ExportedHandler<Env>;
