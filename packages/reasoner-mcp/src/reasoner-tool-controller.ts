import type { z } from 'zod';
import {
  AddEvidenceVertexInputSchema,
  AddStateVertexInputSchema,
  BlockInferenceEdgeInputSchema,
  ClaimInferenceEdgeInputSchema,
  ClaimInferenceEdgesInputSchema,
  CompleteInferenceEdgeInputSchema,
  CreateReasoningSessionInputSchema,
  FinishReasoningSessionInputSchema,
  GetContextForEdgeInputSchema,
  GetContextForVertexInputSchema,
  GetInferenceEdgeInputSchema,
  GetReasoningContextInputSchema,
  GetReasoningSessionInputSchema,
  GetVertexInputSchema,
  ListCandidateEdgesInputSchema,
  ListReasoningSessionsInputSchema,
  ProposeInferenceEdgeInputSchema,
  ReleaseInferenceEdgeInputSchema,
  AnswerEvidenceQuestionInputSchema,
  err,
  isErr,
  NULL_LOGGER,
  type Logger,
  type Result,
} from '@reasoner/schema';
import type { ReasonerService } from '@reasoner/core';

/**
 * One tool definition, keyed on its Zod schema so the handler parameter is the
 * schema's *output* type — defaults applied and ids branded — rather than the
 * looser input type. `handler` therefore never sees unvalidated data.
 */
export interface ReasonerToolDefinition<TSchema extends z.ZodTypeAny = z.ZodTypeAny> {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  /** true for tools that mutate the graph; used for MCP annotations. */
  readonly mutating: boolean;
  readonly inputSchema: TSchema;
  readonly handler: (input: z.output<TSchema>) => Promise<Result<unknown>>;
}

export type AnyReasonerTool = ReasonerToolDefinition<z.ZodTypeAny>;

/**
 * The complete tool surface. This array is the single source of truth for what
 * the server exposes: registration, contract tests and docs all read from it,
 * so a tool cannot be added in one place and forgotten in another.
 */
export const buildReasonerTools = (service: ReasonerService): readonly AnyReasonerTool[] => {
  const define = <TSchema extends z.ZodTypeAny>(
    definition: ReasonerToolDefinition<TSchema>,
  ): AnyReasonerTool => definition as unknown as AnyReasonerTool;

  return [
    define({
      name: 'create_reasoning_session',
      title: 'Create reasoning session',
      description:
        'Opens a reasoning session and creates its Goal vertex. Returns the session and the goal vertex id.',
      mutating: true,
      inputSchema: CreateReasoningSessionInputSchema,
      handler: (input) => service.createReasoningSession(input),
    }),
    define({
      name: 'get_reasoning_session',
      title: 'Get reasoning session',
      description: 'Reads one session: goal state, strategy, budget, revision and event cursor.',
      mutating: false,
      inputSchema: GetReasoningSessionInputSchema,
      handler: (input) => service.getReasoningSession(input),
    }),
    define({
      name: 'list_reasoning_sessions',
      title: 'List reasoning sessions',
      description: 'Lists sessions, most recent first. Finished sessions are excluded by default.',
      mutating: false,
      inputSchema: ListReasoningSessionsInputSchema,
      handler: (input) => service.listReasoningSessions(input),
    }),
    define({
      name: 'finish_reasoning_session',
      title: 'Finish reasoning session',
      description:
        'Terminates a session with an explicit goal state. Every Candidate or Leased edge becomes Abandoned.',
      mutating: true,
      inputSchema: FinishReasoningSessionInputSchema,
      handler: (input) => service.finishReasoningSession(input),
    }),
    define({
      name: 'add_state_vertex',
      title: 'Add state vertex',
      description:
        'Submits an asserted state. Re-submitting the same content returns the existing vertex without consuming a revision.',
      mutating: true,
      inputSchema: AddStateVertexInputSchema,
      handler: (input) => service.addStateVertex(input),
    }),
    define({
      name: 'add_evidence_vertex',
      title: 'Add evidence vertex',
      description:
        'Submits supporting evidence as a vertex. Evidence needs no derivation and can ground inferences.',
      mutating: true,
      inputSchema: AddEvidenceVertexInputSchema,
      handler: (input) => service.addEvidenceVertex(input),
    }),
    define({
      name: 'get_vertex',
      title: 'Get vertex',
      description: 'Reads one vertex with the ids of its incoming and outgoing inference edges.',
      mutating: false,
      inputSchema: GetVertexInputSchema,
      handler: (input) => service.getVertex(input),
    }),
    define({
      name: 'propose_inference_edge',
      title: 'Propose inference edge',
      description:
        'Proposes a candidate hyperedge from all premises to all conclusions, optionally carrying evidence questions. Questions are edge attributes, never separate vertices.',
      mutating: true,
      inputSchema: ProposeInferenceEdgeInputSchema,
      handler: (input) => service.proposeInferenceEdge(input),
    }),
    define({
      name: 'get_inference_edge',
      title: 'Get inference edge',
      description: 'Reads one inference edge including its state, lease and evidence questions.',
      mutating: false,
      inputSchema: GetInferenceEdgeInputSchema,
      handler: (input) => service.getInferenceEdge(input),
    }),
    define({
      name: 'list_candidate_edges',
      title: 'List candidate edges',
      description:
        'Lists the candidate frontier in the deterministic order of the session strategy (DFS, BFS or Priority).',
      mutating: false,
      inputSchema: ListCandidateEdgesInputSchema,
      handler: (input) => service.listCandidateEdges(input),
    }),
    define({
      name: 'claim_inference_edge',
      title: 'Claim inference edge',
      description:
        'Takes an exclusive lease on one edge and returns its execution context. At most one live lease per edge.',
      mutating: true,
      inputSchema: ClaimInferenceEdgeInputSchema,
      handler: (input) => service.claimInferenceEdge(input),
    }),
    define({
      name: 'claim_inference_edges',
      title: 'Claim inference edges',
      description:
        'Claims up to maxEdges from the frontier in strategy order, for agents working in parallel.',
      mutating: true,
      inputSchema: ClaimInferenceEdgesInputSchema,
      handler: (input) => service.claimInferenceEdges(input),
    }),
    define({
      name: 'release_inference_edge',
      title: 'Release inference edge',
      description: 'Gives up a held lease and returns the edge to the candidate frontier.',
      mutating: true,
      inputSchema: ReleaseInferenceEdgeInputSchema,
      handler: (input) => service.releaseInferenceEdge(input),
    }),
    define({
      name: 'answer_evidence_question',
      title: 'Answer evidence question',
      description:
        'Records the answer to one evidence question on a leased edge. All questions must be answered before completion.',
      mutating: true,
      inputSchema: AnswerEvidenceQuestionInputSchema,
      handler: (input) => service.answerEvidenceQuestion(input),
    }),
    define({
      name: 'complete_inference_edge',
      title: 'Complete inference edge',
      description:
        'Completes a leased edge. Requires the context hash issued at claim time and rejects any completion that would make the completed subgraph cyclic.',
      mutating: true,
      inputSchema: CompleteInferenceEdgeInputSchema,
      handler: (input) => service.completeInferenceEdge(input),
    }),
    define({
      name: 'block_inference_edge',
      title: 'Block inference edge',
      description: 'Marks an edge as blocked with a reason, removing it from the frontier.',
      mutating: true,
      inputSchema: BlockInferenceEdgeInputSchema,
      handler: (input) => service.blockInferenceEdge(input),
    }),
    define({
      name: 'get_context_for_vertex',
      title: 'Get context for vertex',
      description:
        'Projection for deciding which edges to propose from a vertex: the vertex, its full necessary ancestor subgraph, evidence digests and a global summary.',
      mutating: false,
      inputSchema: GetContextForVertexInputSchema,
      handler: (input) => service.getContextForVertex(input),
    }),
    define({
      name: 'get_context_for_edge',
      title: 'Get context for edge',
      description:
        'Projection for executing one edge: its premises, conclusions, evidence questions and ancestors, plus the context hash required to complete it.',
      mutating: false,
      inputSchema: GetContextForEdgeInputSchema,
      handler: (input) => service.getContextForEdge(input),
    }),
    define({
      name: 'get_reasoning_context',
      title: 'Get reasoning context',
      description:
        'Session-level overview: snapshot, frontier, edge counts by state and the event log paged by eventSeq. Does not return single-vertex or single-edge payloads.',
      mutating: false,
      inputSchema: GetReasoningContextInputSchema,
      handler: (input) => service.getReasoningContext(input),
    }),
  ];
};

