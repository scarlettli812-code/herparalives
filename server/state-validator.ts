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
    if (!generatedText.includes(callback.evidence)) errors.push(`兑现证据未出现在故事正文：${callback.eventId}`);
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
      .filter((callback) => nodeText.includes(callback.evidence))
      .map((callback) => callback.eventId);
    return eventIds.length ? { ...node, causedByEventIds: eventIds } : node;
  });
}
