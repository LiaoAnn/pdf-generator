// Prints a fixture through the print Worker (T07, apps/print) over its
// service binding: POST /print with the fixture's source, so the answer
// carries the ground truth read on the printed page.
import type { GroundTruth } from '@pdf-generator/contract';

interface PrintJob {
  html: string;
  page: { size: 'A4'; orientation: 'portrait' | 'landscape' };
  source: GroundTruth['source'];
}

interface Printed {
  pageCount: number;
  pdf: Uint8Array<ArrayBuffer>;
  gt: GroundTruth;
}

export interface Printer {
  print(job: PrintJob): Promise<Printed>;
}

/** The print Worker refused or couldn't be reached (status 0). */
export class PrintFailure extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'PrintFailure';
    this.status = status;
    this.code = code;
  }
}

type Service = {
  fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
};

async function failure(response: Response): Promise<PrintFailure> {
  const text = await response.text().catch(() => '');
  let code = 'print_failed';
  let message = text.slice(0, 500) || `HTTP ${response.status}`;
  try {
    const body: unknown = JSON.parse(text);
    const error = (body as { error?: { code?: unknown; message?: unknown } })
      .error;
    if (typeof error?.code === 'string' && error.code) code = error.code;
    if (typeof error?.message === 'string' && error.message) {
      message = error.message;
    }
  } catch {
    // Not JSON: keep the text.
  }
  return new PrintFailure(
    response.status,
    code,
    `print ${response.status} ${code}: ${message}`,
  );
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
export function createPrinter(service: Service, token: string): Printer {
  const idle: string[] = [];
  return {
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
        throw new PrintFailure(
          0,
          'print_unreachable',
          `print Worker unreachable: ${String(cause)}`,
        );
      }
      const returned = response.headers.get('x-browser-session');
      if (returned) idle.push(returned);
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
