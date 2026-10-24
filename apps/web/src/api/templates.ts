// The template API (T15): upload a pack zip as a new version, list versions,
// download a version's zip, print a version's sample as a preview.
import type { ApiError, TemplateList } from '@pdf-generator/contract';
import { checkPack, type PackIssue } from '@pdf-generator/template-tools';
import { Effect } from 'effect';
import { render } from '../batch/fixture.ts';
import { PrintFailure } from '../batch/printer.ts';
import { Database, Files, Print } from '../services.ts';
import {
  maxPackBytes,
  maxUploadBytes,
  unzipWithinLimits,
} from '../templates/limits.ts';
import { TemplateSource } from '../templates/source.ts';
import {
  readPackZip,
  readVersion,
  readVersions,
  saveVersion,
  type TemplateRow,
  toSummary,
} from '../templates/store.ts';
import { ApiFailure } from './errors.ts';

// A D1 or R2 call; its failure is logged and answered without the details.
function storage<A>(
  what: string,
  run: () => Promise<A>,
  code: 'database_error' | 'storage_error' = 'database_error',
) {
  return Effect.tryPromise({
    try: run,
    catch: cause => {
      console.error(`templates: ${what} failed`, cause);
      return new ApiFailure({
        status: 500,
        code,
        message: `Could not ${what}.`,
      });
    },
  });
}

const notFound = (id: string, version?: string) =>
  new ApiFailure({
    status: 404,
    code: 'template_not_found',
    message:
      version === undefined
        ? `No template ${id}.`
        : `No template ${id} version ${version}.`,
  });

const list = (rows: TemplateRow[]) => {
  const body: TemplateList = { templates: rows.map(toSummary) };
  return Response.json(body);
};

/** GET /api/templates: every uploaded version, by id then version. */
export const listTemplates = Effect.gen(function* () {
  const db = yield* Database;
  return list(yield* storage('read the template list', () => readVersions(db)));
});

/** GET /api/templates/:id: one template's versions, oldest first. */
export const getTemplate = (id: string) =>
  Effect.gen(function* () {
    const db = yield* Database;
    const rows = yield* storage('read the template', () =>
      readVersions(db, id),
    );
    if (rows.length === 0) return yield* notFound(id);
    return list(rows);
  });

/** One stored version, from the `:id` and `:version` of a path. */
const findVersion = (id: string, version: string) =>
  Effect.gen(function* () {
    if (!/^[1-9]\d{0,8}$/.test(version)) return yield* notFound(id, version);
    const db = yield* Database;
    const row = yield* storage('read the template', () =>
      readVersion(db, id, Number(version)),
    );
    if (!row) return yield* notFound(id, version);
    return row;
  });

/** GET /api/templates/:id/versions/:version/pack.zip */
export const downloadPack = (id: string, version: string) =>
  Effect.gen(function* () {
    const row = yield* findVersion(id, version);
    const files = yield* Files;
    const object = yield* storage(
      'read the pack',
      () => readPackZip(files, row),
      'storage_error',
    );
    if (!object) {
      console.error(`templates: ${id} v${version} has no zip in R2`);
      return yield* new ApiFailure({
        status: 500,
        code: 'storage_error',
        message: 'The stored pack is missing.',
      });
    }
    return new Response(object.body, {
      headers: {
        'content-type': 'application/zip',
        'content-disposition': `attachment; filename="${row.id}-v${row.version}.zip"`,
      },
    });
  });

const tooLarge = () =>
  new ApiFailure({
    status: 413,
    code: 'template_pack_too_large',
    message: `The upload is larger than ${maxUploadBytes} bytes.`,
  });

// The body, read up to `max` bytes; undefined when it is longer.
async function readBody(
  request: Request,
  max: number,
): Promise<Uint8Array | undefined> {
  if (Number(request.headers.get('content-length') ?? 0) > max) {
    return undefined;
  }
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    body.set(chunk, at);
    at += chunk.byteLength;
  }
  return body;
}

