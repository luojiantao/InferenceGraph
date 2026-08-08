import type { LogFields, Logger, ReasonerError } from '@reasoner/schema';

/**
 * Flattens a `ReasonerError` into log fields.
 *
 * Every tool failure is logged through this one shape so a log search on
 * `errorCode` finds all of them, whichever layer reported the failure.
 */
export const errorFields = (error: ReasonerError): LogFields => ({
  errorCode: error.code,
  errorMessage: error.message,
  ...(Object.keys(error.detail).length === 0 ? {} : { errorDetail: error.detail }),
});

/**
 * Normalises a thrown value for logging. Unknown throws are common at process
 * boundaries and an `Error` is not guaranteed, so the non-Error case is kept
 * rather than coerced into a misleading stack.
 */
export const causeFields = (cause: unknown): LogFields =>
  cause instanceof Error
    ? { errName: cause.name, errMessage: cause.message, errStack: cause.stack }
    : { errValue: String(cause) };

/**
 * Milliseconds since a `process.hrtime.bigint()` reading, rounded to 3 decimals.
 * Used for tool and request durations, where wall-clock deltas are too coarse.
 */
export const durationMs = (startedAt: bigint): number =>
  Math.round(Number(process.hrtime.bigint() - startedAt) / 1e3) / 1e3;

/**
 * Binds a component name so records can be filtered by origin. Preferred over
 * repeating `{ component: 'x' }` at each call site, which drifts.
 */
export const componentLogger = (logger: Logger, component: string): Logger =>
  logger.child({ component });
