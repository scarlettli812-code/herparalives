import "server-only";
import { z } from "zod";
import type {
  ChoiceRecord,
  StoryBible,
  StoryCallback,
  StoryEvent,
  StoryNode,
  StoryState,
} from "@/lib/types";
import { chatJSON } from "@/server/llm";
import { evidenceAppearsInStory } from "@/server/state-validator";

type RouteOption = {
  choiceId: string;
  label: string;
  memory: string;
  immediateOutcome: string;
  resultingFacts: string[];
  expectedConsequence: string;
};

export type RouteDecision = {
  sourceChapter: number;
  sourceNodeId: string;
  selected: RouteOption & { eventId?: string };
  unselected: RouteOption[];
};

export type RouteContract = {
  decisions: RouteDecision[];
};

const compact = (value: string | undefined, max = 500) => (value ?? "")
  .replace(/\s+/g, " ")
  .trim()
  .slice(0, max);

function routeOption(
  choice: NonNullable<StoryNode["choices"]>[number] | undefined,
  record?: ChoiceRecord,
): RouteOption {
  const effects = record?.effects ?? choice?.effects ?? [];
  return {
    choiceId: record?.choiceId ?? choice?.id ?? "unknown",
    label: compact(record?.choiceLabel ?? choice?.label, 80),
    memory: compact(record?.memory ?? choice?.memory, 160),
    immediateOutcome: compact(choice?.outcome, 700),
    resultingFacts: effects.map((effect) => `${effect.domain}：${compact(effect.to, 180)}`),
    expectedConsequence: compact(record?.expectedConsequence ?? choice?.expectedConsequence, 240),
  };
}

/**
 * Turns the choices the player actually made into a route contract. Selected
 * outcomes are canon; sibling options are counterfactual and must never be
 * narrated as if they happened. This is deliberately derived on the server so
 * the model does not get to decide which branch the player chose.
 */
export function buildRouteContract(records: ChoiceRecord[], nodes: StoryNode[]): RouteContract {
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  return {
    decisions: records.map((record) => {
      const node = nodesById.get(record.nodeId);
      const selectedChoice = node?.choices?.find((choice) => choice.id === record.choiceId);
      return {
        sourceChapter: record.sourceChapter ?? node?.chapter ?? 0,
        sourceNodeId: record.nodeId,
        selected: { ...routeOption(selectedChoice, record), eventId: record.eventId },
        unselected: (node?.choices ?? [])
          .filter((choice) => choice.id !== record.choiceId)
          .map((choice) => routeOption(choice)),
      };
    }),
  };
}

const auditSchema = z.object({
  eventChecks: z.array(z.object({
    eventId: z.string().min(1),
    status: z.enum(["realized", "deferred", "missing", "contradicted"]),
    evidence: z.string().max(300).default(""),
    reason: z.string().min(1).max(300),
  }).strict()).max(12),
  routeViolations: z.array(z.object({
    type: z.enum(["unchosen_branch", "selected_fact_conflict", "state_conflict", "unexplained_reversal"]),
    evidence: z.string().min(4).max(300),
    reason: z.string().min(1).max(300),
  }).strict()).max(8),
  choiceDepth: z.enum(["substantive", "shallow"]),
  progressionNote: z.string().min(1).max(300),
}).strict();

export type NarrativeContinuityAudit = {
  available: boolean;
  callbacks: StoryCallback[];
  hardFailures: string[];
  softWarnings: string[];
};

type AuditInput = {
  story: StoryNode[];
  routeContract: RouteContract;
  storyBible: StoryBible;
  storyState: StoryState;
  eventLedger: StoryEvent[];
  targetChapter: number;
  latestEventId?: string;
};

const AUDIT_SYSTEM = [
  "你是互动叙事的连续性审校员。你只判断新章节是否沿着玩家真实选择继续，不评价玩家的选择好坏，也不做心理诊断。",
  "硬错误只有四类：正文把未选择的路线写成已经发生；正文否定已选择后成立的事实；正文与当前职业/经济/关系/自主状态冲突；人物改变方向却没有写出触发原因、新决定和现实过渡。",
  "玩家可以在后文改变主意，但必须有明确的新信息、行动和代价；这不等于上一章未选择的结果曾经发生。",
  "措辞不同、同义改写、只是在考虑另一条路，都不是错误。不要因为 callbacks 或句子格式不同判错。",
  "逐项检查 pending 事件：realized 表示后果已通过行动、对话、资源或关系变化真实发生；deferred 表示正文明确承接了选择并说明后果为何稍后出现；missing 表示完全没有承接；contradicted 表示写成了相反事实。",
  "所有 evidence 必须从本章正文、dialogue、coach 或 outcome 原样复制。无法原样引用时留空，不得编造证据。",
  "choiceDepth 只评价本章选择是否涉及方向、代价、边界、关系或价值排序；浅层选择属于软问题，不算路线硬错误。",
  "只输出 JSON。",
].join("\n");