type Detail = NonNullable<ApiError['error']['details']>[number];

/**
 * An issue as an error detail. The contract's detail has no code field, so
 * the code leads the message (`file-missing: …`); the upload page reads it
 * back to explain the issue.
 */
function toDetail({ code, file, message, ...location }: PackIssue): Detail {
  return {
    message: `${code}: ${message}`,
    ...(file === '.' ? {} : { file }),
    ...location,
  };
}

const invalid = (issues: PackIssue[]) =>
  new ApiFailure({
    status: 400,
    code: 'invalid_template_pack',
    message: `The template pack has ${issues.length} problem${issues.length === 1 ? '' : 's'}.`,
    details: issues.map(toDetail),
  });

/** POST /api/templates: the body is a pack zip; it becomes the next version. */
export const uploadTemplate = (request: Request) =>
  Effect.gen(function* () {
    const zip = yield* Effect.tryPromise({
      try: () => readBody(request, maxUploadBytes),
      catch: () =>
        new ApiFailure({
          status: 400,
          code: 'invalid_request',
          message: 'The upload could not be read.',
        }),
    });
    if (!zip) return yield* tooLarge();

    const limited = unzipWithinLimits(zip);
    if (limited && 'issues' in limited) return yield* invalid(limited.issues);
    // checkPack can still throw on a crafted pack (T06): that is a broken
    // pack, not a server error.
    const checked = yield* Effect.try({
      try: () =>
        checkPack(limited ? limited.files : zip, { maxBytes: maxPackBytes }),
      catch: cause => {
        console.error('templates: checkPack threw', cause);
        return invalid([
          {
            code: 'pack-check-failed',
            file: '.',
            message: `the pack could not be checked: ${String(cause).slice(0, 300)}`,
          },
        ]);
      },
    });
    if (!checked.ok || !checked.pack) return yield* invalid(checked.issues);

    const { manifest } = checked.pack;
    const db = yield* Database;
    const files = yield* Files;
    const row = yield* storage(
      'store the template',
      () => saveVersion(db, files, manifest, zip),
      'storage_error',
    );
    return Response.json(toSummary(row), { status: 201 });
  });

const previewFailure = (cause: unknown) => {
  if (
    cause instanceof PrintFailure &&
    cause.status >= 400 &&
    cause.status < 500
  ) {
    // The printer refused this document: a problem of the pack, which the
    // template page explains from the code leading the first detail.
    return new ApiFailure({
      status: 422,
      code: 'preview_failed',
      message: `The sample could not be printed: ${cause.reason}`,
      details: [
        { message: `${cause.code}: ${cause.reason}` },
        ...cause.details.map(message => ({ message })),
      ],
    });
  }
  console.error('templates: preview print failed', cause);
  return new ApiFailure({
    status: 503,
    code: 'print_unavailable',
    message: 'The print service is unavailable; try again later.',
  });
};

/**
 * GET /api/templates/:id/versions/:version/preview.pdf: the version's sample
 * record, filled and printed like a batch fixture.
 */
export const previewPdf = (id: string, version: string) =>
  Effect.gen(function* () {
    const row = yield* findVersion(id, version);
    const templates = yield* TemplateSource;
    const pack = yield* storage(
      'read the pack',
      () => templates.get(row.id, row.version),
      'storage_error',
    );
    if (!pack) return yield* notFound(id, version);
    const html = yield* Effect.try({
      try: () => render(pack, pack.sample),
      catch: cause =>
        new ApiFailure({
          status: 422,
          code: 'preview_failed',
          message: `The sample could not be filled in: ${String(cause)}`,
        }),
    });
    const print = yield* Print;
    const pdf = yield* Effect.tryPromise({
      try: () => print.pdf({ html, page: pack.manifest.page }),
      catch: previewFailure,
    });
    return new Response(pdf, {
      headers: {
        'content-type': 'application/pdf',
        'content-disposition': `inline; filename="${row.id}-v${row.version}-preview.pdf"`,
      },
    });
  });
