import { readPdf } from './index.ts';

// Bundled by the reader acceptance test: exercise the public API in workerd.
export default {
  async fetch(request: Request): Promise<Response> {
    try {
      const pdf = new Uint8Array(await request.arrayBuffer());
      return Response.json(await readPdf(pdf));
    } catch (error) {
      return Response.json({ error: String(error) }, { status: 500 });
    }
  },
};
