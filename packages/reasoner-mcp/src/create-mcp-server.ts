import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { NULL_LOGGER, type Logger } from '@reasoner/schema';
import type { ReasonerService } from '@reasoner/core';
import {
  createReasonerToolController,
  type ReasonerToolController,
} from './reasoner-tool-controller.js';
import { registerReasonerTools } from './register-reasoner-tools.js';

export interface ReasonerMcpOptions {
  readonly logger?: Logger;
}

export interface ReasonerMcpRuntime {
  readonly server: McpServer;
  readonly controller: ReasonerToolController;
  close(): Promise<void>;
}

export const createReasonerMcpServer = (
  service: ReasonerService,
  options: ReasonerMcpOptions = {},
): ReasonerMcpRuntime => {
  const log = (options.logger ?? NULL_LOGGER).child({ component: 'mcp' });

  const server = new McpServer(
    { name: 'inference-graph-reasoner', version: '0.1.0' },
    {
      instructions:
        'Records and schedules an evidence graph. It stores what agents submit and enforces ' +
        'structure (acyclicity, leases, revisions); it never invents domain conclusions.',
    },
  );

  const controller = createReasonerToolController(service, { logger: log });
  registerReasonerTools(server, controller);

  return {
    server,
    controller,
    close: async (): Promise<void> => {
      await server.close();
    },
  };
};
