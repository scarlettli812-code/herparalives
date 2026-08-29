"use client";
import { AppHeader } from "@/components/AppHeader";
import { ScrollRevealText } from "@/components/ScrollRevealText";
import { getPortrait } from "@/lib/portraits";
import { applyStoryEffects, choiceRecordFromEvent, createStoryEvent, realizeEvents } from "@/lib/story-state";
import { getRun, nodesForRun, saveRun } from "@/lib/store";
import type { ChoiceRecord, GameRun, StatDelta, StoryCallback, StoryNode } from "@/lib/types";
import Image from "next/image";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";

const statLabels: Record<string, string> = { career: "事业", wisdom: "智慧", happiness: "幸福", relationship: "关系", courage: "勇气" };
const sumChapter = (records: ChoiceRecord[]) => records.reduce<StatDelta>((sum, record) => { Object.entries(record.deltas).forEach(([key, value]) => { const stat = key as keyof StatDelta; sum[stat] = (sum[stat] || 0) + (value || 0); }); return sum; }, {});
// iOS Safari cancels smooth programmatic scrolling when the layout changes in the same frame (e.g. a new chapter rendering), so jump instantly there and scroll smoothly elsewhere.
const iosDevice = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const scrollToTop = () => { const ios = iosDevice(); window.setTimeout(() => { if (ios) window.scrollTo(0, 0); else window.scrollTo({ top: 0, behavior: "smooth" }); }, 60); };

type ChapterResponse = {
  story?: StoryNode[];
  callbacks?: StoryCallback[];
  provider?: "bailian" | "safe-template";
  fallbackReason?: string;
  error?: string;
};

