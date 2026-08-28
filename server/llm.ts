import "server-only";
import type { z } from "zod";

// Shared client for OpenAI-compatible chat endpoints (Alibaba Bailian DashScope by default).
// The API key is read from the server environment only — it must never appear in
// committed files, logs, or client responses. No third-party dependencies.

export type LlmError =
  | { code: "no_key" }
  | { code: "timeout" }
  | { code: "http"; status: number }
  | { code: "parse" };

export type LlmResult<T> = { ok: true; data: T } | { ok: false; error: LlmError };

const DEFAULT_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1";
const MAX_TOKENS = 6000;
// Defaults are intentionally conservative, but latency-sensitive routes must set
// their own budgets. In particular, never combine 170s × 2 inside a Vercel Hobby
// function: the platform terminates the invocation at 300s before the caller can
// return a structured fallback response.
const TIMEOUT_MS = 170_000;
const MAX_ATTEMPTS = 2;

export function llmConfigured(): boolean {
  return Boolean(process.env.DASHSCOPE_API_KEY);
}

export function storyModel(): string {
  // qwen-plus is ~2x faster and rarely times out (qwen3.7-max often exceeds 170s,
  // and a timed-out generation is still billed). Set QWEN_STORY_MODEL=qwen3.7-max
  // for the higher-quality tier.
  return process.env.QWEN_STORY_MODEL || "qwen-plus";
}

export function structuredModel(): string {
  return process.env.QWEN_STRUCTURED_MODEL || "qwen-plus";
}

type ChatOpts<T> = {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  schema?: z.ZodType<T>;
  timeoutMs?: number;
  maxAttempts?: number;
  enableThinking?: boolean;
  stream?: boolean;
};

type PostResult = { status: number; text: string; retryAfter?: number };

async function post(body: Record<string, unknown>, timeoutMs: number): Promise<PostResult> {
  const base = (process.env.LLM_BASE_URL || DEFAULT_BASE_URL).replace(/\/$/, "");
  const response = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${process.env.DASHSCOPE_API_KEY}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const retryAfter = Number(response.headers.get("retry-after") || 0) || undefined;
  return { status: response.status, text: await response.text(), retryAfter };
}

function parseContent(content: string): unknown {
  const trimmed = content.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fenced) return JSON.parse(fenced[1]);
  try {
    return JSON.parse(trimmed);
  } catch {
    // Plain-text mode may wrap the JSON in prose — extract the outermost value.
    const starts = [trimmed.indexOf("{"), trimmed.indexOf("[")].filter((i) => i >= 0);
    const ends = [trimmed.lastIndexOf("}"), trimmed.lastIndexOf("]")];
    const start = starts.length ? Math.min(...starts) : -1;
    const end = Math.max(...ends);
    if (start < 0 || end <= start) throw new Error("no JSON found in content");
    return JSON.parse(trimmed.slice(start, end + 1));
  }
}

function readAssistantContent(responseText: string): string {
  const trimmed = responseText.trim();
  if (!trimmed.startsWith("data:")) {
    const payload = JSON.parse(trimmed) as { choices?: { message?: { content?: string } }[] };
    const content = payload.choices?.[0]?.message?.content;
    if (!content) throw new Error("empty content");
    return content;
  }

  let content = "";
  for (const line of trimmed.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const raw = line.slice(5).trim();
    if (!raw || raw === "[DONE]") continue;
    const payload = JSON.parse(raw) as {
      choices?: Array<{
        delta?: { content?: string };
        message?: { content?: string };
      }>;
    };
    const chunk = payload.choices?.[0]?.delta?.content ?? payload.choices?.[0]?.message?.content;
    if (chunk) content += chunk;
  }
  if (!content) throw new Error("empty streamed content");
  return content;
}

function describeFetchError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = error.cause;
  if (!cause || typeof cause !== "object") return error.message;
  const detail = cause as { code?: unknown; message?: unknown };
  return [error.message, detail.code, detail.message].filter(Boolean).join(" · ");
}

