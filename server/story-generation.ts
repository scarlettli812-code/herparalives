import "server-only";
import { z } from "zod";
import type { RouteContract } from "@/server/route-continuity";
import type {
  CharacterCard,
  ChoiceRecord,
  StoryBible,
  StoryEvent,
  StoryNode,
  StoryPreferences,
  StoryPlan,
  StoryState,
} from "@/lib/types";
import { STORY_EDITOR_PROMPT } from "@/server/story-editor-prompt";

// Prompt builders, zod schemas and node-id rewriting for LLM story generation.
// Schemas are strict so that a single malformed field falls back cleanly instead
// of producing a broken chapter at runtime.

export const STAT_KEYS = ["career", "wisdom", "happiness", "relationship", "courage"] as const;

const EMPTY_DELTAS = {} as Record<(typeof STAT_KEYS)[number], number>;
// qwen occasionally serializes score deltas as numeric strings and mixes the
// narrative domains (economy/selfFulfillment) into this UI-only score object.
// Keep the causal effects strict, but normalize this non-authoritative display
// metadata so a complete, valid chapter is not discarded for "1" vs 1.
function normalizeDeltas(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return EMPTY_DELTAS;
  const source = value as Record<string, unknown>;
  return Object.fromEntries(STAT_KEYS.flatMap((key) => {
    const raw = source[key];
    if (raw === null || raw === undefined || raw === "") return [];
    const parsed = typeof raw === "number" ? raw : Number(raw);
    if (!Number.isFinite(parsed)) return [];
    return [[key, Math.max(-3, Math.min(3, Math.round(parsed)))]];
  }));
}

// qwen-family models emit JSON null for absent optional fields, so optional
// fields must be nullish (accept null) and normalized to undefined for the TS types.
const nullable = <T extends z.ZodType>(schema: T) => schema.nullish().transform((v) => v ?? undefined);
const deltasSchema = z
  .preprocess(normalizeDeltas, z.partialRecord(z.enum(STAT_KEYS), z.number().int().min(-3).max(3)))
  .default(EMPTY_DELTAS);

function normalizeCallbackEvidence(value: unknown): unknown {
  let evidence = value;
  if (Array.isArray(evidence)) {
    evidence = evidence
      .map((item) => normalizeCallbackEvidence(item))
      .find((item) => typeof item === "string");
  } else if (evidence && typeof evidence === "object") {
    const record = evidence as Record<string, unknown>;
    evidence = normalizeCallbackEvidence(record.evidence ?? record.quote ?? record.text);
  }
  if (typeof evidence !== "string") return evidence;
  // The continuity validator still requires this exact excerpt to exist in the
  // generated prose. The wider cap prevents an arbitrary length overrun from
  // throwing away the whole chapter while bounding what is stored in the ledger.
  return evidence.trim().slice(0, 300);
}

const storyDomainSchema = z.enum(["career", "economy", "relationship", "selfFulfillment"]);
const storyEffectSchema = z.object({
  domain: storyDomainSchema,
  from: nullable(z.string().min(2).max(100)),
  to: z.string().min(2).max(100),
  consequence: z.string().min(4).max(120),
}).strict();

const choiceSchema = z.object({
  id: z.string().min(1),
  // Caps are deliberately loose: a single field a couple chars over the target
  // (e.g. a 31-char label) used to reject a fully-billed ~170s response and force
  // a second full generation — the cap is quality guidance, not a hard gate.
  label: z.string().min(2).max(36),
  hint: z.string().min(4).max(48),
  gain: z.string().min(4).max(48),
  cost: z.string().min(4).max(48),
  unknown: z.string().min(4).max(48),
  outcome: z.string().min(100).max(1500),
  deltas: deltasSchema,
  memory: z.string().min(4).max(60),
  effects: z.array(storyEffectSchema).min(2).max(3),
  pathType: z.enum(["local", "branch", "delay", "exit", "evidence"]),
  expectedConsequence: z.string().min(8).max(120),
  consequenceDueInChapters: z.number().int().min(1).max(3),
  nextNodeId: nullable(z.string()),
  endsStory: nullable(z.boolean()),
});

