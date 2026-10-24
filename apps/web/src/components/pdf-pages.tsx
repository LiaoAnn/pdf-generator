import { useEffect, useRef, useState } from 'react';
import { getDocumentProxy } from 'unpdf';

/**
 * A PDF drawn page by page on canvases with pdf.js (unpdf's build runs
 * without a worker), so it shows in browsers without a PDF viewer too.
 */
export function PdfPages({ pdf, title }: { pdf: ArrayBuffer; title: string }) {
  const container = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState<string>();

  useEffect(() => {
    const root = container.current;
    if (!root) return;
    let current = true;
    root.textContent = '';
    (async () => {
      // pdf.js may detach the buffer it gets; give it a copy.
      const document = await getDocumentProxy(new Uint8Array(pdf.slice(0)));
      try {
        for (let n = 1; n <= document.numPages && current; n++) {
          const page = await document.getPage(n);
          const width = root.clientWidth || 800;
          const unscaled = page.getViewport({ scale: 1 });
          const scale = (width / unscaled.width) * window.devicePixelRatio;
          const viewport = page.getViewport({ scale });
          const canvas = globalThis.document.createElement('canvas');
          canvas.width = Math.floor(viewport.width);
          canvas.height = Math.floor(viewport.height);
          canvas.style.width = '100%';
          canvas.className = 'rounded-md border bg-white shadow-sm';
          canvas.setAttribute('aria-label', `${title} 第 ${n} 頁`);
          const context = canvas.getContext('2d');
          if (!context) throw new Error('no 2d canvas');
          await page.render({ canvas, canvasContext: context, viewport })
            .promise;
          if (current) root.appendChild(canvas);
        }
      } finally {
        await document.loadingTask.destroy();
      }
    })().catch(error => {
      if (current) setFailed(String(error));
    });
    return () => {
      current = false;
    };
  }, [pdf, title]);

  return (
    <div className="flex flex-col gap-4">
      {failed ? (
        <p className="text-destructive text-sm">PDF 無法顯示：{failed}</p>
      ) : null}
      <div ref={container} className="flex flex-col gap-4" />
    </div>
  );
}
