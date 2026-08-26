"use client";

import type { CharacterCard, GameRun, Preset } from "./types";
import { createInitialStoryBible, createInitialStoryState } from "./story-state";

const RUNS_KEY = "parallel-her:runs";
const SESSION_KEY = "parallel-her:guest";
const TTL = 24 * 60 * 60 * 1000;

const safeParse = <T,>(raw: string | null, fallback: T): T => {
  try { return raw ? JSON.parse(raw) as T : fallback; } catch { return fallback; }
};

export function ensureGuest() {
  if (typeof window === "undefined") return;
  const current = safeParse<{ expiresAt: number } | null>(localStorage.getItem(SESSION_KEY), null);
  if (!current || current.expiresAt < Date.now()) {
    localStorage.setItem(SESSION_KEY, JSON.stringify({ id: crypto.randomUUID(), expiresAt: Date.now() + TTL }));
    localStorage.removeItem(RUNS_KEY);
  }
}

export function allRuns(): GameRun[] {
  ensureGuest();
  const runs = safeParse<GameRun[]>(localStorage.getItem(RUNS_KEY), []);
  return runs;
}

export function saveRun(run: GameRun) {
  const runs = allRuns().filter((item) => item.id !== run.id);
  localStorage.setItem(RUNS_KEY, JSON.stringify([run, ...runs]));
}

export function getRun(id: string) { return allRuns().find((run) => run.id === id); }

export function createPresetRun(preset: Preset) {
  const character: CharacterCard = { id: preset.id, name: preset.name, age: preset.age, portrait: preset.portrait, background: preset.situation, goal: preset.tagline, resources: ["已有生活经验", "仍可调动的人际支持"], dilemma: preset.situation, isCustom: false };
  const storyState = createInitialStoryState({ career: preset.situation, selfFulfillment: preset.tagline });
  const run: GameRun = {
    id: crypto.randomUUID(), presetId: preset.id, story: preset.nodes, currentIndex: 0, currentNodeId: preset.nodes[0]?.id, visitedNodeIds: preset.nodes[0] ? [preset.nodes[0].id] : [], choices: [], branch: 1,
    createdAt: Date.now(), updatedAt: Date.now(), finished: false,
    character,
    storyState,
    storyBible: createInitialStoryBible(character, storyState),
    eventLedger: [],
    stateVersion: 0,
    generation: { stage: "ready", source: "preset" },
  };
  saveRun(run); return run;
}

export function createCustomRun(character: CharacterCard) {
  const storyState = createInitialStoryState();
  const run: GameRun = { id: crypto.randomUUID(), character, story: [], currentIndex: 0, choices: [], visitedNodeIds: [], storyState, storyBible: createInitialStoryBible(character, storyState), eventLedger: [], stateVersion: 0, generation: { stage: "idle", source: "bailian" }, branch: 1, createdAt: Date.now(), updatedAt: Date.now(), finished: false };
  saveRun(run); return run;
}
export function nodesForRun(run: GameRun) { return run.story || []; }
