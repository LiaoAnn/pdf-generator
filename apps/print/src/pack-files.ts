// The files a print's browser tab loads from this Worker by URL: the prepared
// document and the template pack's own files. They are kept in R2 under a
// new id for the duration of one print and served at /pack/<id>/<path>, so
// relative URLs resolve between them as between the pack's files. They are
// not pushed through request interception (T03 Must not 3).
import { Buffer } from 'node:buffer';
import { relativePathSchema } from '@pdf-generator/contract';
import type { PrintRequest } from './request.ts';

const mib = 1024 * 1024;

/**
 * Limits on a print request's pack files, in decoded bytes, and on the whole
 * body. The body is JSON with base64 files: parsed and decoded it takes about
 * twice the body in memory, which keeps a print well inside a Worker's 128 MB.
 */
export const packLimits = {
  /** One file; the largest platform font (LXGW WenKai TC) is 15.5 MB. */
  fileBytes: 16 * mib,
  totalBytes: 24 * mib,
  bodyBytes: 40 * mib,
} as const;

/** Where a print keeps its files: an R2 bucket has this shape. */
export interface PrintStore {
  put(
    key: string,
    value: Uint8Array | string,
    options?: { httpMetadata?: { contentType?: string } },
  ): Promise<unknown>;
  delete(keys: string[]): Promise<unknown>;
}

/** The document's path when the request has no pack. */
const defaultDocumentPath = 'index.html';

const decodedBytes = (base64: string) =>
  (base64.length / 4) * 3 - (base64.match(/=*$/)?.[0].length ?? 0);

/** What makes a request's pack files too large, if anything. */
export function packSizeIssues(pack: PrintRequest['pack']): string[] {
  const issues: string[] = [];
  let total = 0;
  for (const [path, base64] of Object.entries(pack?.files ?? {})) {
    const bytes = decodedBytes(base64);
    total += bytes;
    if (bytes > packLimits.fileBytes) {
      issues.push(
        `${path} is ${bytes} bytes, more than the limit of ${packLimits.fileBytes} per file`,
      );
    }
  }
  if (total > packLimits.totalBytes) {
    issues.push(
      `the pack files total ${total} bytes, more than the limit of ${packLimits.totalBytes}`,
    );
  }
  return issues;
}

const htmlType = 'text/html; charset=utf-8';
const contentTypes: Record<string, string> = {
  html: htmlType,
  css: 'text/css; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  woff2: 'font/woff2',
  woff: 'font/woff',
  ttf: 'font/ttf',
  otf: 'font/otf',
  json: 'application/json',
};

const contentType = (path: string) =>
  contentTypes[/\.([^./]+)$/.exec(path)?.[1]?.toLowerCase() ?? ''] ??
  'application/octet-stream';

/** A print's files while its tab is open. */
export interface PublishedFiles {
  /** URL of the document, which the tab navigates to. */
  documentUrl: string;
  /** Whether `url` is one of the print's files, the document included. */
  serves: (url: string) => boolean;
  /** Deletes the files; never rejects. */
  remove: () => Promise<void>;
}

/** The pack path of a `/pack/<id>/<path>` URL path, if it is one. */
function packFile(pathname: string): { id: string; path: string } | undefined {
  const match = /^\/pack\/([0-9a-f-]{36})\/(.+)$/.exec(pathname);
  if (!match) return undefined;
  const [, id = '', encoded = ''] = match;
  try {
    return { id, path: encoded.split('/').map(decodeURIComponent).join('/') };
  } catch {
    return undefined;
  }
}

/**
 * Stores the prepared document and the pack files under a new id. The
 * document takes the template's path (its pack file, if sent, is not needed).
 * Whatever was written is deleted by `remove`, also when a write failed.
 */
export async function publishFiles(
  store: PrintStore,
  origin: string,
  document: string,
  pack: PrintRequest['pack'],
): Promise<PublishedFiles> {
  const id = crypto.randomUUID();
  const keys: string[] = [];
  const url = (path: string) =>
    `${origin}/pack/${id}/${path.split('/').map(encodeURIComponent).join('/')}`;
  const put = (path: string, value: Uint8Array | string, type: string) => {
    keys.push(`${id}/${path}`);
    return store.put(`${id}/${path}`, value, {
      httpMetadata: { contentType: type },
    });
  };
  const remove = async () => {
    if (keys.length > 0) await store.delete(keys).catch(() => undefined);
  };
  const documentPath = pack?.template ?? defaultDocumentPath;
  const files = Object.entries(pack?.files ?? {}).filter(
    ([path]) => path !== documentPath,
  );
  // Every write settles before any is judged, so a failed print deletes
  // writes that were still running when another one failed.
  const writes = await Promise.allSettled([
    put(documentPath, document, htmlType),
    ...files.map(([path, base64]) =>
      put(
        path,
        new Uint8Array(Buffer.from(base64, 'base64')),
        contentType(path),
      ),
    ),
  ]);
  const failed = writes.find(write => write.status === 'rejected');
  if (failed) {
    await remove();
    throw failed.reason;
  }
  const paths = new Set([documentPath, ...files.map(([path]) => path)]);
  return {
    documentUrl: url(documentPath),
    serves: candidate => {
      const parsed = URL.parse(candidate);
      if (parsed?.origin !== origin) return false;
      const file = packFile(parsed.pathname);
      return file?.id === id && paths.has(file.path);
    },
    remove,
  };
}

/**
 * The only scripts the print page may run: the platform's runtime and
 * Paged.js. `'self'` would also admit a script among the pack's files, and
 * template code could forge the runtime's check results. No frames or
 * plugins, and no <base> to move relative URLs out of the pack.
 */
function printPolicy(origin: string): string {
  return [
    `script-src ${origin}/print-runtime.js ${origin}/paged.polyfill.js`,
    "object-src 'none'",
    "frame-src 'none'",
    "base-uri 'none'",
  ].join('; ');
}

/**
 * `GET /pack/<id>/<path>`: a file of a print in progress, or undefined when
 * the URL is not of that form. No bearer token: the browser can't send one,
 * and the id is a random UUID that exists only while its print runs.
 */
export async function servePackFile(
  bucket: R2Bucket,
  url: URL,
): Promise<Response | undefined> {
  const file = packFile(url.pathname);
  if (!file || !relativePathSchema.safeParse(file.path).success) {
    return undefined;
  }
  const object = await bucket.get(`${file.id}/${file.path}`);
  if (!object) return undefined;
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('Cache-Control', 'no-store');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Content-Security-Policy', printPolicy(url.origin));
  return new Response(object.body, { headers });
}
