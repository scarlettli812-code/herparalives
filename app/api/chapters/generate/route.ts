import { NextResponse } from "next/server";
import { chatJSON, llmConfigured, storyModel } from "@/server/llm";
import {
  CHAPTER_RESULT_SCHEMA,
  buildChapterPrompt,
  buildMemorySummary,
  rewriteNodeIds,
} from "@/server/story-generation";
import { attachCallbackIds, validateChapterContinuity } from "@/server/state-validator";
import { createInitialStoryBible, createInitialStoryState } from "@/lib/story-state";
import type {
  CharacterCard,
  ChoiceRecord,
  StoryBible,
  StoryEvent,
  StoryNode,
  StoryPlan,
  StoryPreferences,
  StoryState,
} from "@/lib/types";

export const maxDuration = 300;

type Body = {
  character?: CharacterCard;
  preferences?: StoryPreferences;
  plan?: StoryPlan;
  targetChapter?: number;
  memory?: ChoiceRecord[];
  lastNode?: StoryNode;
  story?: StoryNode[];
  storyBible?: StoryBible;
  storyState?: StoryState;
  eventLedger?: StoryEvent[];
};

export async function POST(request: Request) {
  const body = (await request.json()) as Body;
  const { character, plan, targetChapter } = body;
  if (!character || !plan || !plan.items?.length) return NextResponse.json({ error: "缺少必要参数" }, { status: 400 });
  if (!targetChapter || targetChapter < 2 || targetChapter > plan.chapters) return NextResponse.json({ error: "章节号超出范围" }, { status: 400 });
  const lastNode = body.lastNode;
  if (!lastNode) return NextResponse.json({ error: "缺少上一章节点" }, { status: 400 });
  if (!llmConfigured()) return NextResponse.json({ error: "no_key" }, { status: 503 });

  const memory = body.memory ?? [];
  const storySoFar = body.story?.length ? body.story : [lastNode];
  const lastChoiceRecord = [...memory].reverse()[0];
  const lastChoiceNode = lastChoiceRecord
    ? storySoFar.find((node) => node.id === lastChoiceRecord.nodeId)
    : undefined;
  const lastChoiceInNode = lastChoiceRecord
    ? lastChoiceNode?.choices?.find((choice) => choice.id === lastChoiceRecord.choiceId)
    : undefined;
  const memorySummary = buildMemorySummary(memory, storySoFar);
  const storyState = body.storyState ?? body.storyBible?.worldState ?? createInitialStoryState();
  const storyBible = body.storyBible ?? createInitialStoryBible(character, storyState);
  const eventLedger = body.eventLedger ?? [];
  const prompt = buildChapterPrompt({
    character,
    constraints: character.promptConstraints ?? [],
    plan,
    targetChapter,
    memorySummary,
    storyBible,
    storyState,
    eventLedger,
    lastNode,
    lastChoice: lastChoiceRecord
      ? { choiceLabel: lastChoiceRecord.choiceLabel, memory: lastChoiceRecord.memory }
      : { choiceLabel: "（上一章结尾的选择）", memory: "她记得上一章走到这里的选择。" },
    lastOutcome: lastChoiceInNode?.outcome ?? "",
  });
  const result = await chatJSON(prompt.system, prompt.user, {
    model: storyModel(),
    temperature: 0.9,
    maxTokens: 6000,
    timeoutMs: 110_000,
    maxAttempts: 2,
    enableThinking: false,
    schema: CHAPTER_RESULT_SCHEMA,
  });
  if (!result.ok) return NextResponse.json({ error: "generate_failed" }, { status: 502 });

  let story = rewriteNodeIds(result.data.story, crypto.randomUUID().slice(0, 8));
  if (story.some((node) => node.chapter !== targetChapter)) {
    return NextResponse.json({ error: "generate_failed" }, { status: 502 });
  }
  const last = story[story.length - 1];
  // The client only appends what this route returns, so mutating in place is safe.
  // A pure-narration chapter ending (no choices) ends via the coach/回望 button;
  // only force endsStory when the last node actually carries choices.
  last.chapterEnd = true;
  if (last.choices) {
    last.choices =
      targetChapter === plan.chapters
        ? last.choices.map((choice) => ({ ...choice, endsStory: true }))
        : last.choices.map((choice) => {
            const { endsStory: removed, ...rest } = choice;
            return rest;
          });
  }
  const validation = validateChapterContinuity({
    story,
    callbacks: result.data.callbacks,
    eventLedger,
    targetChapter,
  });
  if (!validation.ok) {
    console.error(`[chapters] continuity validation failed: ${validation.errors.join(" | ")}`);
    return NextResponse.json({ error: "continuity_failed", details: validation.errors }, { status: 502 });
  }
  story = attachCallbackIds(story, result.data.callbacks);
  return NextResponse.json({ story, callbacks: result.data.callbacks });
}
