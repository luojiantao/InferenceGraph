import { z } from 'zod';
import {
  isErr,
  type AgentId,
  type EdgeId,
  type GraphRevision,
  type Result,
  type SearchStrategy,
  type SessionId,
  type VertexId,
} from '@reasoner/schema';
import type { ReasonerService } from '@reasoner/core';

export const FixtureVertexSchema = z.object({
  key: z.string().min(1),
  kind: z.enum(['State', 'Evidence']),
  label: z.string().min(1),
  payload: z.record(z.unknown()).default({}),
});

export const FixtureEdgeSchema = z.object({
  key: z.string().min(1),
  sources: z.array(z.string().min(1)).min(1),
  targets: z.array(z.string().min(1)).min(1),
  label: z.string().min(1),
  cost: z.number().finite().nonnegative().default(1),
  priority: z.number().finite().default(0),
  questions: z
    .array(z.object({ prompt: z.string().min(1), answer: z.string().min(1) }))
    .default([]),
});

export const ReplayFixtureSchema = z.object({
  name: z.string().min(1),
  description: z.string().default(''),
  goalLabel: z.string().min(1),
  goalPayload: z.record(z.unknown()).default({}),
  vertices: z.array(FixtureVertexSchema).min(1),
  edges: z.array(FixtureEdgeSchema).min(1),
  expectations: z
    .object({
      totalEdges: z.number().int().nonnegative(),
      multiPremiseEdgeKeys: z.array(z.string()).default([]),
      goalMustBeSupported: z.boolean().default(true),
    })
    .optional(),
});

export type ReplayFixture = z.infer<typeof ReplayFixtureSchema>;

/** Placeholder in a fixture's `targets` meaning the session's Goal vertex. */
export const GOAL_KEY = '__goal__';

export interface ReplayReport {
  readonly fixtureName: string;
  readonly strategy: SearchStrategy;
  readonly sessionId: SessionId;
  readonly goalVertexId: VertexId;
  readonly finalRevision: GraphRevision;
  readonly lastEventSeq: number;
  /** Edge ids in the order the strategy handed them out. */
  readonly completionOrder: readonly EdgeId[];
  readonly completedEdgeCount: number;
  readonly goalState: string;
  readonly goalSupported: boolean;
  readonly eventCount: number;
}

const unwrap = <T>(result: Result<T>, context: string): T => {
  if (isErr(result)) {
    throw new Error(`${context} failed: ${result.error.code} — ${result.error.message}`);
  }
  return result.value;
};

/**
 * Replays a fixture against a live ReasonerService.
 *
 * The agent supplies every label, question and answer from the fixture. It is
 * deliberately dumb: it contains no domain rules, which is what makes it
 * evidence that the Core stores and schedules rather than reasons.
 */
export class ReasonerTestAgent {
  constructor(
    private readonly service: ReasonerService,
    private readonly agentId: AgentId,
  ) {}