export const nodeSchema = z
  .object({
    id: z.string().min(1),
    chapter: z.number().int().min(1).max(20),
    chapterTitle: z.string().min(2).max(30),
    title: z.string().min(2).max(30),
    scene: z.string().min(200).max(3000),
    dialogue: nullable(z.string()),
    coach: nullable(z.string().min(1).max(500)),
    chapterEnd: nullable(z.boolean()),
    causedByEventIds: nullable(z.array(z.string().min(1)).max(6)),
    // Choices belong to decision nodes only — pure narration nodes omit the key
    // entirely. Models occasionally emit 2 choices instead of 3 — accept it
    // rather than rejecting a whole run (the UI renders any count).
    choices: nullable(z.array(choiceSchema).min(2).max(3)),
  })
  .strict()
  .refine((node) => !node.chapterEnd || (node.coach?.length ?? 0) >= 20, {
    message: "chapter-ending nodes need a coach of at least 20 characters",
  });

export const planItemSchema = z.object({
  chapter: z.number().int().min(1),
  title: z.string().min(2).max(30),
  synopsis: z.string().min(20).max(160),
});

export const CHARACTER_CARD_SCHEMA = z.object({
  name: z.string().min(1).max(12),
  background: z.string().min(20).max(200),
  dilemma: z.string().min(8).max(80),
  goal: z.string().min(8).max(80),
  resources: z.array(z.string().min(2).max(30)).min(2).max(5),
});

// Every generated chapter must contain at least one decision node — a chapter
// with zero choices would leave the player reading with nothing to decide.
const hasDecisionNode = (value: { nodes?: Array<{ choices?: unknown[] }>; story?: Array<{ choices?: unknown[] }> }) => {
  const list = value.nodes ?? value.story;
  return (list ?? []).some((node) => (node.choices?.length ?? 0) >= 2);
};

export const SEASON_RESULT_SCHEMA = z
  .object({
    plan: z.object({ chapters: z.literal(5), items: z.array(planItemSchema).length(5) }),
    nodes: z.array(nodeSchema).min(1).max(2),
  })
  .refine((value) => value.nodes.every((node) => node.chapter === 1), {
    message: "season generation must only contain chapter-1 nodes",
  })
  .refine(hasDecisionNode, { message: "season chapter 1 must include a decision node" });

export const CHAPTER_RESULT_SCHEMA = z
  .object({
    story: z.array(nodeSchema).min(2).max(3),
    callbacks: z.array(z.object({
      eventId: z.string().min(1),
      evidence: z.preprocess(normalizeCallbackEvidence, z.string().min(4).max(300)),
    }).strict()).max(6),
  })
  .refine(hasDecisionNode, { message: "each chapter must include a decision node" });

export type CharacterCardInput = {
  name: string;
  situation: string;
  preferences: StoryPreferences;
};

export function buildCharacterCardPrompt(card: CharacterCardInput): { system: string; user: string } {
  const system = [
    `你是《她的平行人生》的角色策划。用户的输入是她本人的现实处境，你必须在完全脱敏的前提下把它改编为一位虚构女性角色的角色卡。`,
    `【脱敏规则】删除姓名、住址、公司名、学校名、具体金额等可识别信息，只保留处境类型与情感结构；不得对用户做心理诊断。`,
    `【命名规则】只有用户明确未提供名字时才自拟一个中文名（2—4字）；否则必须原样保留用户提供的名字。`,
    `【输出规则】只输出 JSON，不要任何其他文字。字段：`,
    `  "name": 角色名(字符串，4字以内)`,
    `  "background": 60—120字，处境与背景的脱敏改编`,
    `  "dilemma": 20—50字，核心困境`,
    `  "goal": 20—50字，角色真正想实现的目标`,
    `  "resources": 数组，3—4 项，每项 4—12 字的可用资源`,
  ].join("\n");
  const user = [
    `用户的处境原文：\n${card.situation}`,
    `用户提供的名字：${card.name || "（未提供）"}`,
    `风格偏好（1—5）：难度 ${card.preferences.difficulty} / 冲突 ${card.preferences.conflict} / 戏剧 ${card.preferences.drama} / 现实 ${card.preferences.realism}`,
    `请只输出 JSON。`,
  ].join("\n");
  return { system, user };
}

