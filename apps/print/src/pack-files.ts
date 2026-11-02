// The files a print's browser tab loads from this Worker by URL: the prepared
// document and the template pack's own files, never pushed through request
// interception (T03 Must not 3). A print with inline pack files keeps them in
// R2 under a new id for the duration of one print and serves them at
// /pack/<id>/<path>. A batch instead uploads its pack once, as
// PUT /batch/<batch>/pack: the files stay at batch/<batch>/<digest>/pack/…,
// where the digest names their exact bytes, and are served immutable at
// /batch/<batch>/<digest>/<path>; only each print's prepared document is
// per print, at batch/<batch>/<digest>/print/<printId>, served at the same
// /batch/<batch>/<digest>/<path> with ?print=<printId>. Either way relative
// URLs resolve between the document and the pack files as in the pack.
// A batch's copy lives only as long as its batch: DELETE /batch/<batch>
// deletes it, and the sweep (started in the background after each upload)
// deletes every upload whose index is older than a batch's 24 hours, so an
// end that never arrived still frees the bucket.
import { Buffer } from 'node:buffer';
import { relativePathSchema } from '@pdf-generator/contract';

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
    options?: {
      httpMetadata?: { contentType?: string };
      customMetadata?: Record<string, string>;
    },
  ): Promise<unknown>;
  delete(keys: string[]): Promise<unknown>;
  /**
   * Reads one object; only a print by pack reference does, for its batch's
   * upload index.
   */
  get?(key: string): Promise<{ json(): Promise<unknown> } | null>;
}

/** The document's path when the request has no pack. */
const defaultDocumentPath = 'index.html';

const decodedBytes = (base64: string) =>
  (base64.length / 4) * 3 - (base64.match(/=*$/)?.[0].length ?? 0);

