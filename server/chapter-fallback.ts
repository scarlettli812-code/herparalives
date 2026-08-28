import "server-only";
import type {
  CharacterCard,
  ChoiceRecord,
  StoryCallback,
  StoryEvent,
  StoryNode,
  StoryPlan,
  StoryState,
} from "@/lib/types";

type SafeChapterInput = {
  character: CharacterCard;
  plan: StoryPlan;
  targetChapter: number;
  lastNode: StoryNode;
  lastChoice?: ChoiceRecord;
  lastOutcome?: string;
  storyState: StoryState;
  eventLedger: StoryEvent[];
};

const compact = (value: string, length: number) => value.replace(/\s+/g, " ").trim().slice(0, length);
const withoutTerminalPunctuation = (value: string) => value.replace(/[。！？.!?]+$/u, "");
const excerpt = (value: string, length: number) => {
  const flat = value.replace(/\s+/g, " ").trim();
  if (flat.length <= length) return withoutTerminalPunctuation(flat);
  const head = flat.slice(0, length);
  const boundary = Math.max(head.lastIndexOf("。"), head.lastIndexOf("！"), head.lastIndexOf("？"));
  return boundary >= Math.floor(length * 0.55)
    ? withoutTerminalPunctuation(head.slice(0, boundary + 1))
    : `${withoutTerminalPunctuation(head)}…`;
};

/**
 * Keeps a guest run playable when the provider times out or returns malformed
 * JSON. The chapter is deliberately transparent and grounded only in facts the
 * client already supplied; it never invents a hidden model result.
 */
