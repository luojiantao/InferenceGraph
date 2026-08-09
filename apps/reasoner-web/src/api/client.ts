import type {
  EdgeId,
  GetContextForEdgeOutput,
  GetContextForVertexOutput,
  GetReasoningContextOutput,
  ListReasoningSessionsOutput,
  SessionId,
  VertexId,
} from '@reasoner/schema';

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
};
