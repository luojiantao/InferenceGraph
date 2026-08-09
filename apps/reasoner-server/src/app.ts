import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ReasonerService } from '@reasoner/core';
import { createStorage, systemClock, uuidIdGenerator, type StorageRuntime } from '@reasoner/storage';
import { createReasonerMcpServer, type ReasonerMcpRuntime } from '@reasoner/mcp';
import { isErr, type Logger } from '@reasoner/schema';
import { createLogger, errorFields, type LoggerRuntime } from '@reasoner/logging';
import { isPubliclyBound, type ReasonerServerConfig } from './config.js';

export interface ReasonerApplication {
  readonly fastify: FastifyInstance;
  readonly storage: StorageRuntime;
  readonly mcp: ReasonerMcpRuntime;
  readonly service: ReasonerService;
  readonly config: ReasonerServerConfig;
  readonly logging: LoggerRuntime;
  readonly log: Logger;
  listen(): Promise<string>;
  close(): Promise<void>;
}

interface McpHttpSession {
  readonly mcp: ReasonerMcpRuntime;
  readonly transport: StreamableHTTPServerTransport;
  close(): Promise<void>;
}

const isInitializeRequestBody = (body: unknown): boolean => {
  const messages = Array.isArray(body) ? body : [body];
  return messages.some(
    (message) =>
      typeof message === 'object' &&
      message !== null &&
      (message as { method?: unknown }).method === 'initialize',
  );
};

/**
 * Composes storage, Core and the MCP surface behind Fastify. This layer only
 * wires things together; no graph rule lives here.
 */
