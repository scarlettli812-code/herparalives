"use client";

import { AppHeader } from "@/components/AppHeader";
import { createInitialStoryBible, createInitialStoryState } from "@/lib/story-state";
import { getRun, saveRun } from "@/lib/store";
import type { GenerationMeta, StoryBible, StoryEvent, StoryNode, StoryPlan, StoryState } from "@/lib/types";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";

type PrepareStage = "connecting" | "generating" | "validating" | "ready" | "fallback" | "failed";

const stageCopy: Record<PrepareStage, { title: string; detail: string }> = {
  connecting: { title: "正在连接故事生成服务", detail: "正在提交角色卡与风格偏好……" },
  generating: { title: "正在铺开五章人生线路", detail: "AI 正在固定角色关系、核心冲突与第一章；这一步可能需要一两分钟。" },
  validating: { title: "故事已返回，正在检查", detail: "正在确认章节结构、选择变量和因果约束是否完整。" },
  ready: { title: "第一章已经准备好", detail: "后面的章节会在你阅读时按已经发生的选择继续生成。" },
  fallback: { title: "第一章已用安全模板准备好", detail: "本次 AI 生成没有通过检查，已切换到可继续游玩的安全故事；不会把模板冒充成 AI 结果。" },
  failed: { title: "故事暂时没有准备好", detail: "请求没有成功完成。你可以重试，已经填写的角色卡不会丢失。" },
};

type SeasonResponse = {
  error?: string;
  story?: StoryNode[];
  plan?: StoryPlan;
  provider?: "bailian" | "safe-template";
  promptVersion?: string;
  fallbackReason?: string;
  storyBible?: StoryBible;
  storyState?: StoryState;
  eventLedger?: StoryEvent[];
};

function PrepareContent() {
  const id = useSearchParams().get("run") || "";
  const [stage, setStage] = useState<PrepareStage>("connecting");
  const [name, setName] = useState("她");
  const [attempt, setAttempt] = useState(0);
  const [fallbackReason, setFallbackReason] = useState("");

  useEffect(() => {
    const run = getRun(id);
    setName(run?.character.name || "她");
    if (!run) {
      setStage("failed");
      return;
    }
    if (run.story.length) {
      setFallbackReason(run.generation?.fallbackReason ?? "");
      setStage(run.generation?.stage === "fallback" ? "fallback" : "ready");
      return;
    }

    const controller = new AbortController();
    setStage("generating");
    void (async () => {
      try {
        const response = await fetch("/api/seasons/generate", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ character: run.character, preferences: run.character.storyPreferences }),
          signal: controller.signal,
        });
        const result = await response.json() as SeasonResponse;
        if (!response.ok || !result.story?.length || !result.plan) throw new Error(result.error || "generate_failed");
        setStage("validating");
        const storyState = result.storyState ?? createInitialStoryState();
        const source = result.provider === "safe-template" ? "safe-template" : "bailian";
        setFallbackReason(result.fallbackReason ?? "");
        const generation: GenerationMeta = {
          stage: source === "safe-template" ? "fallback" : "ready",
          source,
          promptVersion: result.promptVersion,
          fallbackReason: result.fallbackReason,
        };
        saveRun({
          ...run,
          story: result.story,
          plan: result.plan,
          storyState,
          storyBible: result.storyBible ?? createInitialStoryBible(run.character, storyState),
          eventLedger: result.eventLedger ?? [],
          stateVersion: 0,
          generation,
          updatedAt: Date.now(),
        });
        setStage(source === "safe-template" ? "fallback" : "ready");
      } catch {
        if (!controller.signal.aborted) setStage("failed");
      }
    })();
    return () => controller.abort();
  }, [attempt, id]);

  const copy = stageCopy[stage];
  const playable = stage === "ready" || stage === "fallback";
  return <main>
    <AppHeader />
    <section className={`prepare prepare-${stage}`} aria-live="polite">
      {!playable && stage !== "failed" && <div className="route-loader" aria-label="故事生成进行中"><span /><span /><span /><span /><span /></div>}
      <p className="eyebrow dark">SEASON 01 · {stage.toUpperCase()}</p>
      <h2>{playable ? `${name}的${copy.title}` : copy.title}</h2>
      <p>{copy.detail}</p>
      {stage === "fallback" && fallbackReason && <p className="generation-detail">切换原因：{fallbackReason}</p>}
      {stage === "failed" && <button className="primary dark-button" onClick={() => setAttempt((value) => value + 1)}>重新生成</button>}
      {playable && <Link className="primary dark-button" href={`/play/${id}`}>进入第一章</Link>}
      <small>故事不会展示模型推理过程，也不预测你的真实未来。</small>
    </section>
  </main>;
}

export default function PreparePage() {
  return <Suspense><PrepareContent /></Suspense>;
}
