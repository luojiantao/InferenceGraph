import { z } from 'zod';

/** Stable structured error codes returned across MCP and HTTP boundaries. */
export const ReasonerErrorCodeSchema = z.enum([
  'InvalidInput',
  'SessionNotFound',
  'SessionFinished',
  'VertexNotFound',
  'EdgeNotFound',
  'QuestionNotFound',
  'RevisionConflict',
  'ContextStale',
  'CycleDetected',
  'EdgeNotClaimable',
  'LeaseNotHeld',
  'LeaseExpired',
  'BudgetExceeded',
  'StructurallyInvalid',
  'DuplicateEntity',
  'StorageFailure',
]);
export type ReasonerErrorCode = z.infer<typeof ReasonerErrorCodeSchema>;

export const ReasonerErrorSchema = z.object({
  code: ReasonerErrorCodeSchema,
  message: z.string().min(1),
  detail: z.record(z.unknown()).default({}),
});
export type ReasonerError = z.infer<typeof ReasonerErrorSchema>;

/** Explicit Result type: expected failures never throw inside the Core. */
export type Ok<T> = { readonly ok: true; readonly value: T };
export type Err = { readonly ok: false; readonly error: ReasonerError };
export type Result<T> = Ok<T> | Err;

export const ok = <T>(value: T): Ok<T> => ({ ok: true, value });

export const err = (
  code: ReasonerErrorCode,
  message: string,
  detail: Record<string, unknown> = {},
): Err => ({ ok: false, error: { code, message, detail } });

export const isOk = <T>(result: Result<T>): result is Ok<T> => result.ok;
export const isErr = <T>(result: Result<T>): result is Err => !result.ok;
