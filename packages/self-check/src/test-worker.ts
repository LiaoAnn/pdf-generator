import { gtSchema } from '@pdf-generator/contract';
import { checkPdf, readPdf } from './index.ts';

// Bundled by the workerd tests: exercise the public API in workerd. POST
// /check runs the self-check (gt.json in the `x-gt` header) and answers with
// its report; /allocate?mib=N holds N MiB of the heap; any other path answers
// with readPdf's document.
export default {
  async fetch(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (url.pathname === '/allocate') {
        // Holds `mib` MiB of numbers until it answers (the heap-cap premise).
        const held: number[][] = [];
        for (let i = 0; i < Number(url.searchParams.get('mib')); i++) {
          held.push(new Array(1 << 17).fill(i + 0.5));
        }
        return Response.json({ held: held.length });
      }
      const pdf = new Uint8Array(await request.arrayBuffer());
      if (url.pathname === '/check') {
        const gt = gtSchema.parse(
          JSON.parse(request.headers.get('x-gt') ?? ''),
        );
        return Response.json(await checkPdf(pdf, gt));
      }
      return Response.json(await readPdf(pdf));
    } catch (error) {
      return Response.json({ error: String(error) }, { status: 500 });
    }
  },
};
