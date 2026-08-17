import type { VertexExpansionState, VertexKind } from '@reasoner/schema';

export const fallbackVertexExpansionState = (kind: VertexKind): VertexExpansionState =>
  kind === 'Evidence' ? 'NotApplicable' : 'Pending';

export const vertexExpansionStateLabel: Record<VertexExpansionState, string> = {
  Pending: '○ 待展开',
  Expanding: '⟳ 展开中',
  AwaitingContext: '⌛ 等待资料',
  Expanded: '✓ 已展开',
  Blocked: '! 展开受阻',
  NotApplicable: '不适用',
};

/** Avoid visual noise on Evidence nodes, which have no reverse-expansion lifecycle. */
export const vertexExpansionCanvasLabel = (state: VertexExpansionState): string =>
  state === 'NotApplicable' ? '' : vertexExpansionStateLabel[state];
