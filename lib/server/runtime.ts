import type { GameRun } from "@/lib/types";

type Job = { id: string; status: "queued" | "running" | "completed" | "failed"; type: "story"; createdAt: number };

const globalRuntime = globalThis as typeof globalThis & { __parallelHerRuns?: Map<string, GameRun>; __parallelHerJobs?: Map<string, Job>; __parallelHerIdempotency?: Set<string> };
export const runtimeRuns = globalRuntime.__parallelHerRuns ||= new Map<string, GameRun>();
export const runtimeJobs = globalRuntime.__parallelHerJobs ||= new Map<string, Job>();
export const idempotencyKeys = globalRuntime.__parallelHerIdempotency ||= new Set<string>();

export function runtimeMode() { return process.env.CLOUDBASE_ENV_ID ? "cloudbase" : "demo-memory"; }

// CloudBase is the production source of truth. This in-memory adapter keeps local
// development and the fixed Demo route usable before credentials are configured.
