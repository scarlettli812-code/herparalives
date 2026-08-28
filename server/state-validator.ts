import "server-only";
import type { StoryCallback, StoryEvent, StoryNode } from "@/lib/types";

export type ContinuityValidation =
  | { ok: true; callbackEventIds: string[] }
  | { ok: false; errors: string[] };

function storyText(nodes: StoryNode[]): string {
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

function evidenceAppearsInText(text: string, evidence: string): boolean {
  if (text.includes(evidence)) return true;
  const normalizedEvidence = normalizeEvidenceText(evidence);
  return normalizedEvidence.length >= 4 && normalizeEvidenceText(text).includes(normalizedEvidence);
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
 * to a literal sentence so the hard continuity validator still checks real text.
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
 * Deterministic guardrail for generated chapters. The model must cite literal
 * evidence from its own prose, and overdue events cannot silently disappear.
 */
export function validateChapterContinuity(input: {
  story: StoryNode[];
  callbacks: StoryCallback[];
  eventLedger: StoryEvent[];
  targetChapter: number;
}): ContinuityValidation {
  const errors: string[] = [];
  const pending = input.eventLedger.filter((event) => event.status === "pending");
  const pendingById = new Map(pending.map((event) => [event.id, event]));
  const callbackIds = new Set<string>();
  const generatedText = storyText(input.story);

  for (const callback of input.callbacks) {
    if (callbackIds.has(callback.eventId)) errors.push(`重复兑现事件：${callback.eventId}`);
    callbackIds.add(callback.eventId);
    if (!pendingById.has(callback.eventId)) errors.push(`兑现了不存在或已结束的事件：${callback.eventId}`);
    if (!evidenceAppearsInText(generatedText, callback.evidence)) errors.push(`兑现证据未出现在故事正文：${callback.eventId}`);
  }

  if (pending.length && input.callbacks.length === 0) {
    errors.push("存在待兑现事件，但本章没有 callbacks");
  }
  for (const event of pending.filter((item) => item.dueByChapter <= input.targetChapter)) {
    if (!callbackIds.has(event.id)) errors.push(`逾期事件未兑现：${event.id}`);
  }

  return errors.length ? { ok: false, errors } : { ok: true, callbackEventIds: [...callbackIds] };
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
