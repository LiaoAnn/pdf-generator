// Prints a fixture through the print Worker (T07, apps/print) over its
// service binding: POST /print with the fixture's source, so the answer
// carries the ground truth read on the printed page.
import type { GroundTruth } from '@pdf-generator/contract';

interface PrintJob {
  html: string;
  page: { size: 'A4'; orientation: 'portrait' | 'landscape' };
  source: GroundTruth['source'];
  /** The pack's files the page loads by relative URL (/print's `pack`). */
  pack: { template: string; files: Record<string, string> };
}

/** A document to print without reading its ground truth (the preview). */
export type PdfJob = Omit<PrintJob, 'source'>;

interface Printed {
  pageCount: number;
  pdf: Uint8Array<ArrayBuffer>;
  gt: GroundTruth;
}

export interface Printer {
  print(job: PrintJob): Promise<Printed>;
}

/** A printer that keeps browser sessions, until `close` ends them. */
export interface SessionPrinter extends Printer {
  /**
   * Closes the sessions this printer holds, and those prints still running
   * hand back later. Never rejects: a session it fails to close ends at the
   * print Worker's idle cap.
   */
  close(): Promise<void>;
}

/** One printer per batch, so batches never share a browser session. */
export interface BatchPrinters {
  for(batchId: string): Printer;
  /** Closes the batch's printer, if any; never rejects. */
  close(batchId: string): Promise<void>;
}

/** The print Worker refused or couldn't be reached (status 0). */
export class PrintFailure extends Error {
  readonly status: number;
  readonly code: string;
  /** The print Worker's own message and detail messages, when it sent them. */
  readonly reason: string;
  readonly details: string[];
  constructor(
    status: number,
    code: string,
    message: string,
    { reason = message, details = [] as string[] } = {},
  ) {
    super(message);
    this.name = 'PrintFailure';
    this.status = status;
    this.code = code;
    this.reason = reason;
    this.details = details;
  }
}

export type Service = {
  fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
};

async function failure(response: Response): Promise<PrintFailure> {
  const text = await response.text().catch(() => '');
  let code = 'print_failed';
  let message = text.slice(0, 500) || `HTTP ${response.status}`;
  let details: string[] = [];
  try {
    const body: unknown = JSON.parse(text);
    const error = (
      body as {
        error?: { code?: unknown; message?: unknown; details?: unknown };
      }
    ).error;
    if (typeof error?.code === 'string' && error.code) code = error.code;
    if (typeof error?.message === 'string' && error.message) {
      message = error.message;
    }
    if (Array.isArray(error?.details)) {
      details = error.details.flatMap((detail: unknown) => {
        const text = (detail as { message?: unknown } | null)?.message;
        return typeof text === 'string' && text ? [text] : [];
      });
    }
  } catch {
    // Not JSON: keep the text.
  }
  return new PrintFailure(
    response.status,
    code,
    `print ${response.status} ${code}: ${message}`,
    { reason: message, details },
  );
}

const unreachable = (cause: unknown) =>
  new PrintFailure(
    0,
    'print_unreachable',
    `print Worker unreachable: ${String(cause)}`,
  );

/** Prints a document to PDF bytes, without its ground truth. */
export async function printPdf(
  service: Service,
  token: string,
  job: PdfJob,
): Promise<Uint8Array<ArrayBuffer>> {
  let response: Response;
  try {
    response = await service.fetch('https://print.internal/print', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(job),
    });
  } catch (cause) {
    throw unreachable(cause);
  }
  if (response.status !== 200) throw await failure(response);
  return new Uint8Array(await response.arrayBuffer());
}

function decodeBase64(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * A printer over the print Worker. It keeps the browser sessions the Worker
 * hands back (`X-Browser-Session`) and lends each to one print at a time, so
 * a batch pays the browser launch (tens of seconds remotely, T03 §6.2) once
 * per concurrent print rather than once per fixture.
 */
export function createPrinter(service: Service, token: string): SessionPrinter {
  const idle: string[] = [];
  let closed = false;
  const end = async (session: string) => {
    try {
      const response = await service.fetch(
        `https://print.internal/session/${encodeURIComponent(session)}`,
        { method: 'DELETE', headers: { authorization: `Bearer ${token}` } },
      );
      if (!response.ok) {
        console.warn(`closing browser session ${session}: ${response.status}`);
      }
    } catch (error) {
      console.warn(`closing browser session ${session} failed`, error);
    }
  };
  return {
    async close() {
      closed = true;
      await Promise.all(idle.splice(0).map(end));
    },
    async print(job) {
      const session = idle.pop() ?? 'new';
      let response: Response;
      try {
        // The host is not used by a service binding; the print Worker loads
        // its assets from its own ASSET_ORIGIN.
        response = await service.fetch('https://print.internal/print', {
          method: 'POST',
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json',
            'x-browser-session': session,
          },
          body: JSON.stringify(job),
        });
      } catch (cause) {
        throw unreachable(cause);
      }
      const returned = response.headers.get('x-browser-session');
      if (returned) {
        if (closed) await end(returned);
        else idle.push(returned);
      }
      if (response.status !== 200) throw await failure(response);
      try {
        const body = (await response.json()) as {
          pageCount: number;
          pdf: string;
          gt: GroundTruth;
        };
        return {
          pageCount: body.pageCount,
          pdf: decodeBase64(body.pdf),
          gt: body.gt,
        };
      } catch (cause) {
        throw new PrintFailure(
          response.status,
          'print_bad_response',
          `print answered an unreadable body: ${String(cause)}`,
        );
      }
    },
  };
}

export function createBatchPrinters(
  service: Service,
  token: string,
): BatchPrinters {
  const printers = new Map<string, SessionPrinter>();
  return {
    for(batchId) {
      let printer = printers.get(batchId);
      if (!printer) {
        printer = createPrinter(service, token);
        printers.set(batchId, printer);
      }
      return printer;
    },
    async close(batchId) {
      const printer = printers.get(batchId);
      printers.delete(batchId);
      await printer?.close();
    },
  };
}