// Concrete format examples — qwen-family models follow a literal JSON example far
// more reliably than a prose schema description (observed: without one they collapse
// objects into "chapter: 1, title: …" strings and leak narrative section names like
// 人物互动 / 冲突升级 into keys). Content is placeholder; structure is exact.
const EXAMPLE_PLAN_ITEMS = `[
      { "chapter": 1, "title": "失业的起点", "synopsis": "（第1章冲突与走向，40—80字）" },
      { "chapter": 2, "title": "（第2章标题）", "synopsis": "（第2章冲突与走向，40—80字）" },
      { "chapter": 3, "title": "（第3章标题）", "synopsis": "（第3章冲突与走向，40—80字）" },
      { "chapter": 4, "title": "（第4章标题）", "synopsis": "（第4章冲突与走向，40—80字）" },
      { "chapter": 5, "title": "（第5章标题）", "synopsis": "（第5章冲突与走向，40—80字）" }
    ]`;

const EXAMPLE_NODE = `{
    "id": "n1",
    "chapter": 1,
    "chapterTitle": "失业的起点",
    "title": "清晨的焦虑",
    "scene": "（节点正文：350—800字、3—5个自然段的完整场景。先写清时间、地点与人物正在做的事，再写一段有个性的对话或互动，最后写两种真实需求相撞的冲突，把选择推到玩家面前。JSON字符串用\\n\\n分段，不写小标题，禁止写80—150字的剧情摘要。）",
    "dialogue": "（可选字段：一句有个性的台词）",
    "coach": "（可选字段：Life Coach 镜面回话，仅章末节点出现，20字以上）",
    "chapterEnd": false,
    "choices": [
      {
        "id": "c1",
        "label": "（选项标签，2—36字）",
        "hint": "（该选项的即时线索，4—48字）",
        "gain": "（选择后可能获得的东西，4—48字）",
        "cost": "（选择后需要付出的代价，4—48字）",
        "unknown": "（未说破的不确定因素，4—48字）",
        "outcome": "（选后剧情：180—450字、2—3个自然段的完整故事，JSON字符串用\\n\\n分段，写清行动、回应、代价与下一幕悬念，禁止一两句带过）",
        "deltas": { "career": 1, "happiness": -1 },
        "memory": "（这一选择值得被记住的一句话，4—60字）",
        "effects": [
          { "domain": "career", "from": "（选择前职业状态）", "to": "（选择后职业状态）", "consequence": "（后续可被场景明确呈现的职业后果）" },
          { "domain": "selfFulfillment", "from": "（选择前自主感）", "to": "（选择后自主感）", "consequence": "（后续可被场景明确呈现的自我满足后果）" }
        ],
        "pathType": "branch",
        "expectedConsequence": "（未来1—3章内必须明确出现的可观察后果）",
        "consequenceDueInChapters": 1
      },
      { "id": "c2", "label": "…", "hint": "…", "gain": "…", "cost": "…", "unknown": "…", "outcome": "…", "deltas": { }, "memory": "…", "effects": [ { "domain": "economy", "to": "…", "consequence": "…" }, { "domain": "relationship", "to": "…", "consequence": "…" } ], "pathType": "delay", "expectedConsequence": "…", "consequenceDueInChapters": 2 },
      { "id": "c3", "label": "…", "hint": "…", "gain": "…", "cost": "…", "unknown": "…", "outcome": "…", "deltas": { }, "memory": "…", "effects": [ { "domain": "career", "to": "…", "consequence": "…" }, { "domain": "relationship", "to": "…", "consequence": "…" } ], "pathType": "exit", "expectedConsequence": "…", "consequenceDueInChapters": 1 }
    ]
  }`;

// A pure narration node: advances scene and emotion without offering choices.
const EXAMPLE_PLAIN_NODE = `{
    "id": "n1",
    "chapter": 1,
    "chapterTitle": "失业的起点",
    "title": "清晨的焦虑",
    "scene": "（节点正文：350—800字、3—5个自然段的完整场景。先写清时间、地点与人物正在做的事，再写一段有个性的对话或互动，最后写两种真实需求相撞的冲突。这是纯叙事节点：不提供选项，让事件自然发生、情绪真实推进。JSON字符串用\\n\\n分段，不写小标题，禁止写80—150字的剧情摘要。）",
    "dialogue": "（可选字段：一句有个性的台词）",
    "chapterEnd": false
  }`;

// The first response must become playable well inside a serverless request.
// Later chapters still use the full two-to-three-node editorial format.
const EXAMPLE_SEASON_NODE = EXAMPLE_NODE
  .replace("350—800字完整场景", "300—500字完整场景")
  .replace("180—450字完整故事", "120—220字完整故事")
  .replace('"chapterEnd": false', '"chapterEnd": true');

