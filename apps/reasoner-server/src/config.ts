import { z } from 'zod';
import { LoggingConfigSchema, loadLoggingConfig } from '@reasoner/logging';

/**
 * Server configuration, validated once at startup.
 *
 * The host defaults to loopback on purpose: the reasoner endpoints carry no
 * authentication, so binding a wider interface would expose an unauthenticated
 * write API. Overriding REASONER_HOST is an explicit operator decision.
 */
export const ReasonerServerConfigSchema = z.object({
  host: z.string().min(1).default('127.0.0.1'),
  port: z.coerce.number().int().min(1).max(65_535).default(8791),
  dataDir: z.string().min(1).default('./data'),
  /** Directory of built web assets; when absent the server runs API-only. */
  webRoot: z.string().min(1).optional(),
  enableAudit: z
    .union([z.boolean(), z.string()])
    .transform((value) => (typeof value === 'boolean' ? value : value !== 'false'))
    .default(true),
  /**
   * Logging is nested rather than flattened so `@reasoner/logging` owns its own
   * defaults and the CLI tools can reuse the identical block.
   */
  logging: LoggingConfigSchema,
});

export type ReasonerServerConfig = z.infer<typeof ReasonerServerConfigSchema>;

export const loadReasonerServerConfig = (env: NodeJS.ProcessEnv): ReasonerServerConfig =>
  ReasonerServerConfigSchema.parse({
    ...(env['REASONER_HOST'] === undefined ? {} : { host: env['REASONER_HOST'] }),
    ...(env['REASONER_PORT'] === undefined ? {} : { port: env['REASONER_PORT'] }),
    ...(env['REASONER_DATA_DIR'] === undefined ? {} : { dataDir: env['REASONER_DATA_DIR'] }),
    ...(env['REASONER_WEB_ROOT'] === undefined ? {} : { webRoot: env['REASONER_WEB_ROOT'] }),
    ...(env['REASONER_ENABLE_AUDIT'] === undefined
      ? {}
      : { enableAudit: env['REASONER_ENABLE_AUDIT'] }),
    logging: loadLoggingConfig(env, 'reasoner-server'),
  });

/** True when the server is reachable from outside the machine. */
export const isPubliclyBound = (config: ReasonerServerConfig): boolean =>
  config.host !== '127.0.0.1' && config.host !== 'localhost' && config.host !== '::1';
