import { NextResponse } from "next/server";
import { getPreset } from "@/server/story-library";
import { chatJSON, llmConfigured, storyModel } from "@/server/llm";
import { SEASON_RESULT_SCHEMA, buildSeasonPrompt, rewriteNodeIds } from "@/server/story-generation";
import type { CharacterCard, StoryChoice, StoryPreferences, StoryPlan } from "@/lib/types";
import { createInitialStoryBible, createInitialStoryState } from "@/lib/story-state";
import { STORY_EDITOR_PROMPT_VERSION } from "@/server/story-editor-prompt";
import { normalizeStoryProse } from "@/lib/story-prose";

export const maxDuration = 180;

function initialWorldState(character: CharacterCard) {
  return createInitialStoryState({
    career: character.background.slice(0, 90),
    economy: `可用资源：${character.resources.join("、")}`,
    relationship: "关系支持与边界尚未被任何玩家选择改变",
    selfFulfillment: `当前目标：${character.goal}`,
  });
}

function addFallbackCausality(choice: StoryChoice): StoryChoice {
  if (choice.effects?.length) return choice;
  const primary = (choice.deltas.career ?? 0) !== 0 ? "career" : "selfFulfillment";
  const secondary = (choice.deltas.relationship ?? 0) !== 0 ? "relationship" : "economy";
  return {
    ...choice,
    effects: [
      { domain: primary, to: `已采取「${choice.label}」路线`, consequence: choice.memory },
      { domain: secondary, to: `必须承担「${choice.cost}」`, consequence: choice.outcome.slice(-80) },
    ],
    pathType: "branch",
    expectedConsequence: choice.memory,
    consequenceDueInChapters: 1,
  };
}

export async function POST(request: Request) {
  const body = await request.json() as { character?: CharacterCard; preferences?: StoryPreferences };
  const character = body.character;
  if (!character) return NextResponse.json({ error: "缺少角色卡" }, { status: 400 });
  const base = getPreset("test-story");
  if (!base) return NextResponse.json({ error: "安全故事模板不可用" }, { status: 503 });
  const storyState = initialWorldState(character);
  const baseBible = createInitialStoryBible(character, storyState);
  let fallbackReason = llmConfigured() ? "AI 返回内容未通过结构或因果检查" : "故事生成服务尚未配置 API Key";

  // LLM path: full season plan + chapter 1 in a single, bounded call. Two 75s
  // attempts fit under this route's 180s budget and recover the occasional
  // malformed/truncated first response without stranding the player.
  if (llmConfigured()) {
    const prompt = buildSeasonPrompt(character, character.promptConstraints ?? []);
    const result = await chatJSON(prompt.system, prompt.user, {
      model: storyModel(),
      temperature: 0.9,
      maxTokens: 4500,
      timeoutMs: 75_000,
      maxAttempts: 2,
      enableThinking: false,
      stream: true,
      schema: SEASON_RESULT_SCHEMA,
    });
    if (result.ok) {
      const story = normalizeStoryProse(rewriteNodeIds(result.data.nodes, crypto.randomUUID().slice(0, 8)));
      const storyBible = {
        ...baseBible,
        openThreads: result.data.plan.items.slice(1).map((item) => ({
          id: `plan-ch${item.chapter}`,
          description: item.synopsis,
          dueByChapter: item.chapter,
          status: "open" as const,
        })),
      };
      return NextResponse.json({ jobId: crypto.randomUUID(), status: "first_chapter_ready", chapters: result.data.plan.chapters, provider: "bailian", promptVersion: STORY_EDITOR_PROMPT_VERSION, story, plan: result.data.plan, storyBible, storyState, eventLedger: [], preferences: body.preferences });
    }
    fallbackReason = `AI 生成失败：${result.error.code}`;
  }

  // Safe-template fallback: identical to the pre-LLM behavior, plus a plan derived from the template chapters.
  const story = normalizeStoryProse(base.nodes.map((node, index) => ({
    ...node,
    id: `custom-${index + 1}`,
    illustration: undefined,
    title: index === 0 ? "生活按下暂停键" : node.title,
    scene: index === 0
      ? `${character.name}正在经历：${character.dilemma}。现实没有立刻给出答案，故事会从她已有的资源、关系和限制开始，而不是靠巧合替她解决问题。`
      : node.scene.replace(/林澈/g, character.name),
    choices: node.choices?.map((choice, choiceIndex) => addFallbackCausality({ ...choice, id: `custom-${index + 1}-${choiceIndex}` })),
  })));
  const plan: StoryPlan = {
    chapters: 5,
    items: [...new Set(story.map((node) => node.chapter))]
      .filter((chapter) => chapter > 1)
      .slice(-5)
      .map((chapter, index) => {
        const first = story.find((node) => node.chapter === chapter) as (typeof story)[number];
        const synopsis = first.scene.replace(/\s+/g, " ").split(/[。！？]/)[0].slice(0, 40);
        return { chapter: index + 1, title: first.chapterTitle, synopsis };
      }),
  };
  const storyBible = {
    ...baseBible,
    openThreads: plan.items.slice(1).map((item) => ({
      id: `plan-ch${item.chapter}`,
      description: item.synopsis,
      dueByChapter: item.chapter,
      status: "open" as const,
    })),
  };
  return NextResponse.json({ jobId: crypto.randomUUID(), status: "first_chapter_ready", chapters: 5, provider: "safe-template", fallbackReason, promptVersion: STORY_EDITOR_PROMPT_VERSION, story, plan, storyBible, storyState, eventLedger: [], preferences: body.preferences });
}