export function buildSafeChapter(input: SafeChapterInput): {
  story: StoryNode[];
  callbacks: StoryCallback[];
} {
  const { character, plan, targetChapter, lastNode, storyState, eventLedger } = input;
  const planItem = plan.items.find((item) => item.chapter === targetChapter) ?? plan.items[targetChapter - 1];
  const chapterTitle = `第${targetChapter}章｜${planItem?.title || "把选择带进生活"}`;
  const choiceLabel = input.lastChoice?.choiceLabel || "上一章的决定";
  const choiceMemory = compact(input.lastChoice?.memory || choiceLabel, 80);
  const pending = eventLedger.filter((event) => event.status === "pending");
  const due = pending.filter((event) => event.dueByChapter <= targetChapter);
  const realizedHere = due.length ? due : pending.slice(0, 1);
  const callbackRows = realizedHere.map((event) => ({
    event,
    evidence: compact(`「${event.choiceLabel}」带来的影响开始出现：${event.expectedConsequence}`, 116),
  }));
  const callbacks = callbackRows.map(({ event, evidence }) => ({ eventId: event.id, evidence }));
  const callbackEvidence = callbackRows.map(({ evidence }) => `${evidence}。`).join("\n");
  const stateSummary = [
    `职业：${compact(storyState.career, 70)}`,
    `经济：${compact(storyState.economy, 70)}`,
    `关系：${compact(storyState.relationship, 70)}`,
    `自主感：${compact(storyState.selfFulfillment, 70)}`,
  ].join("；");
  const prefix = `safe-${crypto.randomUUID().slice(0, 8)}-c${targetChapter}`;
  const finalChapter = targetChapter === plan.chapters;

  const firstScene = [
    `上一章结束后，${character.name}没有把「${choiceLabel}」留在一句口号里。她记得的是：${withoutTerminalPunctuation(choiceMemory)}。决定已经发生，生活开始用日程、钱、关系和精力检验它。`,
    callbackEvidence,
    `几天后，她重新打开自己的记录。${stateSummary}。这些事实彼此牵连，没有哪一项能靠一次勇敢或退让自动消失。`,
    `这一章原本要走向“${withoutTerminalPunctuation(compact(planItem?.synopsis || character.goal, 120))}”。她先做的不是宣布答案，而是把上一章留下的承诺、现实限制和仍未解决的问题放到同一张纸上。上一章的即时结果也被记在纸上：“${excerpt(input.lastOutcome || lastNode.scene.slice(-180), 160)}”。那一刻的压力仍然在，但它现在有了可以继续处理的形状。`,
  ].filter(Boolean).join("\n\n");

  const decisionScene = [
    `周末傍晚，${character.name}收到一条需要明确答复的消息。对方没有替她决定，只要求她说明接下来愿意投入什么、拒绝什么，以及什么时候重新评估。`,
    `她看着手边的资源：${character.resources.join("、")}。继续原路线能保护已经获得的东西，却会让部分代价变得更具体；立刻调整可以降低眼前压力，也可能让刚建立的信任和进度中断。`,
    `她把问题缩小到下一段可执行的行动：是继续推进、先协商边界，还是保留退路并设置检查点。三条路都承认上一章已经发生，也都不会保证一种无代价的未来。`,
  ].join("\n\n");

  const common = {
    chapter: targetChapter,
    chapterTitle,
  };
  const story: StoryNode[] = [
    {
      ...common,
      id: `${prefix}-n1`,
      title: "选择开始产生重量",
      scene: firstScene,
      dialogue: `“我不需要马上证明它正确，只需要诚实地看见它正在改变什么。”${character.name}在记录末尾写道。`,
      causedByEventIds: callbacks.map((callback) => callback.eventId),
    },
    {
      ...common,
      id: `${prefix}-n2`,
      title: "把下一步说具体",
      scene: decisionScene,
      dialogue: "真正需要回答的，不是我够不够坚定，而是下一步愿意承担哪一种现实。",
      chapterEnd: true,
      coach: "这次选择不需要证明上一章正确。更重要的是看见新证据后，仍保有继续、协商或调整的能力。",
      choices: [
        {
          id: `${prefix}-n2-ch1`,
          label: "按原计划继续推进",
          hint: "给已经选择的路线一个明确验证期",
          gain: "积累连续行动的真实证据",
          cost: "继续承担当前路线的时间与压力",
          unknown: "验证期结束时条件是否已经改变",
          outcome: `${character.name}把接下来的行动拆成一周内可以完成的步骤，并写下停止条件。她没有把坚持解释成永不改变，而是决定先让这条路线产生足够证据。\n\n相关的人得到了一份明确安排，也提醒她资源并非无限。她把复盘日期写进日历：到那一天，进展、身体感受和现实成本都必须重新摆上桌面。`,
          deltas: { career: 1, courage: 1, happiness: -1 },
          memory: `${character.name}为原路线设置了有期限的验证期`,
          effects: [
            { domain: "career", from: storyState.career, to: "原路线进入有期限的验证阶段", consequence: "后续必须出现验证结果或停止条件" },
            { domain: "selfFulfillment", from: storyState.selfFulfillment, to: "用行动证据代替一次性自我证明", consequence: "复盘时将比较进展、感受与成本" },
          ],
          pathType: "evidence",
          expectedConsequence: "验证期限到来时，她必须依据真实进展决定继续或调整",
          consequenceDueInChapters: 1,
          ...(finalChapter ? { endsStory: true } : {}),
        },
        {
          id: `${prefix}-n2-ch2`,
          label: "先把边界谈清楚",
          hint: "让相关的人共同面对限制和分工",
          gain: "减少猜测并争取可持续的合作方式",
          cost: "可能暴露双方并不一致的期待",
          unknown: "对方是否愿意接受新的边界",
          outcome: `${character.name}没有直接答应，也没有用沉默拖延。她约对方谈清可投入的时间、不能承担的部分和需要共同完成的工作。\n\n谈话没有立刻带来圆满，有些期待甚至第一次显得不相容。但模糊压力变成了可以协商的条目，她也终于知道下一步的阻力来自哪里，而不是继续把所有问题归结为自己不够努力。`,
          deltas: { relationship: 1, wisdom: 1, courage: 1 },
          memory: `${character.name}把需求、能力和限制放进同一次协商`,
          effects: [
            { domain: "relationship", from: storyState.relationship, to: "关键关系进入边界协商", consequence: "对方必须对新的分工与限制作出回应" },
            { domain: "selfFulfillment", from: storyState.selfFulfillment, to: "不再独自承担所有模糊期待", consequence: "她将根据协商结果调整投入" },
          ],
          pathType: "branch",
          expectedConsequence: "协商结果将改变双方的分工、信任或后续路线",
          consequenceDueInChapters: 1,
          ...(finalChapter ? { endsStory: true } : {}),
        },
        {
          id: `${prefix}-n2-ch3`,
          label: "保留退路并设置检查点",
          hint: "先保护基本资源，再决定是否扩大投入",
          gain: "降低不可逆风险并保留调整空间",
          cost: "进展会更慢，也可能错过部分机会",
          unknown: "等待期间是否会出现新的限制",
          outcome: `${character.name}先确认了自己的最低资源线，再为当前路线设下一个检查点。检查点以前不追加新的承诺，检查点到来时也不允许因为已经投入而自动延长。\n\n这个决定让节奏慢下来，也让一些人感到失望。可她第一次把“可以反悔”写进计划，而不是等到耗尽以后才承认自己需要改变。`,
          deltas: { wisdom: 2, career: -1, happiness: 1 },
          memory: `${character.name}先保护基本资源，并约定了重新选择的检查点`,
          effects: [
            { domain: "economy", from: storyState.economy, to: "基本资源线得到优先保护", consequence: "后续投入不得越过已设定的资源底线" },
            { domain: "career", from: storyState.career, to: "当前路线放慢并等待检查点", consequence: "检查点到来时要比较机会损失与风险下降" },
          ],
          pathType: "delay",
          expectedConsequence: "检查点到来时，她将重新计算资源并决定是否恢复投入",
          consequenceDueInChapters: 1,
          ...(finalChapter ? { endsStory: true } : {}),
        },
      ],
    },
  ];

  return { story, callbacks };
}
