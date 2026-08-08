import { z } from 'zod';
import { LOG_LEVELS } from '@reasoner/schema';

/**
 * Logging configuration.
 *
 * File output is the primary sink: a local reasoning session can run for a long
 * time and a terminal scrollback is not a diagnostic record. Console output is
 * secondary and defaults on only because a silent foreground process is worse
 * than a noisy one.
 */
export const LoggingConfigSchema = z.object({
  level: z.enum([...LOG_LEVELS, 'silent']).default('info'),
  /** Directory holding rotated log files. Created on demand. */
  logDir: z.string().min(1).default('./data/logs'),
  /** Base file name; the rotation suffix is appended by pino-roll. */
  fileName: z.string().min(1).default('reasoner.log'),
  /** Rotate once a file reaches this size. */
  rotateSize: z.string().min(1).default('20m'),
  /** Number of rotated files to keep; older ones are removed. */
  retainFiles: z.coerce.number().int().min(1).max(1_000).default(20),
  /** Mirror records to stdout. Disable for a quiet daemon. */
  console: z
    .union([z.boolean(), z.string()])
    .transform((value) => (typeof value === 'boolean' ? value : value !== 'false'))
    .default(true),
  /** Human-readable console output. Off by default so stdout stays parseable. */
  prettyConsole: z
    .union([z.boolean(), z.string()])
    .transform((value) => (typeof value === 'boolean' ? value : value === 'true'))
    .default(false),
});

export type LoggingConfig = z.infer<typeof LoggingConfigSchema>;

/**
 * Reads logging settings from the environment. Kept separate from the server
 * config so the test agent and CLI tools can configure logging on their own.
 */
export const loadLoggingConfig = (
  env: NodeJS.ProcessEnv,
  /**
   * Per-process default file name. The server and the replay agent write to
   * separate files so a failing replay is not interleaved with HTTP traffic. An
   * explicit REASONER_LOG_FILE still wins.
   */
  serviceName?: string,
): LoggingConfig =>
  LoggingConfigSchema.parse({
    ...(serviceName === undefined ? {} : { fileName: `${serviceName}.log` }),
    ...(env['REASONER_LOG_LEVEL'] === undefined ? {} : { level: env['REASONER_LOG_LEVEL'] }),
    ...(env['REASONER_LOG_DIR'] === undefined ? {} : { logDir: env['REASONER_LOG_DIR'] }),
    ...(env['REASONER_LOG_FILE'] === undefined ? {} : { fileName: env['REASONER_LOG_FILE'] }),
    ...(env['REASONER_LOG_ROTATE_SIZE'] === undefined
      ? {}
      : { rotateSize: env['REASONER_LOG_ROTATE_SIZE'] }),
    ...(env['REASONER_LOG_RETAIN'] === undefined ? {} : { retainFiles: env['REASONER_LOG_RETAIN'] }),
    ...(env['REASONER_LOG_CONSOLE'] === undefined ? {} : { console: env['REASONER_LOG_CONSOLE'] }),
    ...(env['REASONER_LOG_PRETTY'] === undefined
      ? {}
      : { prettyConsole: env['REASONER_LOG_PRETTY'] }),
  });
