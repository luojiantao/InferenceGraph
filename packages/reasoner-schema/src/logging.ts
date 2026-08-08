/**
 * Structured logging port.
 *
 * This is a pure interface with no runtime dependency, so `reasoner-core` can
 * emit diagnostics without learning about Pino, files or transports. The
 * concrete file-backed implementation lives in `@reasoner/logging`.
 */

export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace'] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

/** Level names plus the sentinel that disables output entirely. */
export type LogLevelSetting = LogLevel | 'silent';

/**
 * Structured fields attached to one log record. Values must be JSON-serialisable;
 * the logger is expected to redact anything registered as sensitive rather than
 * relying on callers to remember.
 */
export type LogFields = Record<string, unknown>;

/**
 * Minimal logger surface. Every method takes fields first and the message last,
 * matching Pino's argument order so the adapter stays a thin pass-through.
 */
export interface Logger {
  fatal(fields: LogFields, message: string): void;
  error(fields: LogFields, message: string): void;
  warn(fields: LogFields, message: string): void;
  info(fields: LogFields, message: string): void;
  debug(fields: LogFields, message: string): void;
  trace(fields: LogFields, message: string): void;
  /**
   * Derives a logger that stamps `fields` onto every record. Used to bind a
   * component name, sessionId or requestId once instead of at each call site.
   */
  child(fields: LogFields): Logger;
}

/** Discards every record. Default for library code and unit tests. */
export const NULL_LOGGER: Logger = {
  fatal: () => undefined,
  error: () => undefined,
  warn: () => undefined,
  info: () => undefined,
  debug: () => undefined,
  trace: () => undefined,
  child: () => NULL_LOGGER,
};