  async runSession(
    fixture: ReplayFixture,
    strategy: SearchStrategy = 'DFS',
  ): Promise<ReplayReport> {
    const created = unwrap(
      await this.service.createReasoningSession({
        agentId: this.agentId,
        goalLabel: fixture.goalLabel,
        goalPayload: fixture.goalPayload,
        strategy,
        projectionPolicy: 'DependencySubgraphWithGlobalSummary',
      }),
      'create session',
    );

    const sessionId = created.session.sessionId;
    const goalVertexId = created.goalVertex.vertexId;
    let revision = created.session.graphRevision;

    // Fixture key -> real vertex id.
    const vertexIds = new Map<string, VertexId>([[GOAL_KEY, goalVertexId]]);

    for (const vertex of fixture.vertices) {
      const input = {
        sessionId,
        baseGraphRevision: revision,
        agentId: this.agentId,
        label: vertex.label,
        payload: vertex.payload,
      };
      const added =
        vertex.kind === 'Evidence'
          ? unwrap(await this.service.addEvidenceVertex(input), `add evidence ${vertex.key}`)
          : unwrap(await this.service.addStateVertex(input), `add state ${vertex.key}`);
      revision = added.graphRevision;
      vertexIds.set(vertex.key, added.vertex.vertexId);
    }

    const resolve = (key: string): VertexId => {
      const id = vertexIds.get(key);
      if (id === undefined) throw new Error(`fixture references unknown vertex key ${key}`);
      return id;
    };

    const edgeIds = new Map<string, EdgeId>();
    for (const edge of fixture.edges) {
      const proposed = unwrap(
        await this.service.proposeInferenceEdge({
          sessionId,
          baseGraphRevision: revision,
          agentId: this.agentId,
          sourceVertexIds: edge.sources.map(resolve),
          targetVertexIds: edge.targets.map(resolve),
          label: edge.label,
          cost: edge.cost,
          priority: edge.priority,
          evidenceQuestions: edge.questions.map((question) => ({ prompt: question.prompt })),
        }),
        `propose ${edge.key}`,
      );
      revision = proposed.graphRevision;
      edgeIds.set(edge.key, proposed.edge.edgeId);
    }

    // Answers keyed by question prompt, so the agent never invents content.
    const answerByPrompt = new Map<string, string>();
    for (const edge of fixture.edges) {
      for (const question of edge.questions) {
        answerByPrompt.set(question.prompt, question.answer);
      }
    }

    const completionOrder: EdgeId[] = [];

    // Drain the frontier in whatever order the strategy dictates.
    for (;;) {
      const claimed = await this.claimNext(sessionId, revision, strategy);
      if (claimed === null) break;
      revision = claimed.revision;
      completionOrder.push(claimed.edgeId);

      for (const question of claimed.questions) {
        const answer = answerByPrompt.get(question.prompt);
        if (answer === undefined) {
          throw new Error(`fixture has no answer for question: ${question.prompt}`);
        }
        const answered = unwrap(
          await this.service.answerEvidenceQuestion({
            sessionId,
            baseGraphRevision: revision,
            agentId: this.agentId,
            edgeId: claimed.edgeId,
            leaseId: claimed.leaseId,
            questionId: question.questionId,
            answer,
          }),
          `answer question on ${claimed.edgeId}`,
        );
        revision = answered.graphRevision;
      }

      const completed = unwrap(
        await this.service.completeInferenceEdge({
          sessionId,
          baseGraphRevision: revision,
          agentId: this.agentId,
          edgeId: claimed.edgeId,
          leaseId: claimed.leaseId,
          inputContextHash: claimed.contextHash,
          conclusion: `established: ${claimed.label}`,
        }),
        `complete ${claimed.edgeId}`,
      );
      revision = completed.graphRevision;
    }

    const context = unwrap(
      await this.service.getReasoningContext({
        sessionId,
        afterEventSeq: 0,
        eventLimit: 1000,
      }),
      'read final context',
    );

    const completedEdgeCount = context.snapshot.edges.filter(
      (edge) => edge.state === 'Completed',
    ).length;

    return {
      fixtureName: fixture.name,
      strategy,
      sessionId,
      goalVertexId,
      finalRevision: context.snapshot.graphRevision,
      lastEventSeq: context.snapshot.session.lastEventSeq,
      completionOrder,
      completedEdgeCount,
      goalState: context.snapshot.session.goalState,
      goalSupported: context.snapshot.session.goalState === 'CandidateFound',
      eventCount: context.events.length,
    };
  }

  /**
   * Claims the next edge the strategy offers, or returns null when the frontier
   * is empty. Reading the frontier and then claiming is safe here because a
   * losing race surfaces as EdgeNotClaimable, which this single-agent replay
   * treats as "frontier drained".
   */
  private async claimNext(
    sessionId: SessionId,
    revision: GraphRevision,
    strategy: SearchStrategy,
  ): Promise<{
    revision: GraphRevision;
    edgeId: EdgeId;
    leaseId: import('@reasoner/schema').LeaseId;
    contextHash: string;
    label: string;
    questions: readonly { questionId: import('@reasoner/schema').QuestionId; prompt: string }[];
  } | null> {
    const frontier = unwrap(
      await this.service.listCandidateEdges({ sessionId, strategy, limit: 1 }),
      'list candidate edges',
    );
    const next = frontier.edges[0];
    if (next === undefined) return null;

    const claimed = unwrap(
      await this.service.claimInferenceEdge({
        sessionId,
        baseGraphRevision: revision,
        agentId: this.agentId,
        edgeId: next.edgeId,
      }),
      `claim ${next.edgeId}`,
    );

    return {
      revision: claimed.graphRevision,
      edgeId: claimed.edge.edgeId,
      leaseId: claimed.leaseId,
      contextHash: claimed.context.contextHash,
      label: claimed.edge.label,
      questions: claimed.edge.evidenceQuestions.map((question) => ({
        questionId: question.questionId,
        prompt: question.prompt,
      })),
    };
  }
}