const SEASON_TASK = [
  `【本次任务】根据角色卡与风格约束，设计一季 5 章的简要大纲，并写出第一章一个可立即游玩的关键抉择场景。后续场景将在玩家选择后继续生成。`,
  `【输出规则】只输出 JSON，不要任何其他文字。顶层只允许两个键："plan" 与 "nodes"，禁止添加任何其他键。严格按下面的格式示例输出——示例中的"（…）"占位文字只是说明，实际内容必须完整真实。`,
  `{`,
  `  "plan": { "chapters": 5, "items": ${EXAMPLE_PLAN_ITEMS} },`,
  `  "nodes": [ ${EXAMPLE_SEASON_NODE} ]`,
  `}`,
  `【首章低延迟规则】nodes 必须恰好 1 个抉择节点，带 2—3 个真正改变方向、代价、关系或价值取舍的选项；禁止在先做哪件事、买不买东西、回不回消息等无关细节上设置选择。`,
  `【五次选择路径】第一章是“本能与核心冲突”：选项要让玩家第一次暴露她更想保护什么。整季后续依次走向边界表达、代价落地、受挫修正和现实承诺；五章不能重复询问同一个问题。`,
  `【选项中立】每个选项都必须有真实获得、现实代价与尚未确定的部分，不得设置明显正确答案、道德高地或纯粹逃避项。选项代表不同价值排序，不代表好坏。`,
  `【类型铁律】每个值必须保持自己的类型：plan.items 的每一项必须是对象；deltas 必须是对象；scene、outcome、label 等必须是字符串。严禁把对象或数组压缩成 "chapter: 1, title: …" 这样的字符串。节点对象只允许示例中的键，禁止把"场景建立""人物互动""冲突升级"等叙事分节名称当作 JSON 键。`,
  `【节点规则】唯一节点的 chapter 必须为 1、chapterEnd 必须为 true，并带 20 字以上的 coach；所有选项禁止出现 nextNodeId 字段；deltas 使用 career / wisdom / happiness / relationship / courage 五个键，值为 -3 到 3 的整数，未变化的维度可省略。`,
  `【因果规则】每个选项必须绑定 2—3 个 effects，domain 只能是 career / economy / relationship / selfFulfillment；同时给出 pathType、expectedConsequence 和 1—3 章内兑现期限。effects.to 必须写成选择后已经成立的具体状态，consequence 必须能在后续场景中被角色行动、对话或资源变化明确证明。`,
  `【正文要求】首章 scene 写 300—500 字、分成 3—5 个自然段；每个 outcome 写 120—220 字、分成 2—3 个自然段。按场景建立、人物互动和冲突推进自然换段，不写分节小标题；JSON 字符串内用 \\n\\n 表示段落。禁止缩写或提纲式输出。后续章节恢复完整叙事密度。`,
].join("\n");

export function buildSeasonPrompt(
  character: Pick<CharacterCard, "name" | "background" | "goal" | "dilemma" | "resources">,
  constraints: string[],
): { system: string; user: string } {
  const system = `${STORY_EDITOR_PROMPT}\n\n${SEASON_TASK}`;
  const user = [
    `角色卡：`,
    `- 名字：${character.name}`,
    `- 背景：${character.background}`,
    `- 困境：${character.dilemma}`,
    `- 目标：${character.goal}`,
    `- 资源：${character.resources.join("、")}`,
    ``,
    `风格约束（必须体现在叙事中）：`,
    ...constraints.map((constraint, index) => `${index + 1}. ${constraint}`),
    ``,
    `请只输出 JSON。`,
  ].join("\n");
  return { system, user };
}

export type ChapterInput = {
  character: Pick<CharacterCard, "name" | "background" | "goal" | "dilemma" | "resources">;
  constraints: string[];
  plan: StoryPlan;
  targetChapter: number;
  memorySummary: string;
  storyBible: StoryBible;
  storyState: StoryState;
  eventLedger: StoryEvent[];
  routeContract: RouteContract;
  lastNode: StoryNode;
  lastChoice: Pick<ChoiceRecord, "choiceLabel" | "memory">;
  lastOutcome: string;
};

