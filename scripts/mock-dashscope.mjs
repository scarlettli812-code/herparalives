// Mock DashScope OpenAI-compatible endpoint for local E2E verification.
// Usage: node scripts/mock-dashscope.mjs [port]
// The dev server points text generation at this process:
// LLM_BASE_URL=http://127.0.0.1:8787/v1
// DASHSCOPE_API_KEY=mock
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const port = Number(process.argv[2] || 8787);
const delay = Number(process.env.MOCK_DELAY_MS || 0);
const root = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const fixture = (name) => JSON.parse(readFileSync(join(root, name), "utf8"));

const CHARACTER = fixture("character.json");
const SEASON = fixture("season.json");
const CHAPTER_2 = fixture("chapter-2.json");

const addCausality = (payload) => {
  const copy = JSON.parse(JSON.stringify(payload));
  const nodes = copy.nodes ?? copy.story ?? [];
  for (const node of nodes) {
    for (const choice of node.choices ?? []) {
      choice.effects ??= [
        { domain: "career", to: `已选择「${choice.label}」`, consequence: choice.memory },
        { domain: "selfFulfillment", to: `正在承担「${choice.cost}」`, consequence: choice.outcome.slice(-60) },
      ];
      choice.pathType ??= "branch";
      choice.expectedConsequence ??= choice.memory;
      choice.consequenceDueInChapters ??= 1;
    }
  }
  return copy;
};

// Reproduce harmless format drift observed in real qwen-plus continuation
// responses. The production parser should normalize these fields without
// downgrading an otherwise valid chapter to the safe template.
const addProviderShapeDrift = (payload) => {
  const copy = JSON.parse(JSON.stringify(payload));
  for (const node of copy.story ?? []) {
    for (const choice of node.choices ?? []) {
      choice.deltas = Object.fromEntries(
        Object.entries(choice.deltas ?? {}).map(([key, value]) => [key, String(value)]),
      );
      choice.deltas.economy = "1";
    }
  }
  for (const callback of copy.callbacks ?? []) {
    // This intentionally paraphrases rather than copying the prose. The old
    // validator discarded the whole chapter here; the route audit must recover
    // real evidence without treating this technical field as a story failure.
    callback.evidence = [{ quote: `事件 ${callback.eventId} 已经在本章以另一种说法产生影响` }];
  }
  return copy;
};

const pendingEventsFromPrompt = (user) => {
  const match = user.match(/因果事件账本[^：]*：\n([\s\S]*?)\n\n请输出 JSON/);
  if (!match) return [];
  try {
    return JSON.parse(match[1]).filter((event) => event.status === "pending");
  } catch {
    return [];
  }
};

const auditPayload = (user) => {
  const eventMatch = user.match(/待兑现事件：\n([\s\S]*?)\n\n需要检查的新章节：/);
  const storyMatch = user.match(/需要检查的新章节：\n([\s\S]*?)\n\n输出：/);
  let events = [];
  let story = [];
  try { events = eventMatch ? JSON.parse(eventMatch[1]) : []; } catch {}
  try { story = storyMatch ? JSON.parse(storyMatch[1]) : []; } catch {}
  const evidence = story[0]?.scene?.slice(0, 80) ?? "";
  if (user.includes("TEST_ROUTE_CONTRADICTION")) {
    const contradiction = "她按未选择的路线提交了PPT。";
    return {
      eventChecks: events.map((event) => ({ eventId: event.id, status: "contradicted", evidence: contradiction, reason: "正文写成了未选择的提交路线" })),
      routeViolations: [{ type: "unchosen_branch", evidence: contradiction, reason: "玩家没有选择提交PPT，正文却写成已经提交" }],
      choiceDepth: "substantive",
      progressionNote: "选项涉及现实代价",
    };
  }
  return {
    eventChecks: events.map((event) => ({ eventId: event.id, status: "realized", evidence, reason: "选择已经通过本章行动产生后果" })),
    routeViolations: [],
    choiceDepth: "substantive",
    progressionNote: "选项继续深化价值取舍",
  };
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const send = (status, body) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (req.method === "GET" && url.pathname === "/v1/models") {
    return send(200, { object: "list", data: [{ id: "qwen-mock", object: "model" }] });
  }
  if (req.method !== "POST" || url.pathname !== "/v1/chat/completions") {
    return send(404, { error: { message: "not found" } });
  }
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw);
  const user = body.messages?.find((message) => message.role === "user")?.content ?? "";
  let fixtureContent;
  if (user.includes("【因果审校任务】")) fixtureContent = auditPayload(user);
  else if (user.includes("用户的处境原文")) fixtureContent = CHARACTER;
  else if (user.includes("整季大纲")) {
    // Chapter continuation: remap the chapter-2 fixture to the requested chapter
    // number so the same shape serves chapters 2..5. The route itself forces
    // chapterEnd and endsStory on the last node.
    const match = user.match(/第\s*(\d+)\s*章的节点/);
    const chapter = match ? Number(match[1]) : 2;
    fixtureContent = addCausality(JSON.parse(JSON.stringify(CHAPTER_2), (key, value) => (key === "chapter" ? chapter : value)));
    if (user.includes("TEST_ROUTE_CONTRADICTION")) {
      fixtureContent.story[0].scene = `她按未选择的路线提交了PPT。${fixtureContent.story[0].scene}`;
    }
    const evidence = fixtureContent.story[0].scene.slice(0, 28);
    fixtureContent.callbacks = pendingEventsFromPrompt(user).slice(0, 6).map((event) => ({ eventId: event.id, evidence }));
    fixtureContent = addProviderShapeDrift(fixtureContent);
  } else fixtureContent = addCausality(SEASON);
  if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
  const content = JSON.stringify(fixtureContent);
  if (body.stream) {
    res.writeHead(200, { "content-type": "text/event-stream" });
    const midpoint = Math.ceil(content.length / 2);
    for (const chunk of [content.slice(0, midpoint), content.slice(midpoint)]) {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: chunk } }] })}\n\n`);
    }
    res.end("data: [DONE]\n\n");
    return;
  }
  send(200, { choices: [{ message: { role: "assistant", content } }] });
});

server.listen(port, () => console.log(`mock dashscope listening on http://127.0.0.1:${port}/v1`));
