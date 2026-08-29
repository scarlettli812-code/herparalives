import "server-only";
import type { StoryCallback, StoryEvent, StoryNode } from "@/lib/types";

export function storyText(nodes: StoryNode[]): string {
  return nodes.flatMap((node) => [
    node.scene,
    node.dialogue ?? "",
    node.coach ?? "",
    ...(node.choices ?? []).map((choice) => choice.outcome),
  ]).join("\n");
}

const normalizeEvidenceText = (value: string) => value
  .normalize("NFKC")
  .replace(/[\p{P}\p{S}\s]+/gu, "")
  .toLowerCase();

export function evidenceAppearsInText(text: string, evidence: string): boolean {
  if (evidence.trim().length < 4) return false;
  if (text.includes(evidence)) return true;
  const normalizedEvidence = normalizeEvidenceText(evidence);
  return normalizedEvidence.length >= 4 && normalizeEvidenceText(text).includes(normalizedEvidence);
}

export function evidenceAppearsInStory(nodes: StoryNode[], evidence: string): boolean {
  return evidenceAppearsInText(storyText(nodes), evidence);
}

function evidenceSegments(nodes: StoryNode[]): string[] {
  const fields = nodes.flatMap((node) => [
    node.scene,
    node.dialogue ?? "",
    node.coach ?? "",
    ...(node.choices ?? []).map((choice) => choice.outcome),
  ]);
  return fields.flatMap((field) => field.match(/[^。！？!?]+[。！？!?]?/gu) ?? [])
    .map((segment) => segment.trim())
    .filter((segment) => segment.length >= 4 && segment.length <= 300);
}

function bigrams(value: string): Set<string> {
  const normalized = normalizeEvidenceText(value);
  const pairs = new Set<string>();
  for (let index = 0; index < normalized.length - 1; index += 1) {
    pairs.add(normalized.slice(index, index + 2));
  }
  return pairs;
}

function evidenceSimilarity(left: string, right: string): number {
  const a = bigrams(left);
  const b = bigrams(right);
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const pair of a) if (b.has(pair)) shared += 1;
  return shared / Math.min(a.size, b.size);
}

/**
 * Qwen may copy a genuine prose excerpt with different quote marks/spacing, or
 * lightly paraphrase the same sentence. Align only high-confidence matches back
 * to a literal sentence so event bookkeeping can cite the real generated prose.
 */
export function alignCallbackEvidence(nodes: StoryNode[], callbacks: StoryCallback[]): StoryCallback[] {
  const generatedText = storyText(nodes);
  const segments = evidenceSegments(nodes);
  return callbacks.map((callback) => {
    if (evidenceAppearsInText(generatedText, callback.evidence)) return callback;
    const ranked = segments
      .map((segment) => ({ segment, score: evidenceSimilarity(callback.evidence, segment) }))
      .sort((left, right) => right.score - left.score);
    return (ranked[0]?.score ?? 0) >= 0.62
      ? { ...callback, evidence: ranked[0].segment }
      : callback;
  });
}

/**
 * Model callback metadata is advisory. Keep only known event IDs backed by a
 * literal sentence, but never reject a complete chapter because the model
 * paraphrased or malformed this technical bookkeeping field.
 */
export function sanitizeCallbacks(
  nodes: StoryNode[],
  callbacks: StoryCallback[],
  eventLedger: StoryEvent[],
): StoryCallback[] {
  const pendingIds = new Set(eventLedger.filter((event) => event.status === "pending").map((event) => event.id));
  const seen = new Set<string>();
  return alignCallbackEvidence(nodes, callbacks).filter((callback) => {
    if (!pendingIds.has(callback.eventId) || seen.has(callback.eventId)) return false;
    if (!evidenceAppearsInStory(nodes, callback.evidence)) return false;
    seen.add(callback.eventId);
    return true;
  });
}

export function attachCallbackIds(nodes: StoryNode[], callbacks: StoryCallback[]): StoryNode[] {
  return nodes.map((node) => {
    const nodeText = [
      node.scene,
      node.dialogue ?? "",
      node.coach ?? "",
      ...(node.choices ?? []).map((choice) => choice.outcome),
    ].join("\n");
    const eventIds = callbacks
      .filter((callback) => evidenceAppearsInText(nodeText, callback.evidence))
      .map((callback) => callback.eventId);
    return eventIds.length ? { ...node, causedByEventIds: eventIds } : node;
  });
}
