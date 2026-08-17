import type { z } from 'zod';
import {
  AddEvidenceVertexInputSchema,
  AddStateVertexInputSchema,
  BlockInferenceEdgeInputSchema,
  ClaimInferenceEdgeInputSchema,
  ClaimInferenceEdgesInputSchema,
  ClaimVertexExpansionsInputSchema,
  CompleteInferenceEdgeInputSchema,
  CreateReasoningSessionInputSchema,
  DeleteReasoningSessionInputSchema,
  FinishReasoningSessionInputSchema,
  GetContextForEdgeInputSchema,
  GetContextForVertexInputSchema,
  GetDownstreamContextForVertexInputSchema,
  GetInferenceEdgeInputSchema,
  GetReasoningContextInputSchema,
  GetReasoningSessionInputSchema,
  GetReasoningTextForVertexInputSchema,
  IncreaseReasoningSessionEdgeBudgetInputSchema,
  GetVertexInputSchema,
  UpdateVertexInputSchema,
  ListCandidateEdgesInputSchema,
  ListReasoningSessionsInputSchema,
  ProposeInferenceEdgeInputSchema,
  UpdateInferenceEdgeInputSchema,
  SetVertexExpansionStateInputSchema,
  ReleaseInferenceEdgeInputSchema,
  AnswerEvidenceQuestionInputSchema,
  UpdateReasoningSessionMetadataInputSchema,
  err,
  isErr,
  NULL_LOGGER,
  ok,
  resolveEdgeReference,
  resolveVertexReference,
  type EdgeId,
  type Logger,
  type Result,
  type SessionId,
  type VertexId,
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

interface GraphReferenceInput {
  readonly sessionId?: SessionId;
  readonly vertexId?: VertexId;
  readonly rootVertexId?: VertexId;
  readonly edgeId?: EdgeId;
  readonly sourceVertexIds?: readonly VertexId[];
  readonly targetVertexIds?: readonly VertexId[];
}

const VERTEX_REFERENCE_TOOLS = new Set([
  'get_vertex',
  'update_vertex',
  'propose_inference_edge',
  'get_context_for_vertex',
  'get_downstream_context_for_vertex',
  'get_reasoning_text_for_vertex',
  'claim_vertex_expansions',
  'set_vertex_expansion_state',
]);

const EDGE_REFERENCE_TOOLS = new Set([
  'get_inference_edge',
  'update_inference_edge',
  'claim_inference_edge',
  'release_inference_edge',
  'answer_evidence_question',
  'complete_inference_edge',
  'block_inference_edge',
  'get_context_for_edge',
]);

/** Resolves public Vn/En references before a tool reaches the Core service. */
const resolveGraphReferenceInput = async <T extends object>(
  service: ReasonerService,
  toolName: string,
  input: T,
): Promise<Result<T>> => {
  if (!VERTEX_REFERENCE_TOOLS.has(toolName) && !EDGE_REFERENCE_TOOLS.has(toolName)) {
    return ok(input);
  }

  const referenceInput = input as T & GraphReferenceInput;
  if (referenceInput.sessionId === undefined) return ok(input);

  const aliases = await service.getGraphAliases(referenceInput.sessionId);
  if (isErr(aliases)) return aliases;

  if (toolName === 'propose_inference_edge') {
    const sourceVertexIds = referenceInput.sourceVertexIds;
    const targetVertexIds = referenceInput.targetVertexIds;
    if (sourceVertexIds === undefined || targetVertexIds === undefined) return ok(input);
    return ok({
      ...input,
      sourceVertexIds: sourceVertexIds.map((vertexId) =>
        resolveVertexReference(aliases.value, vertexId),
      ),
      targetVertexIds: targetVertexIds.map((vertexId) =>
        resolveVertexReference(aliases.value, vertexId),
      ),
    } as T);
  }

  if (VERTEX_REFERENCE_TOOLS.has(toolName) && referenceInput.vertexId !== undefined) {
    return ok({
      ...input,
      vertexId: resolveVertexReference(aliases.value, referenceInput.vertexId),
    } as T);
  }

  if (toolName === 'claim_vertex_expansions' && referenceInput.rootVertexId !== undefined) {
    return ok({
      ...input,
      rootVertexId: resolveVertexReference(aliases.value, referenceInput.rootVertexId),
    } as T);
  }

  if (EDGE_REFERENCE_TOOLS.has(toolName) && referenceInput.edgeId !== undefined) {
    return ok({
      ...input,
      edgeId: resolveEdgeReference(aliases.value, referenceInput.edgeId),
    } as T);
  }

  return ok(input);
};

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
      name: 'update_reasoning_session_metadata',
      title: 'Update reasoning session metadata',
      description:
        'Replaces a session alias and tags without changing any immutable Vn or En graph reference.',
      mutating: true,
      inputSchema: UpdateReasoningSessionMetadataInputSchema,
      handler: (input) => service.updateReasoningSessionMetadata(input),
    }),
    define({
      name: 'delete_reasoning_session',
      title: 'Delete reasoning session',
      description:
        'Permanently deletes the SQLite session graph after revision verification and explicit confirmation. Existing append-only JSONL audit files are retained.',
      mutating: true,
      inputSchema: DeleteReasoningSessionInputSchema,
      handler: (input) => service.deleteReasoningSession(input),
    }),
    define({
      name: 'increase_reasoning_session_edge_budget',
      title: 'Increase reasoning session edge budget',
      description:
        'Raises maxEdges for an active session. The value must exceed the current limit and cover every already stored physical edge.',
      mutating: true,
      inputSchema: IncreaseReasoningSessionEdgeBudgetInputSchema,
      handler: (input) => service.increaseReasoningSessionEdgeBudget(input),
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
      name: 'update_vertex',
      title: 'Update vertex',
      description:
        'Manually updates a vertex label and/or payload while preserving its Vn reference and structural kind. Leased relations must be released first.',
      mutating: true,
      inputSchema: UpdateVertexInputSchema,
      handler: (input) => service.updateVertex(input),
    }),
    define({
      name: 'propose_inference_edge',
      title: 'Propose inference edge',
      description:
        'Expands every source/target pair into an independent candidate inference edge, each with its own En, state and evidence questions. Sources from one proposal share an AND formula for each target; separate formulae are alternative derivations. Questions remain edge attributes, never separate vertices.',
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
      name: 'update_inference_edge',
      title: 'Update inference edge',
      description:
        'Manually updates an edge label, cost, priority or Candidate evidence questions. Endpoints, formula group, En reference and lifecycle state remain immutable.',
      mutating: true,
      inputSchema: UpdateInferenceEdgeInputSchema,
      handler: (input) => service.updateInferenceEdge(input),
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
      name: 'claim_vertex_expansions',
      title: 'Claim vertex expansions',
      description:
        'Atomically selects and reserves up to maxVertices reverse-planning targets in the session strategy order. Claimed vertices are marked Expanding so other coordinators cannot duplicate the work.',
      mutating: true,
      inputSchema: ClaimVertexExpansionsInputSchema,
      handler: (input) => service.claimVertexExpansions(input),
    }),
    define({
      name: 'set_vertex_expansion_state',
      title: 'Set vertex expansion state',
      description:
        'Settles a held vertex-expansion lease as Pending, AwaitingContext, Expanded or Blocked. The lease owner and revision must match.',
      mutating: true,
      inputSchema: SetVertexExpansionStateInputSchema,
      handler: (input) => service.setVertexExpansionState(input),
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
        'Projection for deciding which edges to propose from a vertex: the vertex, its full necessary ancestor subgraph, evidence digests and a global summary. vertexId accepts a canonical id or session-local Vn reference.',
      mutating: false,
      inputSchema: GetContextForVertexInputSchema,
      handler: (input) => service.getContextForVertex(input),
    }),
    define({
      name: 'get_downstream_context_for_vertex',
      title: 'Get downstream context for vertex',
      description:
        'Returns every direct outgoing inference edge and target vertex, plus one deterministic shortest retained route from the current vertex to the session Goal. The route is navigation context and does not imply that its edges are completed. vertexId accepts a canonical id or session-local Vn reference.',
      mutating: false,
      inputSchema: GetDownstreamContextForVertexInputSchema,
      handler: (input) => service.getDownstreamContextForVertex(input),
    }),
    define({
      name: 'get_reasoning_text_for_vertex',
      title: 'Get reasoning text for vertex',
      description:
        'Renders a vertex dependency projection as Markdown reasoning text and Mermaid source, including the target formula and its completion progress. vertexId accepts a canonical id or session-local Vn reference; only recorded graph entities and their stored states are transcribed, with no invented conclusions.',
      mutating: false,
      inputSchema: GetReasoningTextForVertexInputSchema,
      handler: (input) => service.getReasoningTextForVertex(input),
    }),
    define({
      name: 'get_context_for_edge',
      title: 'Get context for edge',
      description:
        'Projection for executing one edge: its premises, conclusions, evidence questions and ancestors, plus the context hash required to complete it. edgeId accepts a canonical id or session-local En reference.',
      mutating: false,
      inputSchema: GetContextForEdgeInputSchema,
      handler: (input) => service.getContextForEdge(input),
    }),
    define({
      name: 'get_reasoning_context',
      title: 'Get reasoning context',
      description:
        'Session-level overview: snapshot, a compact AND/OR formula-group structure, frontier, edge counts by state and the event log paged by eventSeq. Formula groups reference snapshot ids instead of duplicating vertex or edge payloads.',
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
export const invokeReasonerTool = async <TSchema extends z.ZodTypeAny>(
  tool: ReasonerToolDefinition<TSchema>,
  rawInput: unknown,
  transformInput?: (input: z.output<TSchema>) => Promise<Result<z.output<TSchema>>>,
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
  const input = transformInput === undefined ? ok(parsed.data) : await transformInput(parsed.data);
  return isErr(input) ? input : tool.handler(input.value);
};

export class ReasonerToolController {
  private readonly byName: ReadonlyMap<string, AnyReasonerTool>;
  private readonly log: Logger;

  constructor(
    private readonly service: ReasonerService,
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
    const result = await invokeReasonerTool(tool, rawInput, (input) =>
      resolveGraphReferenceInput(this.service, tool.name, input),
    );
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
): ReasonerToolController =>
  new ReasonerToolController(service, buildReasonerTools(service), options.logger);
