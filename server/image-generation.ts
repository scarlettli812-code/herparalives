import "server-only";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { getPortrait } from "@/lib/portraits";

const DEFAULT_ENDPOINT = "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation";

type WanPayload = {
  output?: {
    task_id?: string;
    task_status?: "PENDING" | "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELED" | "UNKNOWN";
    choices?: Array<{
      message?: { content?: Array<{ image?: string }> };
    }>;
  };
  request_id?: string;
  code?: string;
  message?: string;
};

function providerFailure(payload: WanPayload | null, status: number): IllustrationResult {
  // Keep provider diagnostics in server logs only: they are useful for telling a
  // regional endpoint mismatch from an unavailable model, but should not expose
  // account details to the browser.
  console.error("[wan] generation failed", {
    status,
    requestId: payload?.request_id,
    code: payload?.code,
    message: payload?.message?.slice(0, 300),
  });
  return { ok: false, code: "provider_error" };
}

const wait = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function asyncImageEndpoint(configuredEndpoint: string): string {
  return configuredEndpoint.replace(
    /\/multimodal-generation\/generation\/?$/,
    "/image-generation/generation",
  );
}

function taskEndpoint(configuredEndpoint: string, taskId: string): string {
  const apiRoot = configuredEndpoint.split("/services/aigc/")[0];
  return `${apiRoot}/tasks/${encodeURIComponent(taskId)}`;
}

export type IllustrationInput = {
  portraitId: number;
  characterName: string;
  chapterTitle: string;
  sceneTitle: string;
  scene: string;
};

export type IllustrationResult =
  | { ok: true; url: string; expiresAt: number; model: string }
  | { ok: false; code: "not_configured" | "reference_missing" | "provider_error" | "invalid_response" };

export function imageGenerationConfigured(): boolean {
  return Boolean(process.env.DASHSCOPE_API_KEY);
}

async function portraitReference(portraitId: number): Promise<string | null> {
  const portrait = getPortrait(portraitId);
  const relativePath = portrait.src.replace(/^\//, "");
  if (!relativePath.startsWith("images/")) return null;

  // Wan may not be able to fetch Vercel preview or overseas CDN URLs from the
  // model's region. Use the bundled, model-only JPEG reference instead: it is
  // roughly 30–45 KB rather than the 2–3 MB display portrait, so Base64 upload
  // remains fast and does not depend on an externally reachable asset host.
  const referencePath = relativePath.replace(/\.png$/i, "-wan-reference.jpg");

  try {
    const data = await readFile(path.join(process.cwd(), "public", referencePath));
    return `data:image/jpeg;base64,${data.toString("base64")}`;
  } catch {
    return null;
  }
}

export async function generateStoryIllustration(input: IllustrationInput): Promise<IllustrationResult> {
  if (!imageGenerationConfigured()) return { ok: false, code: "not_configured" };
  const reference = await portraitReference(input.portraitId);
  if (!reference) return { ok: false, code: "reference_missing" };

  const model = process.env.WAN_IMAGE_MODEL || "wan2.7-image-pro";
  const prompt = [
    "以输入人物立绘为唯一角色外观参考，保持脸型、发型、年龄感和服装主色一致。",
    "创作一张横向 16:9 的当代女性互动故事关键场景插画；手绘编辑插画风，克制、真实、柔和电影光影，不要照片感。",
    `主角：${input.characterName}。章节：${input.chapterTitle}。场景：${input.sceneTitle}。`,
    `实时剧情：${input.scene.slice(0, 700)}`,
    "突出人物正在面对的具体环境、行动和情绪张力；不要添加文字、标题、标志、水印，也不要改变人物身份。",
  ].join("\n");

  const configuredEndpoint = process.env.DASHSCOPE_IMAGE_ENDPOINT || DEFAULT_ENDPOINT;
  const headers = {
    "content-type": "application/json",
    authorization: `Bearer ${process.env.DASHSCOPE_API_KEY}`,
  };
  const requestBody = JSON.stringify({
    model,
    input: {
      messages: [{ role: "user", content: [{ image: reference }, { text: prompt }] }],
    },
    // The prompt already fixes the subject, scene, and style. Wan's additional
    // reasoning is not needed for this single chapter illustration.
    parameters: { n: 1, size: "1280*720", watermark: false, thinking_mode: false },
  });

  // Wan image editing can take several minutes. Submit an asynchronous task so
  // a single upstream connection is not held open until it times out, then poll
  // the official task endpoint with increasingly relaxed intervals.
  const submitted = await fetch(asyncImageEndpoint(configuredEndpoint), {
    method: "POST",
    headers: {
      ...headers,
      "X-DashScope-Async": "enable",
    },
    body: requestBody,
    signal: AbortSignal.timeout(30_000),
  }).catch(() => null);
  if (!submitted) return providerFailure(null, 0);

  let payload = await submitted.json() as WanPayload;
  if (!submitted.ok) return providerFailure(payload, submitted.status);
  const taskId = payload.output?.task_id;
  if (!taskId) return providerFailure(payload, submitted.status);

  const startedAt = Date.now();
  const deadline = startedAt + 210_000;
  while (Date.now() < deadline) {
    await wait(Date.now() - startedAt < 30_000 ? 3_000 : 8_000);
    const polled = await fetch(taskEndpoint(configuredEndpoint, taskId), {
      headers: { authorization: headers.authorization },
      signal: AbortSignal.timeout(20_000),
    }).catch(() => null);
    if (!polled) continue;
    payload = await polled.json() as WanPayload;
    if (!polled.ok) return providerFailure(payload, polled.status);

    const status = payload.output?.task_status;
    if (status === "FAILED" || status === "CANCELED" || status === "UNKNOWN") {
      return providerFailure(payload, polled.status);
    }
    if (status !== "SUCCEEDED") continue;

    const url = payload.output?.choices?.[0]?.message?.content?.find((item) => item.image)?.image;
    if (!url) {
      console.error("[wan] response did not contain an image", {
        status: polled.status,
        requestId: payload.request_id,
        code: payload.code,
        message: payload.message?.slice(0, 300),
      });
      return { ok: false, code: "invalid_response" };
    }
    // DashScope result URLs are temporary. Guest runs already expire after 24h,
    // so the visual has the same lifetime and is regenerated if it expires first.
    return { ok: true, url, expiresAt: Date.now() + 23 * 60 * 60 * 1000, model };
  }

  return providerFailure({ code: "PollingTimeout", message: "Wan task did not finish within 210 seconds" }, 408);
}