/** What makes these pack files too large, if anything. */
export function packSizeIssues(files: Record<string, string> = {}): string[] {
  const issues: string[] = [];
  let total = 0;
  for (const [path, base64] of Object.entries(files)) {
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
  pack: { template: string; files: Record<string, string> } | undefined,
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

/** Where a batch's upload index lives; its files under batch/<batch>/<digest>/… . */
const batchIndexKey = (batch: string, digest: string) =>
  `batch-index/${batch}/${digest}`;

/** The entries of a batch's upload index, or undefined when it isn't one. */
function parseBatchIndex(
  value: unknown,
): { paths: string[]; complete: boolean } | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const { paths, complete } = value as Record<string, unknown>;
  if (
    !Array.isArray(paths) ||
    paths.some(path => typeof path !== 'string') ||
    typeof complete !== 'boolean'
  ) {
    return undefined;
  }
  return { paths, complete };
}

/**
 * The lower-case hex SHA-256 over `files`, independent of key order and
 * base64 spelling: the paths in ascending code-unit order, and for each the
 * path, the decoded byte length and the decoded bytes, NUL-separated.
 */
async function packDigest(files: Record<string, string>): Promise<string> {
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];
  for (const path of Object.keys(files).sort()) {
    const bytes = new Uint8Array(Buffer.from(files[path] ?? '', 'base64'));
    parts.push(
      encoder.encode(path),
      Uint8Array.of(0),
      encoder.encode(String(bytes.byteLength)),
      Uint8Array.of(0),
      bytes,
    );
  }
  const all = new Uint8Array(
    parts.reduce((total, part) => total + part.byteLength, 0),
  );
  let at = 0;
  for (const part of parts) {
    all.set(part, at);
    at += part.byteLength;
  }
  const hash = await crypto.subtle.digest('SHA-256', all);
  return [...new Uint8Array(hash)]
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Stores `batch`'s pack `files` under their content digest and answers it,
 * or answers it without a write when that content is already completely
 * uploaded. The index goes in incomplete first and complete once every file
 * is written, so a crash leaves an incomplete index a later upload finishes,
 * never a complete one that misses files. A failed file write throws (the
 * route answers 500) and deletes nothing: a concurrent upload of the same
 * content may be using what was written.
 */
export async function uploadBatchPack(
  store: R2Bucket,
  batch: string,
  files: Record<string, string>,
): Promise<string> {
  const paths = Object.keys(files).sort();
  const digest = await packDigest(files);
  const indexKey = batchIndexKey(batch, digest);
  const existing = await store.get(indexKey);
  const index = existing ? parseBatchIndex(await existing.json()) : undefined;
  if (index?.complete) return digest;
  const writeIndex = (complete: boolean) =>
    store.put(indexKey, JSON.stringify({ paths, complete }));
  await writeIndex(false);
  const writes = await Promise.allSettled(
    paths.map(path =>
      store.put(
        `batch/${batch}/${digest}/pack/${path}`,
        new Uint8Array(Buffer.from(files[path] ?? '', 'base64')),
        { httpMetadata: { contentType: contentType(path) } },
      ),
    ),
  );
  const failed = writes.find(write => write.status === 'rejected');
  if (failed) throw failed.reason;
  await writeIndex(true);
  return digest;
}

/**
 * What ending a batch and the sweep need of the store; R2Bucket satisfies
 * it.
 */
export interface BatchPackStore {
  list(options?: { prefix?: string; cursor?: string }): Promise<{
    objects: { key: string; uploaded: Date }[];
    truncated: boolean;
    cursor?: string;
  }>;
  delete(keys: string | string[]): Promise<unknown>;
}

/**
 * Every key under `prefix`, deleted in chunks of at most 1000 (R2's limit),
 * following the list cursor to the last page. DELETE /batch/<batch> and the
 * sweep share it.
 */
async function deletePrefix(
  store: BatchPackStore,
  prefix: string,
): Promise<void> {
  // Every page first, then the deletes: deleting while paging would move the
  // keys a page's cursor points at.
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const page: Awaited<ReturnType<BatchPackStore['list']>> = await store.list({
      prefix,
      ...(cursor ? { cursor } : {}),
    });
    keys.push(...page.objects.map(object => object.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor !== undefined);
  for (let at = 0; at < keys.length; at += 1000) {
    await store.delete(keys.slice(at, at + 1000));
  }
}

/**
 * `DELETE /batch/<batch>`: everything the batch stored, its uploaded files
 * and its upload indexes. Idempotent: an empty batch deletes nothing.
 */
export async function deleteBatchPack(
  store: BatchPackStore,
  batch: string,
): Promise<void> {
  // The index first: a print that starts meanwhile then answers
  // pack_not_uploaded rather than finding some files gone.
  await deletePrefix(store, `batch-index/${batch}/`);
  await deletePrefix(store, `batch/${batch}/`);
}

/**
 * A batch gets 24 hours; its pack's copy may stay one more, so a batch
 * still running is never swept. An index is rewritten on every upload, so
 * its `uploaded` is when its batch last touched the pack.
 */
const batchPackGrace = 25 * 3_600_000;

/**
 * Deletes every upload index last written more than `batchPackGrace` before
 * `now`, and that upload's files: the batch they belonged to has ended or
 * its end never arrived (its web isolate died). Younger indexes and their
 * files stay, as do keys outside batch/ and batch-index/ (a print's inline
 * files). Never throws: it runs in the background after an upload.
 */
export async function sweepBatchPacks(
  store: BatchPackStore,
  now: number,
): Promise<void> {
  try {
    // Every index first, then the deletions: as in deletePrefix, deleting
    // while paging would move keys under a page's cursor.
    const expired: { key: string; batch: string; digest: string }[] = [];
    let cursor: string | undefined;
    do {
      const page: Awaited<ReturnType<BatchPackStore['list']>> =
        await store.list({
          prefix: 'batch-index/',
          ...(cursor ? { cursor } : {}),
        });
      for (const object of page.objects) {
        const match = /^batch-index\/([^/]+)\/([^/]+)$/.exec(object.key);
        if (match && now - object.uploaded.getTime() > batchPackGrace) {
          const [, batch = '', digest = ''] = match;
          expired.push({ key: object.key, batch, digest });
        }
      }
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor !== undefined);
    for (const { key, batch, digest } of expired) {
      await store.delete(key);
      await deletePrefix(store, `batch/${batch}/${digest}/`);
    }
  } catch (error) {
    console.warn('The batch-pack sweep failed:', error);
  }
}

/** A print referenced a pack that was never completely uploaded for its batch. */
export class PackNotUploadedError extends Error {
  constructor(batch: string, digest: string) {
    super(`No complete upload of pack ${digest} for batch ${batch}`);
    this.name = 'PackNotUploadedError';
  }
}

/** The batch id, digest and pack path of a `/batch/<batch>/<digest>/<path>` URL, if it is one. */
function batchFile(
  pathname: string,
): { batch: string; digest: string; path: string } | undefined {
  const match = /^\/batch\/([0-9a-f-]{36})\/([0-9a-f]{64})\/(.+)$/.exec(
    pathname,
  );
  if (!match) return undefined;
  const [, batch = '', digest = '', encoded = ''] = match;
  try {
    return {
      batch,
      digest,
      path: encoded.split('/').map(decodeURIComponent).join('/'),
    };
  } catch {
    return undefined;
  }
}

/**
 * Publishes only the prepared document of a print by pack reference, stored
 * per print and served at the pack's own URL with the print's id, so
 * relative URLs resolve inside the pack exactly as with inline files while
 * the shared, immutable pack files keep their batch-long URL. `remove`
 * deletes only the document; the pack's uploaded files stay.
 */
export async function publishBatchFiles(
  store: PrintStore,
  origin: string,
  document: string,
  pack: { template: string; batch: string; digest: string },
): Promise<PublishedFiles> {
  if (!store.get) {
    throw new Error('The print store cannot read a pack by batch and digest');
  }
  const existing = await store.get(batchIndexKey(pack.batch, pack.digest));
  const index = existing ? parseBatchIndex(await existing.json()) : undefined;
  if (!index?.complete) {
    throw new PackNotUploadedError(pack.batch, pack.digest);
  }
  const printId = crypto.randomUUID();
  const base = `batch/${pack.batch}/${pack.digest}`;
  const documentKey = `${base}/print/${printId}`;
  const remove = async () => {
    await store.delete([documentKey]).catch(() => undefined);
  };
  try {
    await store.put(documentKey, document, {
      httpMetadata: { contentType: htmlType },
      customMetadata: { path: pack.template },
    });
  } catch (error) {
    await remove();
    throw error;
  }
  const encodedTemplate = pack.template
    .split('/')
    .map(encodeURIComponent)
    .join('/');
  const served = new Set(index.paths.filter(path => path !== pack.template));
  return {
    documentUrl: `${origin}/${base}/${encodedTemplate}?print=${printId}`,
    serves: candidate => {
      const parsed = URL.parse(candidate);
      if (parsed?.origin !== origin) return false;
      const file = batchFile(parsed.pathname);
      if (!file || file.batch !== pack.batch || file.digest !== pack.digest) {
        return false;
      }
      if (file.path === pack.template) {
        return parsed.searchParams.get('print') === printId;
      }
      return served.has(file.path);
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

/**
 * `GET /batch/<batch>/<digest>/<path>`: an immutable file of the batch's
 * uploaded pack, or with a `print` query the prepared document of one of its
 * prints, only under the template path that print stored it with. No bearer
 * token: the browser can't send one; the digest names the uploaded bytes and
 * a document answers only by its print's random id.
 */
export async function serveBatchFile(
  bucket: R2Bucket,
  url: URL,
): Promise<Response | undefined> {
  const file = batchFile(url.pathname);
  if (!file || !relativePathSchema.safeParse(file.path).success) {
    return undefined;
  }
  const base = `batch/${file.batch}/${file.digest}`;
  const printId = url.searchParams.get('print');
  let object: R2ObjectBody | null;
  let cacheControl: string;
  if (printId) {
    // The short-lived documents live outside the pack's shared files: serve
    // one only by its own print id, never at a pack file's stable URL.
    const document = await bucket.get(`${base}/print/${printId}`);
    object = document?.customMetadata?.['path'] === file.path ? document : null;
    cacheControl = 'no-store';
  } else {
    object = await bucket.get(`${base}/pack/${file.path}`);
    cacheControl = 'private, max-age=86400, immutable';
  }
  if (!object) return undefined;
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('Cache-Control', cacheControl);
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Content-Security-Policy', printPolicy(url.origin));
  return new Response(object.body, { headers });
}