/**
 * A short semantic audit checks the story facts rather than brittle callback
 * formatting. If the audit service itself is unavailable, it fails open: a
 * valid generated chapter is never discarded because a second model timed out.
 */
export async function auditNarrativeContinuity(input: AuditInput): Promise<NarrativeContinuityAudit> {
  const pending = input.eventLedger.filter((event) => event.status === "pending");
  const user = [
    "【因果审校任务】",
    `目标章节：${input.targetChapter}`,
    `最近一次选择事件：${input.latestEventId ?? "（无）"}`,
    "",
    "玩家路线合同（selected 已发生；unselected 没有发生）：",
    JSON.stringify(input.routeContract, null, 2),
    "",
    "当前 Story State：",
    JSON.stringify(input.storyState, null, 2),
    "",
    "Story Bible 不可改写事实：",
    JSON.stringify({ characters: input.storyBible.characters, invariants: input.storyBible.invariants }, null, 2),
    "",
    "待兑现事件：",
    JSON.stringify(pending, null, 2),
    "",
    "需要检查的新章节：",
    JSON.stringify(input.story, null, 2),
    "",
    "输出：{\"eventChecks\":[...],\"routeViolations\":[...],\"choiceDepth\":\"substantive|shallow\",\"progressionNote\":\"...\"}",
  ].join("\n");
  const result = await chatJSON(AUDIT_SYSTEM, user, {
    temperature: 0.1,
    maxTokens: 1800,
    timeoutMs: 22_000,
    maxAttempts: 1,
    enableThinking: false,
    schema: auditSchema,
  });
  if (!result.ok) {
    console.error(`[continuity-audit] unavailable: ${result.error.code}`);
    return { available: false, callbacks: [], hardFailures: [], softWarnings: [] };
  }

  const pendingById = new Map(pending.map((event) => [event.id, event]));
  const checksById = new Map(result.data.eventChecks
    .filter((check) => pendingById.has(check.eventId))
    .map((check) => [check.eventId, check]));
  const callbacks: StoryCallback[] = [];
  const hardFailures: string[] = [];
  const softWarnings: string[] = [];

  for (const check of checksById.values()) {
    const evidenceIsReal = Boolean(check.evidence) && evidenceAppearsInStory(input.story, check.evidence);
    if (check.status === "realized" && evidenceIsReal) {
      callbacks.push({ eventId: check.eventId, evidence: check.evidence });
    }
    if (check.status === "contradicted" && evidenceIsReal) {
      hardFailures.push(`已选路线被正文否定：${check.reason}`);
    }
  }

  for (const violation of result.data.routeViolations) {
    if (evidenceAppearsInStory(input.story, violation.evidence)) {
      hardFailures.push(`路线串线：${violation.reason}`);
    }
  }

  for (const event of pending.filter((item) => item.dueByChapter <= input.targetChapter)) {
    const check = checksById.get(event.id);
    if (!check) {
      softWarnings.push(`语义审校未覆盖到期事件：「${event.choiceLabel}」`);
    } else if (check.status === "missing" || check.status === "deferred") {
      hardFailures.push(`到期选择没有产生现实后果：「${event.choiceLabel}」`);
    } else if (check.status === "realized" && !evidenceAppearsInStory(input.story, check.evidence)) {
      softWarnings.push(`到期事件的审校证据无法自动定位：「${event.choiceLabel}」`);
    }
  }

  if (input.latestEventId && pendingById.has(input.latestEventId)) {
    const latest = checksById.get(input.latestEventId);
    if (latest?.status === "missing") {
      hardFailures.push("新章节没有承接玩家刚刚做出的选择");
    } else if (!latest) {
      softWarnings.push("语义审校未覆盖最近一次选择");
    } else if ((latest.status === "realized" || latest.status === "deferred")
      && !evidenceAppearsInStory(input.story, latest.evidence)) {
      softWarnings.push("最近一次选择的审校证据无法自动定位");
    }
  }

  if (result.data.choiceDepth === "shallow") {
    softWarnings.push(`本章选择深度不足：${result.data.progressionNote}`);
  }
  return {
    available: true,
    callbacks,
    hardFailures: [...new Set(hardFailures)],
    softWarnings,
  };
}
