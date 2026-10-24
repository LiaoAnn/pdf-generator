import { type ReactNode, useEffect, useRef, useState } from 'react';
import { getDocumentProxy } from 'unpdf';

type PdfDocument = Awaited<ReturnType<typeof getDocumentProxy>>;

/**
 * A PDF drawn page by page on canvases with pdf.js (unpdf's build runs
 * without a worker), so it shows in browsers without a PDF viewer too.
 * `overlay(n)` is drawn over page n, in a box that covers the page exactly.
 */
export function PdfPages({
  pdf,
  title,
  overlay,
}: {
  pdf: ArrayBuffer;
  title: string;
  overlay?: (page: number) => ReactNode;
}) {
  const container = useRef<HTMLDivElement>(null);
  const canvases = useRef<(HTMLCanvasElement | null)[]>([]);
  const [document, setDocument] = useState<PdfDocument>();
  const [failed, setFailed] = useState<string>();

  useEffect(() => {
    let current = true;
    let loaded: PdfDocument | undefined;
    setDocument(undefined);
    setFailed(undefined);
    // pdf.js may detach the buffer it gets; give it a copy.
    getDocumentProxy(new Uint8Array(pdf.slice(0)))
      .then(proxy => {
        loaded = proxy;
        if (current) setDocument(proxy);
        else void proxy.loadingTask.destroy();
      })
      .catch(error => {
        if (current) setFailed(String(error));
      });
    return () => {
      current = false;
      if (loaded) void loaded.loadingTask.destroy();
    };
  }, [pdf]);

  useEffect(() => {
    if (!document) return;
    let current = true;
    (async () => {
      const width = container.current?.clientWidth || 800;
      for (let n = 1; n <= document.numPages && current; n++) {
        const canvas = canvases.current[n - 1];
        if (!canvas) continue;
        const page = await document.getPage(n);
        const unscaled = page.getViewport({ scale: 1 });
        const scale = (width / unscaled.width) * window.devicePixelRatio;
        const viewport = page.getViewport({ scale });
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        const context = canvas.getContext('2d');
        if (!context) throw new Error('no 2d canvas');
        await page.render({ canvas, canvasContext: context, viewport }).promise;
      }
    })().catch(error => {
      if (current) setFailed(String(error));
    });
    return () => {
      current = false;
    };
  }, [document]);

  const pages = Array.from(
    { length: document?.numPages ?? 0 },
    (_, i) => i + 1,
  );
  return (
    <div className="flex flex-col gap-4">
      {failed ? (
        <p className="text-destructive text-sm">PDF 無法顯示：{failed}</p>
      ) : null}
      <div ref={container} className="flex flex-col gap-4">
        {pages.map(n => (
          <div key={n} className="relative" data-page={n}>
            <canvas
              ref={canvas => {
                canvases.current[n - 1] = canvas;
              }}
              aria-label={`${title} 第 ${n} 頁`}
              className="block w-full rounded-md bg-white shadow-sm ring-1 ring-border"
            />
            {overlay ? (
              <div className="absolute inset-0">{overlay(n)}</div>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}