export default function PlayPage() {
  const id = String(useParams().runId); const router = useRouter(); const [run, setRun] = useState<GameRun>();
  const [selectedChoiceId, setSelectedChoiceId] = useState<string>();
  const [generating, setGenerating] = useState(false);
  const [continueError, setContinueError] = useState("");
  // Prefetch the next chapter while the player is still reading the current one's
  // final node — the chapter is usually ready by the time they click through, so
  // the perceived wait drops to ~0. Still exactly one generation per chapter.
  const prefetchRef = useRef<{ chapter: number; finalNodeId: string; stateVersion: number; story: StoryNode[]; callbacks: StoryCallback[]; provider: "bailian" | "safe-template"; fallbackReason?: string } | null>(null);
  const prefetchPromiseRef = useRef<Promise<{ chapter: number; finalNodeId: string; stateVersion: number; story: StoryNode[]; callbacks: StoryCallback[]; provider: "bailian" | "safe-template"; fallbackReason?: string } | null> | null>(null);
  const lastIndexRef = useRef(0);
  useEffect(() => setRun(getRun(id)), [id]);
  const nodes = useMemo(() => run ? nodesForRun(run) : [], [run]); const current = run ? (nodes.find((node) => node.id === run.currentNodeId) ?? nodes[run.currentIndex]) : undefined;
  useEffect(() => {
    if (!run?.plan || !current) return;
    // Rewinding to an earlier node invalidates a prefetch built on the old choices.
    if (run.currentIndex < lastIndexRef.current) prefetchRef.current = null;
    lastIndexRef.current = run.currentIndex;
    if (!current.chapterEnd) return;
    // A chapter-ending decision cannot be prefetched until its choice has been
    // recorded. Otherwise the cache describes a branch the player never chose.
    if ((current.choices?.length ?? 0) > 0 && !run.choices.some((choice) => choice.nodeId === current.id)) return;
    const maxChapter = nodes.length ? Math.max(...nodes.map((node) => node.chapter)) : 0;
    const target = maxChapter + 1;
    const stateVersion = run.stateVersion ?? run.choices.length;
    if (target > run.plan.chapters) return;
    if (prefetchRef.current?.finalNodeId === current.id && prefetchRef.current.stateVersion === stateVersion) return;
    if (prefetchPromiseRef.current) return;
    const lastNode = current;
    prefetchPromiseRef.current = (async () => {
      try {
        const response = await fetch("/api/chapters/generate", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ character: run.character, preferences: run.character.storyPreferences, plan: run.plan, targetChapter: target, memory: run.choices, lastNode, story: nodes, storyBible: run.storyBible, storyState: run.storyState, eventLedger: run.eventLedger }),
        });
        const result = await response.json() as ChapterResponse;
        if (!response.ok || !result.story?.length) return null;
        const entry = { chapter: target, finalNodeId: lastNode.id, stateVersion, story: result.story, callbacks: result.callbacks ?? [], provider: result.provider ?? "bailian", fallbackReason: result.fallbackReason };
        prefetchRef.current = entry;
        return entry;
      } catch {
        return null; // fall back to on-demand generation at the chapter end
      } finally {
        prefetchPromiseRef.current = null;
      }
    })();
  }, [run, current, nodes]);
  if (!run || !current) return <main><AppHeader /><section className="prepare"><h2>这条旧线路已经更新</h2><p>故事结构已重写，请从角色大厅重新开始测试。</p><Link className="primary dark-button" href="/lobby#sample">返回测试故事</Link></section></main>;

  const savedChoice = run.choices.findLast((item) => item.nodeId === current.id);
  const resolvedChoice = current.choices?.find((item) => item.id === (selectedChoiceId || savedChoice?.choiceId));
  const choose = (choiceIndex: number) => {
    if (resolvedChoice) return;
    const selected = current.choices?.[choiceIndex];
    if (!selected) return;
    const event = createStoryEvent({ nodeId: current.id, chapter: current.chapter, choice: selected });
    const record = choiceRecordFromEvent({ nodeId: current.id, choice: selected, event });
    const withChoice: GameRun = {
      ...run,
      choices: [...run.choices, record],
      storyState: applyStoryEffects(run.storyState ?? run.storyBible?.worldState ?? { career: "待确认", economy: "待确认", relationship: "待确认", selfFulfillment: "待确认" }, selected.effects),
      eventLedger: event ? [...(run.eventLedger ?? []), event] : (run.eventLedger ?? []),
      stateVersion: (run.stateVersion ?? 0) + 1,
      updatedAt: Date.now(),
    };
    prefetchRef.current = null;
    saveRun(withChoice); setRun(withChoice); setSelectedChoiceId(selected.id); setContinueError("");
    window.setTimeout(() => { const el = document.getElementById("choice-outcome"); if (el) { if (iosDevice()) el.scrollIntoView(); else el.scrollIntoView({ behavior: "smooth", block: "start" }); } }, 50);
  };
  const storyChapterCount = nodes.length ? Math.max(...nodes.map((node) => node.chapter)) : 0;
  const awaitingChoice = (current.choices?.length ?? 0) > 0 && !resolvedChoice;
  const needsGeneration = (() => {
    if (!run.plan) return false;
    if (resolvedChoice) {
      const fallback = nodes[run.currentIndex + 1];
      const nextNodeId = resolvedChoice.nextNodeId ?? fallback?.id;
      const nextIndex = nextNodeId ? nodes.findIndex((node) => node.id === nextNodeId) : -1;
      return !resolvedChoice.nextNodeId && !resolvedChoice.endsStory && nextIndex < 0 && storyChapterCount < run.plan.chapters;
    }
    // A decision node never advances before the player chooses. A pure narration
    // ending can continue directly because it has no unresolved branch.
    return !awaitingChoice && Boolean(current.chapterEnd) && storyChapterCount < run.plan.chapters;
  })();
  const buttonLabel = (() => {
    if (awaitingChoice) return "请先做出这一幕的选择";
    if (needsGeneration) return generating ? "正在生成下一章…" : continueError ? "重试生成下一章" : "生成下一章，继续故事";
    const seasonEnding = resolvedChoice
      ? Boolean(resolvedChoice.endsStory) || (!resolvedChoice.nextNodeId && run.currentIndex === nodes.length - 1)
      : Boolean(current.chapterEnd && storyChapterCount >= (run.plan?.chapters ?? 0));
    return seasonEnding ? "听听 Life Coach 的旅途回望" : current.chapterEnd ? "进入下一章" : "继续下一幕";
  })();
  const continueStory = async () => {
    if (generating || awaitingChoice) return;
    if (needsGeneration) {
      setGenerating(true); setContinueError("");
      try {
        // Prefer the background-prefetched chapter (cached or still in flight);
        // only fall back to an on-demand call when the prefetch failed. The
        // chapter/finalNodeId checks guard against a stale cache after rewind.
        const targetChapter = storyChapterCount + 1;
        let newNodes: StoryNode[] | null = null;
        let callbacks: StoryCallback[] = [];
        let provider: "bailian" | "safe-template" = "bailian";
        let fallbackReason: string | undefined;
        const stateVersion = run.stateVersion ?? run.choices.length;
        const cached = prefetchRef.current;
        if (cached?.chapter === targetChapter && cached.finalNodeId === current.id && cached.stateVersion === stateVersion) {
          newNodes = cached.story;
          callbacks = cached.callbacks;
          provider = cached.provider;
          fallbackReason = cached.fallbackReason;
          prefetchRef.current = null;
        } else if (prefetchPromiseRef.current) {
          const entry = await prefetchPromiseRef.current;
          if (entry?.chapter === targetChapter && entry.finalNodeId === current.id && entry.stateVersion === stateVersion) {
            newNodes = entry.story;
            callbacks = entry.callbacks;
            provider = entry.provider;
            fallbackReason = entry.fallbackReason;
            prefetchRef.current = null;
          }
        }
        if (!newNodes) {
          const response = await fetch("/api/chapters/generate", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ character: run.character, preferences: run.character.storyPreferences, plan: run.plan, targetChapter, memory: run.choices, lastNode: current, story: nodes, storyBible: run.storyBible, storyState: run.storyState, eventLedger: run.eventLedger }),
          });
          const result = await response.json() as ChapterResponse;
          if (!response.ok || !result.story?.length) throw new Error(result.error || "generate_failed");
          newNodes = result.story;
          callbacks = result.callbacks ?? [];
          provider = result.provider ?? "bailian";
          fallbackReason = result.fallbackReason;
        }
        const appended = [...nodes, ...newNodes];
        const visited = run.visitedNodeIds?.length ? run.visitedNodeIds : nodes.slice(0, run.currentIndex + 1).map((node) => node.id);
        const next: GameRun = {
          ...run,
          story: appended,
          currentIndex: appended.findIndex((node) => node.id === newNodes[0].id),
          currentNodeId: newNodes[0].id,
          visitedNodeIds: [...visited, ...newNodes.map((node) => node.id)],
          eventLedger: realizeEvents(run.eventLedger ?? [], callbacks, targetChapter),
          generation: {
            ...run.generation,
            stage: provider === "safe-template" ? "fallback" : "ready",
            source: provider,
            fallbackReason,
          },
          finished: false,
          updatedAt: Date.now(),
        };
        saveRun(next); setSelectedChoiceId(undefined); setRun(next); scrollToTop();
      } catch {
        setContinueError("下一章暂时没有准备好，请稍后重试。");
      } finally {
        setGenerating(false);
      }
      return;
    }
    const fallback = nodes[run.currentIndex + 1];
    // Pure narration nodes advance linearly; decision nodes follow their chosen nextNodeId.
    const nextNodeId = resolvedChoice ? (resolvedChoice.nextNodeId ?? fallback?.id) : fallback?.id;
    const nextIndex = nextNodeId ? nodes.findIndex((node) => node.id === nextNodeId) : -1;
    const finished = resolvedChoice
      ? Boolean(resolvedChoice.endsStory) || nextIndex < 0
      : Boolean(current.chapterEnd && storyChapterCount >= (run.plan?.chapters ?? 0)) || nextIndex < 0;
    const visited = run.visitedNodeIds?.length ? run.visitedNodeIds : nodes.slice(0, run.currentIndex + 1).map((node) => node.id);
    const next = { ...run, currentIndex: finished ? run.currentIndex : nextIndex, currentNodeId: finished ? current.id : nextNodeId, visitedNodeIds: finished || !nextNodeId ? visited : [...visited.filter((nodeId) => nodeId !== nextNodeId), nextNodeId], finished, updatedAt: Date.now() };
    saveRun(next); setSelectedChoiceId(undefined); if (finished) router.push(`/ending/${run.id}`); else { setRun(next); scrollToTop(); }
  };
  const previous = run.choices.at(-1);
  const planDots = run.plan?.items.map((item) => item.chapter) ?? [];
  const planDotsSorted = planDots.every((chapter, index) => index === 0 || chapter > planDots[index - 1]);
  const chapterNumbers = planDots.length === run.plan?.chapters && planDotsSorted ? planDots : [...new Set(nodes.map((node) => node.chapter))];
  const visitedIds = run.visitedNodeIds?.length ? run.visitedNodeIds : nodes.slice(0, run.currentIndex + 1).map((node) => node.id);
  const sceneInChapter = visitedIds.map((nodeId) => nodes.find((node) => node.id === nodeId)).filter((node) => node?.chapter === current.chapter).findIndex((node) => node?.id === current.id) + 1;
  const hasPrologue = run.presetId === "test-story";
  const chapterLabel = hasPrologue && current.chapter === 1 ? "PROLOGUE" : `CHAPTER ${hasPrologue ? current.chapter - 1 : current.chapter}`;
  const chapterDeltas = sumChapter(run.choices.filter((item) => nodes.find((storyNode) => storyNode.id === item.nodeId)?.chapter === current.chapter));
  const sceneArt = current.illustration ?? getPortrait(run.character.portrait).src;
  const artCaption = current.illustration
    ? "固定故事 · 内置场景插图"
    : "自定义故事 · 所选角色立绘";
  return <main className="play-page"><AppHeader compact /><div className="chapter-progress"><span>{current.chapterTitle} · 第 {sceneInChapter} 幕</span><div>{chapterNumbers.map((chapter) => <i className={chapter <= current.chapter ? "active" : ""} key={chapter} />)}</div><Link href={`/map/${run.id}`}>查看人生地图</Link></div><section className="story-stage"><div className="scene-art illustrated"><Image src={sceneArt} alt={`${current.title}手绘剧情场景`} fill priority sizes="(max-width: 760px) 100vw, 52vw" /><div className="scene-vignette" /><small>{artCaption}</small></div><article className="story-panel">{run.generation?.stage === "fallback" && <p className="chapter-fallback-note">本次 AI 内容未通过检查，已切换到可继续游玩的安全版本。{run.generation.fallbackReason ? `切换原因：${run.generation.fallbackReason}` : ""}</p>}{previous && run.currentIndex > 0 && <p className="memory-echo">人物记得：{previous.memory}</p>}<p className="scene-count">{chapterLabel} · SCENE {sceneInChapter}</p><h1>{current.title}</h1><ScrollRevealText className="scene-text rich-scene" text={current.scene} />{current.dialogue && <blockquote>{current.dialogue}</blockquote>}{!resolvedChoice && (current.choices?.length ?? 0) > 0 && <div className="choices"><p>故事走到这里，{run.character.name}准备如何回应？</p>{(current.choices ?? []).map((item, index) => <button onClick={() => choose(index)} key={item.id}><b>{String.fromCharCode(65 + index)}</b><span><strong>{item.label}</strong><small>{item.hint}</small></span><em>→</em></button>)}</div>}
    {resolvedChoice && <section className="inline-outcome" id="choice-outcome"><p className="eyebrow">YOUR CHOICE · {resolvedChoice.label}</p><h2>选择之后，生活继续发生</h2><ScrollRevealText className="outcome-story" text={resolvedChoice.outcome} variant="outcome" /><div className="consequence-grid"><div><small>获得</small><p>{resolvedChoice.gain}</p></div><div><small>代价</small><p>{resolvedChoice.cost}</p></div><div><small>仍然未知</small><p>{resolvedChoice.unknown}</p></div></div></section>}
    {current.chapterEnd && <section className="inline-coach"><p className="eyebrow">{chapterLabel} · LIFE COACH</p><h3>这一章，先在这里停一下</h3><p className="chapter-summary">以下五维只记录本章变化，不代表选择的好坏。</p><div className="delta-row">{Object.entries(chapterDeltas).filter(([, value]) => value).map(([key, value]) => <span key={key}><b>{statLabels[key]}</b><em className={(value || 0) > 0 ? "up" : "down"}>{(value || 0) > 0 ? "+" : ""}{value}</em></span>)}</div><div className="coach"><small>章末镜面 · 不替你决定</small><p>{current.coach}</p></div><small className="no-rank">Coach 从本章经历中提出问题，不提供标准答案。</small></section>}
    {continueError && <p className="continue-error">{continueError}</p>}
    <button className="primary story-continue full" disabled={generating || awaitingChoice} onClick={continueStory}>{buttonLabel}</button></article></section>
  </main>;
}