/**
 * Parses unknown tool input and dispatches. Zod failures are mapped to the
 * InvalidInput error code rather than thrown, so protocol callers always get a
 * structured payload instead of a stack trace.
 */
export const invokeReasonerTool = async (
  tool: AnyReasonerTool,
  rawInput: unknown,
): Promise<Result<unknown>> => {
  const parsed = tool.inputSchema.safeParse(rawInput);
  if (!parsed.success) {
    return err('InvalidInput', `invalid input for ${tool.name}`, {
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    });
  }
  return tool.handler(parsed.data);
};

export class ReasonerToolController {
  private readonly byName: ReadonlyMap<string, AnyReasonerTool>;
  private readonly log: Logger;

  constructor(
    private readonly tools: readonly AnyReasonerTool[],
    logger?: Logger,
  ) {
    this.byName = new Map(tools.map((tool) => [tool.name, tool]));
    this.log = (logger ?? NULL_LOGGER).child({ component: 'tool-controller' });
  }

  list(): readonly AnyReasonerTool[] {
    return this.tools;
  }

  names(): readonly string[] {
    return this.tools.map((tool) => tool.name);
  }

  async invoke(name: string, rawInput: unknown): Promise<Result<unknown>> {
    const tool = this.byName.get(name);
    if (tool === undefined) {
      this.log.warn({ tool: name }, 'tool invocation failed: unknown tool');
      return err('InvalidInput', `unknown tool ${name}`, { tool: name });
    }

    const startedAt = process.hrtime.bigint();
    const result = await invokeReasonerTool(tool, rawInput);
    const durationMs = Math.round(Number(process.hrtime.bigint() - startedAt) / 1e3) / 1e3;

    if (isErr(result)) {
      this.log.debug({ tool: name, durationMs, code: result.error.code }, 'tool rejected');
    } else {
      this.log.trace({ tool: name, durationMs }, 'tool ok');
    }

    return result;
  }
}

export const createReasonerToolController = (
  service: ReasonerService,
  options: { logger?: Logger } = {},
): ReasonerToolController => new ReasonerToolController(buildReasonerTools(service), options.logger);
