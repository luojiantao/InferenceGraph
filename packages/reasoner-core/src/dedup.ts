import { createHash } from 'node:crypto';

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

export const evidenceQuestionDedupeKey = (prompt: string): string => normalizeText(prompt);
