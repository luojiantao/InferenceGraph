import type {
  CreateReasoningSessionOutput,
  DeleteReasoningSessionOutput,
  EdgeId,
  GraphRevision,
  GetContextForEdgeOutput,
  GetContextForVertexOutput,
  GetReasoningContextOutput,
  InferenceEdgeQuestionInput,
  ListReasoningSessionsOutput,
  SessionId,
  UpdateInferenceEdgeOutput,
  UpdateReasoningSessionMetadataOutput,
  UpdateVertexOutput,
  VertexId,
} from '@reasoner/schema';

const WEB_AGENT_ID = 'reasoner-web-ui';

/** Structured error surfaced by the server's tool bridge. */
export interface ReasonerApiError {
  readonly code: string;
  readonly message: string;
  readonly details?: unknown;
}

export class ReasonerRequestError extends Error {
  constructor(
    readonly apiError: ReasonerApiError,
    readonly status: number,
  ) {
    super(apiError.message);
    this.name = 'ReasonerRequestError';
  }
}

/**
 * The UI never touches SQLite or Core objects. Every read goes through the
 * server's tool bridge, which shares one validation and error-mapping path with
 * the MCP transport.
 */
const invokeTool = async <T>(tool: string, input: unknown, signal?: AbortSignal): Promise<T> => {
  const response = await fetch(`/api/tools/${tool}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input ?? {}),
    ...(signal ? { signal } : {}),
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: ReasonerApiError } | null;
    throw new ReasonerRequestError(
      body?.error ?? { code: 'NetworkError', message: `Request failed (${response.status})` },
      response.status,
    );
  }
  return (await response.json()) as T;
};

export const reasonerApi = {
  listSessions: (signal?: AbortSignal): Promise<ListReasoningSessionsOutput> =>
    invokeTool('list_reasoning_sessions', { limit: 100, includeFinished: true }, signal),

  createSession: (
    input: {
      readonly goalLabel: string;
      readonly alias?: string;
      readonly tags: readonly string[];
    },
    signal?: AbortSignal,
  ): Promise<CreateReasoningSessionOutput> =>
    invokeTool(
      'create_reasoning_session',
      {
        agentId: WEB_AGENT_ID,
        goalLabel: input.goalLabel,
        ...(input.alias === undefined ? {} : { alias: input.alias }),
        tags: input.tags,
      },
      signal,
    ),

  updateSessionMetadata: (
    input: {
      readonly sessionId: SessionId;
      readonly baseGraphRevision: GraphRevision;
      readonly alias: string | null;
      readonly tags: readonly string[];
    },
    signal?: AbortSignal,
  ): Promise<UpdateReasoningSessionMetadataOutput> =>
    invokeTool('update_reasoning_session_metadata', { ...input, agentId: WEB_AGENT_ID }, signal),

  deleteSession: (
    input: { readonly sessionId: SessionId; readonly baseGraphRevision: GraphRevision },
    signal?: AbortSignal,
  ): Promise<DeleteReasoningSessionOutput> =>
    invokeTool(
      'delete_reasoning_session',
      { ...input, agentId: WEB_AGENT_ID, confirm: true },
      signal,
    ),

  /**
   * Single polling endpoint: snapshot, ordered frontier, state counts and the
   * event page after `afterEventSeq`. Paging is keyed on eventSeq, never on
   * graphRevision, so a revision that emits several events cannot drop one.
   */
  getReasoningContext: (
    sessionId: SessionId,
    afterEventSeq: number,
    signal?: AbortSignal,
  ): Promise<GetReasoningContextOutput> =>
    invokeTool('get_reasoning_context', { sessionId, afterEventSeq, eventLimit: 200 }, signal),

  getContextForEdge: (
    sessionId: SessionId,
    edgeId: EdgeId,
    signal?: AbortSignal,
  ): Promise<GetContextForEdgeOutput> =>
    invokeTool(
      'get_context_for_edge',
      { sessionId, edgeId, policy: 'DependencySubgraphWithGlobalSummary' },
      signal,
    ),

  getContextForVertex: (
    sessionId: SessionId,
    vertexId: VertexId,
    signal?: AbortSignal,
  ): Promise<GetContextForVertexOutput> =>
    invokeTool(
      'get_context_for_vertex',
      { sessionId, vertexId, policy: 'DependencySubgraphWithGlobalSummary' },
      signal,
    ),

  updateVertex: (
    input: {
      readonly sessionId: SessionId;
      readonly vertexId: VertexId;
      readonly baseGraphRevision: GraphRevision;
      readonly label?: string;
      readonly payload?: Record<string, unknown>;
    },
    signal?: AbortSignal,
  ): Promise<UpdateVertexOutput> =>
    invokeTool('update_vertex', { ...input, agentId: WEB_AGENT_ID }, signal),

  updateInferenceEdge: (
    input: {
      readonly sessionId: SessionId;
      readonly edgeId: EdgeId;
      readonly baseGraphRevision: GraphRevision;
      readonly label?: string;
      readonly cost?: number;
      readonly priority?: number;
      readonly evidenceQuestions?: readonly InferenceEdgeQuestionInput[];
    },
    signal?: AbortSignal,
  ): Promise<UpdateInferenceEdgeOutput> =>
    invokeTool('update_inference_edge', { ...input, agentId: WEB_AGENT_ID }, signal),
};
