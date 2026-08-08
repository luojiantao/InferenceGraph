import { mkdirSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import pino, { type Logger as PinoLogger, type LoggerOptions, type TransportTargetOptions } from 'pino';
import { NULL_LOGGER, type LogFields, type Logger } from '@reasoner/schema';
import type { LoggingConfig } from './config.js';

/**
 * Field paths scrubbed before a record reaches disk.
 *
 * Vertex and evidence payloads are opaque agent-supplied blobs, so they are the
 * one place a caller could hand us a secret without either side noticing. Their
 * shape is still useful for debugging, so the redaction keeps the key and
 * replaces the value.
 */
const REDACTED_PATHS = [
  'payload.token',
  'payload.secret',
  'payload.password',
  'payload.apiKey',
  '*.authorization',
  'req.headers.authorization',
  'req.headers.cookie',
] as const;

export interface LoggerRuntime {
  readonly logger: Logger;
  /**
   * The underlying Pino instance. Exposed only so Fastify can adopt the very
   * same instance via `loggerInstance` — otherwise HTTP records would bypass the
   * file transport and land on stdout alone. Application code should use
   * `logger` and stay transport-agnostic.
   */
  readonly raw: PinoLogger | null;
  /** Absolute path of the active log file, for startup reporting. */
  readonly logFilePath: string;
  /** Flushes buffered records. Call before exit so nothing is lost. */
  flush(): Promise<void>;
}

/** Wraps a Pino instance in the transport-agnostic `Logger` port. */
const adapt = (instance: PinoLogger): Logger => ({
  fatal: (fields: LogFields, message: string) => instance.fatal(fields, message),
  error: (fields: LogFields, message: string) => instance.error(fields, message),
  warn: (fields: LogFields, message: string) => instance.warn(fields, message),
  info: (fields: LogFields, message: string) => instance.info(fields, message),
  debug: (fields: LogFields, message: string) => instance.debug(fields, message),
  trace: (fields: LogFields, message: string) => instance.trace(fields, message),
  child: (fields: LogFields) => adapt(instance.child(fields)),
});

const buildTargets = (config: LoggingConfig, logFilePath: string): TransportTargetOptions[] => {
  const targets: TransportTargetOptions[] = [
    {
      target: 'pino-roll',
      level: config.level,
      options: {
        file: logFilePath,
        size: config.rotateSize,
        limit: { count: config.retainFiles },
        mkdir: true,
      },
    },
  ];

  if (config.console) {
    targets.push(
      config.prettyConsole
        ? {
            target: 'pino-pretty',
            level: config.level,
            options: { destination: 1, translateTime: 'SYS:standard', ignore: 'pid,hostname' },
          }
        : { target: 'pino/file', level: config.level, options: { destination: 1 } },
    );
  }

  return targets;
};

/**
 * Builds the process-wide logger.
 *
 * Records go through a worker-thread transport, so serialising and writing never
 * blocks the request path. `flush()` exists because that same asynchrony means a
 * bare `process.exit` can drop the last records — including whatever explains a
 * crash.
 */
export const createLogger = (
  config: LoggingConfig,
  bindings: LogFields = {},
): LoggerRuntime => {
  const logDir = isAbsolute(config.logDir) ? config.logDir : resolve(config.logDir);
  const logFilePath = join(logDir, config.fileName);

  if (config.level === 'silent') {
    return { logger: NULL_LOGGER, raw: null, logFilePath, flush: async () => undefined };
  }

  // Created up front so a bad path fails at startup rather than at first write.
  mkdirSync(logDir, { recursive: true });

  const options: LoggerOptions = {
    level: config.level,
    base: { pid: process.pid, ...bindings },
    redact: { paths: [...REDACTED_PATHS], censor: '[redacted]' },
    // ISO instants keep log timestamps comparable with GraphEvent.createdAt.
    timestamp: () => `,"time":"${new Date().toISOString()}"`,
    formatters: {
      level: (label) => ({ level: label }),
    },
  };

  const transport = pino.transport({ targets: buildTargets(config, logFilePath) });
  const instance = pino(options, transport);

  return {
    logger: adapt(instance),
    raw: instance,
    logFilePath,
    flush: async () =>
      new Promise<void>((resolveFlush) => {
        instance.flush(() => resolveFlush());
      }),
  };
};
