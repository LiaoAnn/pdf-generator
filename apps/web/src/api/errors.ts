import type { ApiError } from '@pdf-generator/contract';
import { Data } from 'effect';

/** A failed API request, answered with the contract's error body. */
export class ApiFailure extends Data.TaggedError('ApiFailure')<{
  status: number;
  code: string;
  message: string;
  details?: ApiError['error']['details'];
}> {}

export function apiErrorResponse(failure: ApiFailure): Response {
  const body: ApiError = {
    error: {
      code: failure.code,
      message: failure.message,
      ...(failure.details && { details: failure.details }),
    },
  };
  return Response.json(body, { status: failure.status });
}
