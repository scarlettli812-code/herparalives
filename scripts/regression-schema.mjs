// Regression test for harmless qwen-plus JSON shape drift observed in production.
// Starts the built app and mock provider, then verifies a continuation remains a
// real Bailian chapter after deltas/evidence normalization.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = process.cwd();
const APP_PORT = 3100;
const MOCK_PORT = 8787;
const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
const fixture = (name) => JSON.parse(readFileSync(resolve(ROOT, "scripts", "fixtures", name), "utf8"));
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

function start(command, args, env = {}) {
  const child = spawn(command, args, {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr.on("data", (chunk) => process.stderr.write(chunk));
  return child;
}

async function waitFor(url) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {}
    await sleep(250);
  }
  throw new Error(`service did not become ready: ${url}`);
}

const mock = start(process.execPath, ["scripts/mock-dashscope.mjs", String(MOCK_PORT)]);
const app = start("./node_modules/.bin/next", ["start", "-H", "127.0.0.1", "-p", String(APP_PORT)], {
  LLM_BASE_URL: `http://127.0.0.1:${MOCK_PORT}/v1`,
  DASHSCOPE_API_KEY: "mock",
  QWEN_STORY_MODEL: "qwen-plus",
  QWEN_STRUCTURED_MODEL: "qwen-plus",
});

try {
  await Promise.all([
    waitFor(`http://127.0.0.1:${MOCK_PORT}/v1/models`),
    waitFor(`http://127.0.0.1:${APP_PORT}/lobby`),
  ]);

  const season = fixture("season.json");
  const lastNode = season.nodes[0];
  const choice = lastNode.choices[0];
  const effects = [
    { domain: "career", to: "已接受新机会", consequence: "第二章必须写出职业后果" },
    { domain: "selfFulfillment", to: "主动承担选择", consequence: "她会明确回想自己的决定" },
  ];
  const event = {
    id: "event-regression-1",
    sourceNodeId: lastNode.id,
    sourceChoiceId: choice.id,
    sourceChapter: 1,
    choiceLabel: choice.label,
    effects,
    expectedConsequence: "第二章必须明确承接这个决定",
    dueByChapter: 2,
    status: "pending",
  };
  const response = await fetch(`http://127.0.0.1:${APP_PORT}/api/chapters/generate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      character: {
        id: "schema-regression",
        name: "若岚",
        portrait: 0,
        background: "六年外贸跟单经历，部门裁撤后正在寻找新的职业方向。",
        goal: "找到可持续且保留自主权的职业道路",
        resources: ["行业经验", "客户关系"],
        dilemma: "稳定收入与职业成长难以兼得",
        isCustom: true,
        promptConstraints: [],
      },
      plan: season.plan,
      targetChapter: 2,
      memory: [{
        nodeId: lastNode.id,
        sourceChapter: 1,
        choiceId: choice.id,
        choiceLabel: choice.label,
        memory: choice.memory,
        deltas: choice.deltas,
        eventId: event.id,
        effects,
        expectedConsequence: event.expectedConsequence,
        dueByChapter: 2,
        at: Date.now(),
      }],
      lastNode,
      story: [lastNode],
      eventLedger: [event],
      storyState: {
        career: "正在寻找新方向",
        economy: "现金流紧张",
        relationship: "保有行业联系",
        selfFulfillment: "希望掌握主动权",
      },
    }),
  });
  const data = await response.json();
  assert(response.status === 200, `expected HTTP 200, received ${response.status}`);
  assert(data.provider === "bailian", `expected Bailian chapter, received ${data.provider}: ${data.fallbackReason ?? ""}`);
  assert(data.callbacks?.every((callback) => typeof callback.evidence === "string"), "callback evidence was not normalized to strings");
  const deltas = data.story.flatMap((node) => node.choices ?? []).map((item) => item.deltas);
  assert(deltas.length > 0, "generated chapter has no decisions");
  assert(deltas.every((item) => !("economy" in item)), "unknown delta keys were not removed");
  assert(deltas.every((item) => Object.values(item).every((value) => typeof value === "number")), "delta values were not normalized to numbers");

  const contradictionEvent = {
    ...event,
    id: "event-route-contradiction",
    choiceLabel: "TEST_ROUTE_CONTRADICTION：不提交PPT",
  };
  const contradictionResponse = await fetch(`http://127.0.0.1:${APP_PORT}/api/chapters/generate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      character: {
        id: "route-regression",
        name: "若岚",
        portrait: 0,
        background: "六年外贸跟单经历，部门裁撤后正在寻找新的职业方向。",
        goal: "找到可持续且保留自主权的职业道路",
        resources: ["行业经验", "客户关系"],
        dilemma: "稳定收入与职业成长难以兼得",
        isCustom: true,
        promptConstraints: [],
      },
      plan: season.plan,
      targetChapter: 2,
      memory: [{
        nodeId: lastNode.id,
        sourceChapter: 1,
        choiceId: choice.id,
        choiceLabel: contradictionEvent.choiceLabel,
        memory: "她决定不提交PPT，并承担由此产生的职业后果。",
        deltas: choice.deltas,
        eventId: contradictionEvent.id,
        effects,
        expectedConsequence: contradictionEvent.expectedConsequence,
        dueByChapter: 2,
        at: Date.now(),
      }],
      lastNode,
      story: [lastNode],
      eventLedger: [contradictionEvent],
      storyState: {
        career: "已经决定不提交PPT",
        economy: "现金流紧张",
        relationship: "保有行业联系",
        selfFulfillment: "愿意承担拒绝提交的后果",
      },
    }),
  });
  const contradictionData = await contradictionResponse.json();
  assert(contradictionData.provider === "safe-template", "an explicit A/B route contradiction was not blocked");
  assert(contradictionData.fallbackReason?.includes("已经做出的选择"), "route contradiction fallback reason was not user-facing");
  console.log("CONTINUITY REGRESSION PASSED: metadata drift is repaired and explicit A/B branch switching is blocked");
} finally {
  app.kill("SIGTERM");
  mock.kill("SIGTERM");
}
