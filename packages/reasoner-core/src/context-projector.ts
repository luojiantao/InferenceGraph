import type {
  EdgeExecutionContext,
  EdgeId,
  GlobalNavigationSummary,
  GraphSnapshot,
  InferenceEdge,
  ProjectionPolicy,
  Result,
  Vertex,
  VertexExpansionContext,
  VertexId,
} from '@reasoner/schema';
import { err, ok } from '@reasoner/schema';
import { buildGraphIndex, type GraphIndex } from './graph-index.js';
import { hashCanonical } from './dedup.js';
import { orderFrontier } from './search-strategy.js';

type AncestorEdgePredicate = (edge: InferenceEdge) => boolean;

/** Shared backwards traversal with an explicit inclusion rule per projection type. */
const collectAncestorsWhere = (
  index: GraphIndex,
  start: VertexId,
  maxDepth: number,
  includeEdge: AncestorEdgePredicate,
): { vertices: readonly Vertex[]; edges: readonly InferenceEdge[] } => {
  const seenVertices = new Set<VertexId>();
  const seenEdges = new Set<EdgeId>();
  const vertices: Vertex[] = [];
  const edges: InferenceEdge[] = [];

  const queue: Array<{ vertexId: VertexId; depth: number }> = [{ vertexId: start, depth: 0 }];

  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) continue;
    if (current.depth >= maxDepth) continue;

    const incoming = index.incomingEdgeIds.get(current.vertexId) ?? [];
    for (const edgeId of incoming) {
      const edge = index.edgeById.get(edgeId);
      if (edge === undefined || !includeEdge(edge)) continue;
      if (seenEdges.has(edgeId)) continue;
      seenEdges.add(edgeId);
      edges.push(edge);

      // Every premise of this edge is required, not just one.
      for (const sourceId of edge.sourceVertexIds) {
        const sourceVertex = index.vertexById.get(sourceId);
        if (sourceVertex !== undefined && !seenVertices.has(sourceId)) {
          seenVertices.add(sourceId);
          vertices.push(sourceVertex);
        }
        queue.push({ vertexId: sourceId, depth: current.depth + 1 });
      }
    }
  }

  return {
    vertices: [...vertices].sort((a, b) => (a.vertexId < b.vertexId ? -1 : 1)),
    edges: [...edges].sort((a, b) => (a.edgeId < b.edgeId ? -1 : 1)),
  };
};

/**
 * Walks Completed incoming edges backwards for execution contexts. Unverified
 * candidate branches must not affect a claim's completion hash.
 */
export const collectAncestors = (
  index: GraphIndex,
  start: VertexId,
  maxDepth: number,
): { vertices: readonly Vertex[]; edges: readonly InferenceEdge[] } =>
  collectAncestorsWhere(index, start, maxDepth, (edge) => edge.state === 'Completed');

/**
 * Vertex views are planning and audit surfaces, so they retain active and
 * blocked alternatives. Abandoned and invalid relations are excluded because
 * they no longer form a usable or explainable dependency branch.
 */
const collectVertexProjectionAncestors = (
  index: GraphIndex,
  start: VertexId,
  maxDepth: number,
): { vertices: readonly Vertex[]; edges: readonly InferenceEdge[] } =>
  collectAncestorsWhere(
    index,
    start,
    maxDepth,
    (edge) => edge.state !== 'Abandoned' && edge.state !== 'Invalid',
  );

const buildGlobalSummary = (index: GraphIndex): GlobalNavigationSummary => {
  const counts: Record<string, number> = {};
  for (const edge of index.snapshot.edges) {
    counts[edge.state] = (counts[edge.state] ?? 0) + 1;
  }
  const frontier = orderFrontier(index, index.snapshot.session.strategy);
  let maxDepth = 0;
  for (const entry of frontier) maxDepth = Math.max(maxDepth, entry.depth);

  return {
    vertexCount: index.snapshot.vertices.length,
    edgeCountByState: counts,
    frontierEdgeIds: frontier.map((entry) => entry.edgeId),
    goalState: index.snapshot.session.goalState,
    maxCompletedDepth: maxDepth,
  };
};

const evidenceDigests = (index: GraphIndex) =>
  index.snapshot.vertices
    .filter((vertex) => vertex.kind === 'Evidence')
    .map((vertex) => ({
      vertexId: vertex.vertexId,
      label: vertex.label,
      supportedEdgeIds: [...(index.outgoingEdgeIds.get(vertex.vertexId) ?? [])].sort(),
    }));