export async function chatJSON<T>(system: string, user: string, opts?: ChatOpts<T>): Promise<LlmResult<T>> {
  if (!llmConfigured()) return { ok: false, error: { code: "no_key" } };
  const timeoutMs = Math.max(1_000, opts?.timeoutMs ?? TIMEOUT_MS);
  const maxAttempts = Math.min(3, Math.max(1, opts?.maxAttempts ?? MAX_ATTEMPTS));
  const baseBody: Record<string, unknown> = {
    model: opts?.model || structuredModel(),
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    temperature: opts?.temperature ?? 0.9,
    max_tokens: opts?.maxTokens ?? MAX_TOKENS,
    response_format: { type: "json_object" },
  };
  if (opts?.enableThinking !== undefined) {
    baseBody.enable_thinking = opts.enableThinking;
  }
  if (opts?.stream) baseBody.stream = true;
  // Retry budget is small, so a failing attempt switches to the fast structured
  // model (qwen-plus by default) instead of repeating a doomed slow call — qwen3.7-max
  // chapter-sized generation can exceed the timeout, and qwen-plus finishes it fast.
  const switchToFallback = (): boolean => {
    if (opts?.model && baseBody.model !== structuredModel()) {
      baseBody.model = structuredModel();
      console.error(`[llm] retrying with ${structuredModel()}`);
      return true;
    }
    return false;
  };
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let response: PostResult;
    try {
      response = await post(baseBody, timeoutMs);
    } catch (error) {
      // Network error / timeout — retry while the caller's bounded attempt budget remains.
      const message = describeFetchError(error);
      console.error(`[llm] attempt ${attempt}: fetch failed: ${message}`);
      if (attempt < maxAttempts) { switchToFallback(); await sleep(1500); continue; }
      return { ok: false, error: { code: "timeout" } };
    }
    if (response.status === 429) {
      console.error(`[llm] attempt ${attempt}: 429 (retry-after ${response.retryAfter ?? "?"})`);
      if (attempt < maxAttempts) {
        switchToFallback();
        await sleep(Math.min((response.retryAfter || 2) * 1000, 5_000));
        continue;
      }
      return { ok: false, error: { code: "http", status: 429 } };
    }
    if (response.status === 400 && /response_format/i.test(response.text) && baseBody.response_format) {
      // Some models/versions reject json_object mode — retry once without it.
      console.error(`[llm] attempt ${attempt}: 400 mentions response_format, retrying without it`);
      delete baseBody.response_format;
      continue;
    }
    if (response.status >= 500 || response.status === 401 || response.status === 404) {
      console.error(`[llm] attempt ${attempt}: http ${response.status} ${response.text.slice(0, 200)}`);
      if (attempt < maxAttempts) { switchToFallback(); await sleep(2000); continue; }
      return { ok: false, error: { code: "http", status: response.status } };
    }
    if (response.status !== 200) {
      console.error(`[llm] attempt ${attempt}: http ${response.status} ${response.text.slice(0, 200)}`);
      return { ok: false, error: { code: "http", status: response.status } };
    }
    try {
      const content = readAssistantContent(response.text);
      // The retry path may deliberately disable response_format for models that
      // reject or distort nested JSON. Accept fenced JSON or a short prose wrapper
      // there instead of failing a recoverable second response.
      const data = parseContent(content) as T;
      if (opts?.schema) {
        const parsed = opts.schema.safeParse(data);
        if (!parsed.success) {
          const issues = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join(" | ");
          const logContent = process.env.NODE_ENV === "production" ? JSON.stringify(content).slice(0, 200) : JSON.stringify(content);
          console.error(`[llm] attempt ${attempt}: schema mismatch — top-level keys: ${JSON.stringify(Object.keys(data as object))} — content: ${logContent} — issues: ${issues.slice(0, 600)}`);
          if (attempt < maxAttempts) {
            switchToFallback();
            // Keep JSON mode for repair attempts; shape normalization handles the
            // harmless provider drift, while a lower temperature reduces repeated
            // syntax/shape mistakes. response_format is removed only when the API
            // explicitly rejects that parameter with HTTP 400 above.
            baseBody.temperature = Math.min(Number(baseBody.temperature ?? 0.9), 0.4);
            continue;
          }
          return { ok: false, error: { code: "parse" } };
        }
        return { ok: true, data: parsed.data };
      }
      return { ok: true, data };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[llm] attempt ${attempt}: response parse failed: ${message}`);
      if (attempt < maxAttempts) {
        switchToFallback();
        baseBody.temperature = Math.min(Number(baseBody.temperature ?? 0.9), 0.4);
        await sleep(1500);
        continue;
      }
      return { ok: false, error: { code: "parse" } };
    }
  }
  return { ok: false, error: { code: "parse" } };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
