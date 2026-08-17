import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ZodRawShape, ZodTypeAny } from 'zod';
import { isErr } from '@reasoner/schema';
import type { ReasonerToolController } from './reasoner-tool-controller.js';

type ShapeBearingSchema = ZodTypeAny & {
  readonly shape?: ZodRawShape;
  innerType?: () => ZodTypeAny;
};

const getMcpInputSchemaShape = (inputSchema: ZodTypeAny): ZodRawShape => {
  let schema = inputSchema as ShapeBearingSchema;
  while (schema.shape === undefined && typeof schema.innerType === 'function') {
    const innerSchema = schema.innerType() as ShapeBearingSchema;
    if (innerSchema === schema) break;
    schema = innerSchema;
  }

  if (schema.shape === undefined) {
    throw new Error('Reasoner MCP tool input schema must resolve to a ZodObject');
  }

  return schema.shape;
};

/**
 * Registers every controller tool on an MCP server.
 *
 * Errors are returned as `isError` results with the structured Reasoner payload
 * rather than thrown: a caller that sends a stale revision or triggers a cycle
 * should receive a machine-readable code, not a transport failure.
 */
export const registerReasonerTools = (
  server: McpServer,
  controller: ReasonerToolController,
): void => {
  for (const tool of controller.list()) {
    // Refined Zod objects are wrapped in ZodEffects; MCP still needs their original raw shape.
    const shape = getMcpInputSchemaShape(tool.inputSchema);

    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: shape,
        annotations: {
          readOnlyHint: !tool.mutating,
          idempotentHint: !tool.mutating,
          openWorldHint: false,
        },
      },
      async (args: unknown) => {
        const result = await controller.invoke(tool.name, args);
        if (isErr(result)) {
          return {
            isError: true,
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({ error: result.error }, null, 2),
              },
            ],
          };
        }
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(result.value, null, 2),
            },
          ],
        };
      },
    );
  }
};