const includeGlobalSummary = (policy: ProjectionPolicy): boolean =>
  policy === 'DependencySubgraphWithGlobalSummary' || policy === 'FullGraph';

/** Builds the vertex-expansion projection served by get_context_for_vertex. */
export const projectVertexContext = (
  snapshot: GraphSnapshot,
  vertexId: VertexId,
  policy: ProjectionPolicy,
): Result<VertexExpansionContext> => {
  const index = buildGraphIndex(snapshot);
  const currentVertex = index.vertexById.get(vertexId);
  if (currentVertex === undefined) {
    return err('VertexNotFound', `vertex ${vertexId} is not part of session ${snapshot.session.sessionId}`, {
      vertexId,
    });
  }
  const goalVertex = index.vertexById.get(snapshot.session.goalVertexId);
  if (goalVertex === undefined) {
    return err('StructurallyInvalid', 'session goal vertex is missing from the snapshot', {
      goalVertexId: snapshot.session.goalVertexId,
    });
  }

  const maxDepth = policy === 'CurrentOnly' ? 0 : snapshot.session.budget.maxDepth;
  const ancestors =
    policy === 'FullGraph'
      ? {
          vertices: [...snapshot.vertices].sort((a, b) => (a.vertexId < b.vertexId ? -1 : 1)),
          edges: [...snapshot.edges].sort((a, b) => (a.edgeId < b.edgeId ? -1 : 1)),
        }
      : collectVertexProjectionAncestors(index, vertexId, maxDepth);

  const includedVertexIds = new Set<VertexId>([vertexId, ...ancestors.vertices.map((v) => v.vertexId)]);
  const includedEdgeIds = new Set<EdgeId>(ancestors.edges.map((e) => e.edgeId));

  const omittedVertexIds = snapshot.vertices
    .map((v) => v.vertexId)
    .filter((id) => !includedVertexIds.has(id))
    .sort();
  const omittedEdgeIds = snapshot.edges
    .map((e) => e.edgeId)
    .filter((id) => !includedEdgeIds.has(id))
    .sort();

  const expansionHandles =
    policy === 'FullGraph'
      ? []
      : [
          {
            handleId: `vertex:${vertexId}:FullGraph`,
            policy: 'FullGraph' as ProjectionPolicy,
            description: 'Re-request this vertex with the entire session graph included.',
          },
        ];

  const body = {
    sessionId: snapshot.session.sessionId,
    vertexId,
    policy,
    graphRevision: snapshot.graphRevision,
    goalVertex,
    currentVertex,
    ancestorVertices: ancestors.vertices,
    ancestorEdges: ancestors.edges,
    evidenceDigests: policy === 'CurrentOnly' ? [] : evidenceDigests(index),
    ...(includeGlobalSummary(policy) ? { globalSummary: buildGlobalSummary(index) } : {}),
    expansionHandles,
    omittedVertexIds,
    omittedEdgeIds,
  };

  return ok({ ...body, contextHash: hashCanonical(body) } as VertexExpansionContext);
};

/**
 * Edge-local material that defines a claim. The completion hash is computed over
 * this and nothing else, so unrelated graph growth by other agents cannot
 * invalidate an in-flight claim (that would deadlock parallel work). Only
 * changes to *this* edge's formula membership, premises, conclusions, label,
 * cost or question prompts do.
 *
 * Question *answers* are deliberately excluded: only the lease holder can write
 * them, so they are the holder's own work product rather than an input that
 * could go stale underneath them. Including them would make an agent invalidate
 * its own claim simply by answering.
 */
const edgeIdentityMaterial = (edge: InferenceEdge, sourceVertices: readonly Vertex[]) => ({
  edgeId: edge.edgeId,
  formulaId: edge.formulaId,
  label: edge.label,
  cost: edge.cost,
  priority: edge.priority,
  targetVertexIds: [...edge.targetVertexIds].sort(),
  sourceVertexIds: [...edge.sourceVertexIds].sort(),
  sourceVertexHashes: [...sourceVertices]
    .sort((a, b) => (a.vertexId < b.vertexId ? -1 : 1))
    .map((vertex) => ({
      vertexId: vertex.vertexId,
      kind: vertex.kind,
      label: vertex.label,
      payload: vertex.payload,
    })),
  evidenceQuestionPrompts: [...edge.evidenceQuestions]
    .sort((a, b) => (a.questionId < b.questionId ? -1 : 1))
    .map((question) => ({
      questionId: question.questionId,
      prompt: question.prompt,
    })),
});

