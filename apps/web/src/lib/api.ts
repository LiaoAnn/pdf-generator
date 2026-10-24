// The pages' client for the platform API (/api), the same API the CLI uses.
// The browser sends the Access session cookie with each same-origin request.
import { type ApiError, apiErrorSchema } from '@pdf-generator/contract';

/** A request the API refused, with its contract error body. */
export class ApiProblem extends Error {
  readonly status: number;
  readonly error: ApiError['error'];
  constructor(status: number, error: ApiError['error']) {
    super(error.message);
    this.name = 'ApiProblem';
    this.status = status;
    this.error = error;
  }
}

/** The refusal a non-2xx answer carries. */
export async function problem(response: Response): Promise<ApiProblem> {
  const body = apiErrorSchema.safeParse(
    await response.json().catch(() => ({})),
  );
  return new ApiProblem(
    response.status,
    body.success
      ? body.data.error
      : { code: 'unexpected_response', message: `HTTP ${response.status}` },
  );
}

/** Sends a request and parses the JSON answer with `schema`. */
export async function api<T>(
  path: string,
  schema: { parse: (value: unknown) => T },
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(path, { credentials: 'same-origin', ...init });
  if (!response.ok) throw await problem(response);
  return schema.parse(await response.json());
}