export function buildChapterPrompt(input: ChapterInput): { system: string; user: string } {
  const isFinal = input.targetChapter === input.plan.chapters;
  const decisionStage = ({
    2: "边界表达：她怎样向重要的人说明需求、限制与责任",
    3: "代价落地：当时间、金钱、关系或机会成本真的出现，她还愿意承担什么",
    4: "受挫修正：现实不如预期时，她怎样调整而不偷偷否定之前的选择",
    5: "现实承诺：没有完美答案时，她最终愿意保护什么并承担什么",
  } as Record<number, string>)[input.targetChapter] ?? "继续深化价值取舍";
  const system = [
    STORY_EDITOR_PROMPT,
    ``,
    `【本次任务】为已进行到第 ${input.targetChapter - 1} 章的《她的平行人生》续写第 ${input.targetChapter} 章（整季共 ${input.plan.chapters} 章）。本季故事大纲与已发生事件将在用户消息中给出。`,
    `【承接规则】`,
    `1. 用户消息中的“玩家路线合同”是最高优先级事实：selected 已经发生，必须保留其行动、即时结果和新状态；unselected 从未发生，严禁把其行动或结果写成历史。Story Bible、当前 Story State、因果事件账本和已发生事件同样不可改写。`,
    `2. 人物以后可以改变主意，但必须完整写出新信息或压力如何出现、人物怎样重新决定、改变带来什么代价。不得用一句话跳过过程，更不能把上一章未选择的路线倒写成已经发生。`,
    `3. 开头必须自然衔接上一章结尾和玩家刚做出的选择。承接不是复述记忆，而是让选择通过行动、对话、时间、金钱、关系或资源变化进入生活。`,
    `4. 本章承担五次选择路径中的“${decisionStage}”。新选择必须比上一章更深入，推动玩家继续辨认价值排序、边界、恐惧和愿意承担的代价，不能换皮重复上一题。`,
    `5. 节点类型：本章输出 2—3 个节点，构成完整章节弧线，其中纯叙事节点（没有 choices 字段，只推进场景与情绪）与抉择节点（带 2—3 个选项）混合，每章必须至少包含 1 个抉择节点；每个选项都必须同时有真实获得、现实代价和不确定性，不得设置明显正确答案。最后一个节点 chapterEnd 必须为 true 且带 20 字以上的 coach；若它带选项，其全部选项禁止出现 nextNodeId。`,
    isFinal
      ? `6. 本章是第 ${input.plan.chapters} 章（最终章）：所有选项禁止出现 nextNodeId；若最后一个节点带选项，其全部选项必须带 "endsStory": true。coach 必须基于五次实际选择，指出核心冲突、反复模式、价值排序、可能的盲点和一个可执行的小步骤；不得输出“勇敢做自己”等空泛建议。`
      : `6. 本章不是最终章：所有选项禁止出现 endsStory 字段。`,
    `7. 因果兑现：事件账本中 status=pending 的选择不能被忽略。到期事件必须通过角色行动、对话、资源或关系变化产生现实后果，不能只复述“人物记得”。把已经真实发生的后果写入 callbacks；eventId 原样复制，evidence 尽量从本章正文或 outcome 原样复制。evidence 的格式错误由服务端修复，不得为凑证据编造剧情。`,
    `8. 输出格式：只输出 JSON，顶层只允许 "story" 与 "callbacks" 两个键，禁止添加其他键。严格按下面的格式示例输出（示例中的"（…）"占位文字只是说明，实际内容必须完整真实；示例的 chapter 为 1，本次输出每个节点的 chapter 必须全部等于 ${input.targetChapter}；第一个示例是纯叙事节点——没有 choices 字段，第二个示例是抉择节点）：`,
    `   { "story": [ ${EXAMPLE_PLAIN_NODE}, ${EXAMPLE_NODE} ], "callbacks": [ { "eventId": "（账本中的原始ID）", "evidence": "（从本章内容原样复制的证据）" } ] }`,
    `9. 新选择也必须绑定 2—3 个 effects（career / economy / relationship / selfFulfillment），并给出 pathType、expectedConsequence 与 1—3 章内的 consequenceDueInChapters。effects.to 必须是选择后已经成立、后文不得无故推翻的具体事实。`,
    `10. 类型铁律：每个值必须保持自己的类型，严禁把对象或数组压缩成 "key: value" 字符串；deltas 只能使用 career / wisdom / happiness / relationship / courage 五个键且值必须是数字，禁止写 economy / selfFulfillment；节点对象只允许示例中的键，禁止把"场景建立""人物互动""冲突升级"等叙事分节名称当作 JSON 键。`,
    `11. 现实规则：时间、金钱、身体、职场权力和人际关系都必须遵守常识。任何机会、原谅、升职、离职、和解或资源变化都要有过程，不能用巧合或突然出现的贵人无代价解决。`,
    `12. 正文要求：scene 写 350—800 字、分成 3—5 个自然段；outcome 写 180—450 字、分成 2—3 个自然段。按时间或地点变化、人物互动和冲突推进自然换段，不写分节小标题；JSON 字符串内用 \\n\\n 表示段落。禁止缩写或提纲式输出。`,
  ].join("\n");
  const user = [
    `角色卡：`,
    `- 名字：${input.character.name}`,
    `- 背景：${input.character.background}`,
    `- 困境：${input.character.dilemma}`,
    `- 目标：${input.character.goal}`,
    `- 资源：${input.character.resources.join("、")}`,
    ``,
    `风格约束：`,
    ...input.constraints.map((constraint, index) => `${index + 1}. ${constraint}`),
    ``,
    `整季大纲：`,
    ...input.plan.items.map((item) => `第${item.chapter}章《${item.title}》：${item.synopsis}`),
    ``,
    `上一章结束处：`,
    `- 场景标题：${input.lastNode.title}`,
    `- 场景结尾：${input.lastNode.scene.slice(-200)}`,
    `- 玩家选择：「${input.lastChoice.choiceLabel}」`,
    `- 选择结果：${input.lastOutcome}`,
    `- 人物记住：${input.lastChoice.memory}`,
    ``,
    `已发生事件（唯一事实来源）：`,
    input.memorySummary || "（暂无）",
    ``,
    `Story Bible（不可改写的角色、世界与时间线）：`,
    JSON.stringify(input.storyBible, null, 2),
    ``,
    `当前 Story State（后文必须从这些状态继续）：`,
    JSON.stringify(input.storyState, null, 2),
    ``,
    `玩家路线合同（selected 已发生；unselected 是禁止串入的未选路线）：`,
    JSON.stringify(input.routeContract, null, 2),
    ``,
    `因果事件账本（pending 事件必须按期限兑现）：`,
    JSON.stringify(input.eventLedger, null, 2),
    ``,
    `请输出 JSON：{ "story": [ …第 ${input.targetChapter} 章的节点（2—3 个），末节点 chapterEnd 为 true … ], "callbacks": [ … ] }`,
  ].join("\n");
  return { system, user };
}