export const createReasonerApplication = async (
  config: ReasonerServerConfig,
): Promise<ReasonerApplication> => {
  const logging = createLogger(config.logging);
  const log = logging.logger;

  const storage = createStorage({
    dataDir: config.dataDir,
    clock: systemClock,
    enableAudit: config.enableAudit,
    logger: log.child({ component: 'storage' }),
  });

  const service = new ReasonerService({
    repository: storage.repository,
    clock: systemClock,
    ids: uuidIdGenerator,
    audit: storage.audit,
    logger: log.child({ component: 'core' }),
  });

  const mcp = createReasonerMcpServer(service, {
    logger: log.child({ component: 'mcp' }),
  });

  /** Each MCP client gets its own server/transport pair and session id. */
  const mcpSessions = new Map<string, McpHttpSession>();
  const createMcpHttpSession = async (): Promise<McpHttpSession> => {
    const sessionMcp = createReasonerMcpServer(service, {
      logger: log.child({ component: 'mcp' }),
    });
    let closed = false;
    const sessionRef: { current?: McpHttpSession } = {};
    const getSession = (): McpHttpSession => {
      const session = sessionRef.current;
      if (session === undefined) {
        throw new Error('MCP session callback fired before session initialization');
      }
      return session;
    };
    const close = async (): Promise<void> => {
      if (closed) return;
      closed = true;
      await sessionMcp.close();
    };
    const transport = new StreamableHTTPServerTransport({
      enableJsonResponse: true,
      sessionIdGenerator: randomUUID,
      onsessioninitialized: (sessionId) => {
        mcpSessions.set(sessionId, getSession());
      },
      onsessionclosed: async (sessionId) => {
        if (mcpSessions.get(sessionId) === sessionRef.current) {
          mcpSessions.delete(sessionId);
        }
        await close();
      },
    });

    const session = { mcp: sessionMcp, transport, close };
    sessionRef.current = session;
    await sessionMcp.server.connect(
      transport as unknown as Parameters<typeof sessionMcp.server.connect>[0],
    );
    return session;
  };

  /**
   * Fastify builds its own logger for HTTP traffic. Application-level logs
   * (storage, Core, MCP) go through our file-backed logger; HTTP logs stay on
   * stdout. In a production deployment both streams are captured by the process
   * manager, so separating them here keeps the wiring simple.
   */
  const fastify = Fastify(
    config.logging.level === 'silent' ? { logger: false } : { logger: { level: config.logging.level } },
  );

  if (isPubliclyBound(config)) {
    log.warn(
      { host: config.host },
      'reasoner is bound to a non-loopback interface and has no authentication; ' +
        'do not expose this port to an untrusted network',
    );
  }

  fastify.get('/health', async () => ({
    status: 'ok',
    tools: mcp.controller.names().length,
  }));

  // Read-only JSON view of the tool surface, handy for diagnostics and the UI.
  fastify.get('/api/tools', async () => ({
    tools: mcp.controller.list().map((tool) => ({
      name: tool.name,
      title: tool.title,
      description: tool.description,
      mutating: tool.mutating,
    })),
  }));

  /**
   * Direct JSON bridge to the same controller the MCP transport uses. The web
   * UI calls this rather than reaching into storage, so both entry points share
   * one validation and error-mapping path.
   */
  fastify.post<{ Params: { tool: string } }>('/api/tools/:tool', async (request, reply) => {
    const tool = request.params.tool;
    const startedAt = process.hrtime.bigint();
    const result = await mcp.controller.invoke(tool, request.body ?? {});
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;

    if (isErr(result)) {
      /**
       * Rejections are the thing worth grepping for, so each one is logged with
       * its stable code. Expected outcomes such as RevisionConflict are `warn`,
       * not `error`: under parallel agents they are normal contention.
       */
      const expected =
        result.error.code === 'RevisionConflict' ||
        result.error.code === 'ContextStale' ||
        result.error.code === 'EdgeNotClaimable' ||
        result.error.code === 'CycleDetected';
      const fields = { tool, durationMs, ...errorFields(result.error) };
      if (expected) log.warn(fields, 'tool call rejected');
      else log.error(fields, 'tool call failed');
    } else {
      log.debug({ tool, durationMs }, 'tool call ok');
    }

    if (isErr(result)) {
      const status =
        result.error.code === 'InvalidInput'
          ? 400
          : result.error.code === 'SessionNotFound' ||
              result.error.code === 'VertexNotFound' ||
              result.error.code === 'EdgeNotFound' ||
              result.error.code === 'QuestionNotFound'
            ? 404
            : result.error.code === 'RevisionConflict' ||
                result.error.code === 'ContextStale' ||
                result.error.code === 'CycleDetected' ||
                result.error.code === 'EdgeNotClaimable' ||
                result.error.code === 'LeaseNotHeld' ||
                result.error.code === 'LeaseExpired' ||
                result.error.code === 'DuplicateEntity'
              ? 409
              : 500;
      return reply.status(status).send({ error: result.error });
    }
    return reply.send(result.value);
  });

  fastify.all('/mcp', async (request, reply) => {
    const rawSessionId = request.headers['mcp-session-id'];
    const sessionId = typeof rawSessionId === 'string' ? rawSessionId : undefined;
    let session = sessionId === undefined ? undefined : mcpSessions.get(sessionId);

    if (session === undefined) {
      if (sessionId !== undefined) {
        return reply.status(404).send({
          jsonrpc: '2.0',
          error: { code: -32001, message: 'Session not found' },
          id: null,
        });
      }
      if (!isInitializeRequestBody(request.body)) {
        return reply.status(400).send({
          jsonrpc: '2.0',
          error: { code: -32000, message: 'Mcp-Session-Id header is required' },
          id: null,
        });
      }
      session = await createMcpHttpSession();
    }

    reply.hijack();
    await session.transport.handleRequest(request.raw, reply.raw, request.body);
  });

  if (config.webRoot !== undefined) {
    const root = resolve(config.webRoot);
    if (existsSync(root)) {
      await fastify.register(fastifyStatic, { root, prefix: '/' });
    } else {
      log.warn({ root }, 'web root does not exist; serving API only');
    }
  }

  return {
    fastify,
    storage,
    mcp,
    service,
    config,
    logging,
    log,
    listen: async (): Promise<string> => {
      await fastify.listen({ host: config.host, port: config.port });
      return `http://${config.host}:${config.port}`;
    },
    close: async (): Promise<void> => {
      await fastify.close();
      for (const session of mcpSessions.values()) {
        await session.transport.close();
        await session.close();
      }
      mcpSessions.clear();
      await mcp.close();
      storage.close();
      // Flush last: everything above may log while shutting down.
      await logging.flush();
    },
  };
};
