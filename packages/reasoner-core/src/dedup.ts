import { createHash } from 'node:crypto';
import type { FormulaId } from '@reasoner/schema';

/**
 * Canonical JSON: object keys sorted recursively, undefined dropped. Two values
 * that differ only in key order must serialise identically, otherwise context
 * hashes would not be reproducible across processes.
 */
export const canonicalJson = (value: unknown): string => {
  const walk = (input: unknown): unknown => {
    if (input === null || typeof input !== 'object') return input;
    if (Array.isArray(input)) return input.map(walk);
    const source = input as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      const child = source[key];
      if (child === undefined) continue;
      result[key] = walk(child);
    }
    return result;
  };
  return JSON.stringify(walk(value));
};

export const sha256Hex = (input: string): string =>
  createHash('sha256').update(input, 'utf8').digest('hex');

export const hashCanonical = (value: unknown): string => sha256Hex(canonicalJson(value));

/**
 * Normalises free text before it takes part in a dedupe key: trimmed, collapsed
 * whitespace, case-folded. Prevents cosmetic edits from creating duplicates.
 */
export const normalizeText = (input: string): string =>
  input.trim().replace(/\s+/g, ' ').toLowerCase();

/**
 * Dedupe key for a vertex. An explicit caller-supplied key always wins; the
 * fallback derives from kind + normalised label so the same assertion submitted
 * twice reuses one vertex.
 */
export const vertexDedupeKey = (
  kind: string,
  label: string,
  explicit: string | undefined,
): string => (explicit !== undefined ? `k:${explicit}` : `d:${kind}:${normalizeText(label)}`);

/**
 * Dedupe key for an inference edge. Neither premise nor conclusion order may
 * matter — {a,b} and {b,a} are the same set — so both sides are sorted first.
 */
export const edgeDedupeKey = (
  sourceVertexIds: readonly string[],
  targetVertexIds: readonly string[],
  label: string,
  explicit: string | undefined,
): string => {
  if (explicit !== undefined) return `k:${explicit}`;
  const sources = [...sourceVertexIds].sort().join('|');
  const targets = [...targetVertexIds].sort().join('|');
  return `d:${sources}=>${targets}:${normalizeText(label)}`;
};

/**
 * A caller-supplied key used for a batch proposal must still identify each
 * independent source->target relation. Hashing keeps the persisted key short
 * even when the caller key and opaque ids are long.
 */
export const expandedEdgeDedupeKey = (
  sourceVertexId: string,
  targetVertexId: string,
  label: string,
  explicit: string | undefined,
  expandsMultipleEdges: boolean,
): string => {
  if (explicit === undefined || !expandsMultipleEdges) {
    return edgeDedupeKey([sourceVertexId], [targetVertexId], label, explicit);
  }
  return `k:${sha256Hex(
    canonicalJson({ explicit, sourceVertexId, targetVertexId }),
  )}`;
};

/**
 * Stable identity for one target's AND formula. Physical edges retain their
 * own identities; this value only preserves the formula they jointly express.
 */
export const inferenceFormulaId = (
  sourceVertexIds: readonly string[],
  targetVertexId: string,
  label: string,
  explicit: string | undefined,
): FormulaId =>
  `formula:${hashCanonical({
    sourceVertexIds: [...new Set(sourceVertexIds)].sort(),
    targetVertexId,
    label: normalizeText(label),
    explicit: explicit ?? null,
  })}` as FormulaId;

export const evidenceQuestionDedupeKey = (prompt: string): string => normalizeText(prompt);