/** Rewrites every node/choice id under a per-call prefix; unknown nextNodeId refs (cross-chapter hallucinations) become undefined so the client falls back to linear progression. */
export function rewriteNodeIds(nodes: StoryNode[], callId: string): StoryNode[] {
  const map = new Map<string, string>();
  nodes.forEach((node, index) => map.set(node.id, `g${callId}-c${node.chapter}-n${index + 1}`));
  return nodes.map((node) => ({
    ...node,
    id: map.get(node.id) as string,
    choices: node.choices
      ? node.choices.map((choice, index) => {
          const next = choice.nextNodeId ? map.get(choice.nextNodeId) : undefined;
          return { ...choice, id: `${map.get(node.id)}-ch${index + 1}`, nextNodeId: next };
        })
      : undefined,
  }));
}

export function maxChapterNumber(nodes: StoryNode[]): number {
  return nodes.length ? Math.max(...nodes.map((node) => node.chapter)) : 0;
}

/** One line per chapter: "第2章《…》：选择了「…」→ 记忆摘要"，ordered by chapter. */
export function buildMemorySummary(choices: ChoiceRecord[], nodes: StoryNode[]): string {
  const byNode = new Map(nodes.map((node) => [node.id, node]));
  return choices
    .map((choice) => ({ chapter: choice.sourceChapter ?? byNode.get(choice.nodeId)?.chapter ?? 0, choice }))
    .filter((row) => row.chapter > 0)
    .sort((a, b) => a.chapter - b.chapter)
    .map(({ chapter, choice }) => `第${chapter}章：选择了「${choice.choiceLabel}」→ ${choice.memory.slice(0, 120)}`)
    .join("\n");
}
