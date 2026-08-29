import type {
  CharacterCard,
  ChoiceRecord,
  StoryBible,
  StoryChoice,
  StoryEffect,
  StoryEvent,
  StoryState,
} from "./types";

const DEFAULT_STATE: StoryState = {
  career: "职业状态仍待故事确认",
  economy: "经济缓冲仍待故事确认",
  relationship: "重要关系与支持方式仍待故事确认",
  selfFulfillment: "自主感与满足感仍待故事确认",
};

export function createInitialStoryState(overrides?: Partial<StoryState>): StoryState {
  return { ...DEFAULT_STATE, ...overrides };
}

export function createInitialStoryBible(character: CharacterCard, state: StoryState): StoryBible {
  return {
    version: 1,
    protagonistId: character.id,
    characters: [
      {
        id: character.id,
        name: character.name,
        role: "主角",
        goal: character.goal,
        boundary: character.dilemma,
      },
    ],
    worldState: state,
    timeline: ["故事从用户确认的虚构角色处境开始"],
    invariants: [
      `主角姓名始终为${character.name}`,
      "未被选择的行动不得被后文当作已经发生",
      "已拒绝、已结束或尚未获得的事实不得被后文默认推翻",
    ],
    openThreads: [],
  };
}

export function applyStoryEffects(state: StoryState, effects: StoryEffect[] = []): StoryState {
  return effects.reduce<StoryState>((next, effect) => ({ ...next, [effect.domain]: effect.to }), { ...state });
}

export function createStoryEvent(input: {
  nodeId: string;
  chapter: number;
  choice: StoryChoice;
  eventId?: string;
}): StoryEvent | undefined {
  const effects = input.choice.effects ?? [];
  if (!effects.length) return undefined;
  const dueOffset = Math.max(1, Math.min(3, input.choice.consequenceDueInChapters ?? 1));
  return {
    id: input.eventId ?? crypto.randomUUID(),
    sourceNodeId: input.nodeId,
    sourceChoiceId: input.choice.id,
    sourceChapter: input.chapter,
    choiceLabel: input.choice.label,
    effects,
    expectedConsequence: input.choice.expectedConsequence ?? effects[0].consequence,
    dueByChapter: input.chapter + dueOffset,
    status: "pending",
  };
}

export function choiceRecordFromEvent(input: {
  nodeId: string;
  choice: StoryChoice;
  event?: StoryEvent;
  at?: number;
}): ChoiceRecord {
  return {
    nodeId: input.nodeId,
    sourceChapter: input.event?.sourceChapter,
    choiceId: input.choice.id,
    choiceLabel: input.choice.label,
    memory: input.choice.memory,
    deltas: input.choice.deltas,
    eventId: input.event?.id,
    effects: input.event?.effects,
    expectedConsequence: input.event?.expectedConsequence,
    dueByChapter: input.event?.dueByChapter,
    at: input.at ?? Date.now(),
  };
}

export function rebuildStoryState(initial: StoryState, choices: ChoiceRecord[]): StoryState {
  return choices.reduce((state, choice) => applyStoryEffects(state, choice.effects), initial);
}

export function rebuildEventLedger(choices: ChoiceRecord[], previous: StoryEvent[] = []): StoryEvent[] {
  const previousById = new Map(previous.map((event) => [event.id, event]));
  return choices.flatMap((choice) => {
    if (!choice.eventId || !choice.effects?.length) return [];
    const existing = previousById.get(choice.eventId);
    if (existing) return [existing];
    return [{
      id: choice.eventId,
      sourceNodeId: choice.nodeId,
      sourceChoiceId: choice.choiceId,
      sourceChapter: choice.sourceChapter ?? Math.max(1, (choice.dueByChapter ?? 2) - 1),
      choiceLabel: choice.choiceLabel,
      effects: choice.effects,
      expectedConsequence: choice.expectedConsequence ?? choice.effects[0].consequence,
      dueByChapter: choice.dueByChapter ?? 2,
      status: "pending" as const,
    }];
  });
}

export function realizeEvents(
  ledger: StoryEvent[],
  callbacks: Array<{ eventId: string; evidence: string }>,
  chapter: number,
): StoryEvent[] {
  const byId = new Map(callbacks.map((callback) => [callback.eventId, callback.evidence]));
  return ledger.map((event) => {
    const evidence = byId.get(event.id);
    return evidence
      ? { ...event, status: "realized" as const, realizedInChapter: chapter, realizedEvidence: evidence }
      : event;
  });
}