/** Stable hash of a claim's edge-local material; see edgeIdentityMaterial. */
export const computeEdgeContextHash = (
  edge: InferenceEdge,
  sourceVertices: readonly Vertex[],
): string => hashCanonical(edgeIdentityMaterial(edge, sourceVertices));

/** Builds the edge-execution projection served by get_context_for_edge and claim. */
export const projectEdgeContext = (
  snapshot: GraphSnapshot,
  edgeId: EdgeId,
  policy: ProjectionPolicy,
): Result<EdgeExecutionContext> => {
  const index = buildGraphIndex(snapshot);
  const edge = index.edgeById.get(edgeId);
  if (edge === undefined) {
    return err('EdgeNotFound', `edge ${edgeId} is not part of session ${snapshot.session.sessionId}`, {
      edgeId,
    });
  }
  const goalVertex = index.vertexById.get(snapshot.session.goalVertexId);
  if (goalVertex === undefined) {
    return err('StructurallyInvalid', 'session goal vertex is missing from the snapshot', {
      goalVertexId: snapshot.session.goalVertexId,
    });
  }
  const targetVertices: Vertex[] = [];
  for (const targetId of edge.targetVertexIds) {
    const vertex = index.vertexById.get(targetId);
    if (vertex === undefined) {
      return err('StructurallyInvalid', `edge ${edgeId} targets unknown vertex ${targetId}`, {
        targetVertexId: targetId,
      });
    }
    targetVertices.push(vertex);
  }

  const sourceVertices: Vertex[] = [];
  for (const sourceId of edge.sourceVertexIds) {
    const vertex = index.vertexById.get(sourceId);
    if (vertex === undefined) {
      return err('StructurallyInvalid', `edge ${edgeId} references unknown source ${sourceId}`, {
        sourceVertexId: sourceId,
      });
    }
    sourceVertices.push(vertex);
  }

  const maxDepth = policy === 'CurrentOnly' ? 0 : snapshot.session.budget.maxDepth;
  const ancestorSets = edge.sourceVertexIds.map((sourceId) =>
    collectAncestors(index, sourceId, maxDepth),
  );
  const ancestorVertexMap = new Map<VertexId, Vertex>();
  const ancestorEdgeMap = new Map<EdgeId, InferenceEdge>();
  for (const set of ancestorSets) {
    for (const vertex of set.vertices) ancestorVertexMap.set(vertex.vertexId, vertex);
    for (const ancestorEdge of set.edges) ancestorEdgeMap.set(ancestorEdge.edgeId, ancestorEdge);
  }

  const ancestorVertices = [...ancestorVertexMap.values()].sort((a, b) =>
    a.vertexId < b.vertexId ? -1 : 1,
  );
  const ancestorEdges = [...ancestorEdgeMap.values()].sort((a, b) =>
    a.edgeId < b.edgeId ? -1 : 1,
  );

  const includedVertexIds = new Set<VertexId>([
    ...edge.targetVertexIds,
    ...edge.sourceVertexIds,
    ...ancestorVertices.map((v) => v.vertexId),
  ]);
  const includedEdgeIds = new Set<EdgeId>([edgeId, ...ancestorEdges.map((e) => e.edgeId)]);

  const omittedVertexIds = snapshot.vertices
    .map((v) => v.vertexId)
    .filter((id) => !includedVertexIds.has(id))
    .sort();
  const omittedEdgeIds = snapshot.edges
    .map((e) => e.edgeId)
    .filter((id) => !includedEdgeIds.has(id))
    .sort();

  const context: EdgeExecutionContext = {
    sessionId: snapshot.session.sessionId,
    edgeId,
    policy,
    graphRevision: snapshot.graphRevision,
    goalVertex,
    edge,
    sourceVertices,
    targetVertices,
    evidenceQuestions: edge.evidenceQuestions,
    ancestorVertices,
    ancestorEdges,
    ...(includeGlobalSummary(policy) ? { globalSummary: buildGlobalSummary(index) } : {}),
    expansionHandles:
      policy === 'FullGraph'
        ? []
        : [
            {
              handleId: `edge:${edgeId}:FullGraph`,
              policy: 'FullGraph',
              description: 'Re-request this edge with the entire session graph included.',
            },
          ],
    omittedVertexIds,
    omittedEdgeIds,
    contextHash: computeEdgeContextHash(edge, sourceVertices),
  };

  return ok(context);
};

export const buildNavigationSummary = (snapshot: GraphSnapshot): GlobalNavigationSummary =>
  buildGlobalSummary(buildGraphIndex(snapshot));
