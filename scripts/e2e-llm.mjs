// Full-chain E2E for LLM story generation, driven against the local dev server.
//
// Setup:
//   Terminal 1: node scripts/mock-dashscope.mjs
//   Terminal 2: LLM_BASE_URL=http://127.0.0.1:8787/v1 DASHSCOPE_API_KEY=mock pnpm dev
//   Terminal 3: node scripts/e2e-llm.mjs
//
// The script spawns its own mock server on port 8787, so Terminal 1 is optional —
// but it will restart the mock mid-run to exercise the failure/retry path.
//
// Requires puppeteer-core; install outside the repo and point PUPPETEER_CORE_PATH at it,
// or set PUPPETEER_EXECUTABLE_PATH to a Chrome binary.
import { createRequire } from "node:module";
import { spawn } from "node:child_process";

const require = createRequire(import.meta.url);
const puppeteer = (() => {
  try { return require("puppeteer-core"); } catch {}
  const path = process.env.PUPPETEER_CORE_PATH;
  if (!path) throw new Error("puppeteer-core not found — install it and set PUPPETEER_CORE_PATH");
  return require(path);
})();

const BASE = "http://localhost:3000";
const MOCK_PORT = 8787;
const CHROME = process.env.PUPPETEER_EXECUTABLE_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const assert = (condition, message) => { if (!condition) throw new Error(`ASSERT FAILED: ${message}`); };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const mock = {
  child: null,
  spawn() {
    this.child = spawn("node", ["scripts/mock-dashscope.mjs", String(MOCK_PORT)], { cwd: process.cwd() });
    this.child.stdout.on("data", () => {});
  },
  async waitUp() {
    for (let i = 0; i < 50; i += 1) {
      try { const res = await fetch(`http://127.0.0.1:${MOCK_PORT}/v1/models`); if (res.ok) return; } catch {}
      await sleep(200);
    }
    throw new Error("mock server did not come up");
  },
  kill() { if (this.child) { this.child.kill("SIGKILL"); this.child = null; } },
};

const log = (message) => console.log(`[e2e] ${message}`);

// Each mock chapter mixes decision nodes (choices) with pure narration nodes.
// Picks choices when present, otherwise advances straight through. Returns the
// final button label — "生成下一章，继续故事" mid-season or "听听 Life Coach 的
// 旅途回望" at the end (chapter-ending nodes may be choice-less).
async function reachDecision(page, chapterLabel) {
  for (let step = 0; step < 4; step += 1) {
    const hasChoices = await page.$(".choices button");
    if (hasChoices) {
      await page.click(".choices button");
      await page.waitForSelector("#choice-outcome");
    }
    const label = await page.$eval(".story-continue", (button) => button.textContent.trim());
    if (label === "生成下一章，继续故事" || label === "听听 Life Coach 的旅途回望") return label;
    if (label !== "继续下一幕") throw new Error(`unexpected button label "${label}" (${chapterLabel})`);
    const sceneBefore = await page.$eval(".scene-count", (el) => el.textContent);
    await page.click(".story-continue");
    await page.waitForFunction(
      (prev, chapter) => document.querySelector(".scene-count")?.textContent !== prev
        && document.querySelector(".scene-count")?.textContent?.includes(chapter),
      { timeout: 30000 },
      sceneBefore,
      chapterLabel,
    );
  }
  throw new Error(`never reached a decision for ${chapterLabel}`);
}

async function main() {
  log(`checking dev server at ${BASE} ...`);
  const probe = await fetch(`${BASE}/lobby`).then((r) => r.status).catch(() => 0);
  assert(probe === 200, `dev server not reachable (got ${probe}) — start it with LLM_BASE_URL + DASHSCOPE_API_KEY=mock`);

  mock.spawn();
  await mock.waitUp();
  log("mock dashscope up");

  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox"] });
  const page = await browser.newPage();
  page.setDefaultTimeout(45000);
  let chapterRequests = 0;
  page.on("request", (request) => { if (request.url().includes("/api/chapters/generate")) chapterRequests += 1; });

  try {
    // ---- create ----
    log("create: fill form and submit");
    await page.goto(`${BASE}/create`, { waitUntil: "networkidle0" });
    // Short input must stay visibly blocked (button disabled + hint), not silently dead.
    await page.type("textarea.field.textarea", "被裁");
    const blocked = await page.$eval("button.primary.dark-button.full", (button) => button.disabled);
    assert(blocked, "generate button should be disabled below 4 chars");
    const hint = await page.$$eval(".form-error", (els) => els.some((el) => el.textContent.includes("至少 4 个字")));
    assert(hint, "short-input hint not shown");
    await page.focus("textarea.field.textarea");
    await page.keyboard.down("Meta"); await page.keyboard.press("KeyA"); await page.keyboard.up("Meta");
    await page.keyboard.press("Backspace");
    await page.type("textarea.field.textarea", "我最近被裁员了，投递了很多简历都没有回音，存款只够撑四个月，很焦虑，不知道该继续找同类工作还是换方向。");
    const enabled = await page.$eval("button.primary.dark-button.full", (button) => !button.disabled);
    assert(enabled, "generate button should be enabled at 4+ chars");
    await page.click("button.primary.dark-button.full");
    await page.waitForFunction(() => location.pathname.startsWith("/prepare"), { timeout: 30000 });
    log("create OK → prepare");

    // ---- prepare ----
    log("prepare: wait for ready state");
    await page.waitForFunction(() => document.body.textContent.includes("第一章已经准备好"), { timeout: 30000 });
    const readyLink = await page.$('a[href^="/play/"]');
    assert(readyLink, "prepare ready link missing");
    log("prepare OK");

    // ---- play, chapter 1 ----
    await Promise.all([page.waitForFunction(() => location.pathname.startsWith("/play/")), readyLink.click()]);
    await page.waitForFunction(() => document.querySelector(".scene-count")?.textContent?.includes("CHAPTER 1"), { timeout: 30000 });
    const dotCount = await page.$$eval(".chapter-progress i", (dots) => dots.length);
    assert(dotCount === 5, `expected 5 chapter-progress dots, got ${dotCount}`);
    const activeDots = await page.$$eval(".chapter-progress i.active", (dots) => dots.length);
    assert(activeDots === 1, `expected 1 active dot, got ${activeDots}`);
    const artCaption = await page.$eval(".scene-art small", (el) => el.textContent);
    assert(artCaption.includes("所选角色立绘"), `unexpected custom-story art caption: ${artCaption}`);
    log("play: CHAPTER 1 renders with stable selected portrait and 5-dot progress");

    // ---- provider failure: mock down before chapter-1 ends ----
    // A provider outage must no longer strand the player at the chapter boundary.
    // The route returns a transparent, causally-grounded safe chapter instead.
    log("provider failure: kill mock before chapter-1 ends, expect safe chapter");
    await page.click(".choices button");
    await page.waitForSelector("#choice-outcome");
    const firstLabel = await page.$eval(".story-continue", (button) => button.textContent.trim());
    assert(firstLabel === "继续下一幕", `expected 继续下一幕 label, got "${firstLabel}"`);
    mock.kill();
    await page.click(".story-continue"); // enter final node — prefetch fires and fails fast
    await page.waitForSelector(".choices button");
    await page.click(".choices button"); // chapter-final choice
    await page.waitForSelector("#choice-outcome");
    const chapter1Label = await page.$eval(".story-continue", (button) => button.textContent.trim());
    assert(chapter1Label === "生成下一章，继续故事", `expected generate label, got "${chapter1Label}"`);
    await page.click(".story-continue");
    await page.waitForFunction(() => document.querySelector(".scene-count")?.textContent?.includes("CHAPTER 2"), { timeout: 30000 });
    await page.waitForSelector(".chapter-fallback-note", { timeout: 30000 });
    const realized = await page.evaluate(() => {
      const runs = JSON.parse(localStorage.getItem("parallel-her:runs") || "[]");
      return runs[0]?.eventLedger?.some((event) => event.status === "realized");
    });
    assert(realized, "safe chapter did not realize any pending causal event");
    log("safe chapter OK (provider failure did not block chapter 2)");

    // ---- provider recovery ----
    log("restart mock for later chapters");
    mock.spawn();
    await mock.waitUp();
    assert(chapterRequests >= 1, "no POST /api/chapters/generate captured");
    log(`provider recovered after ${chapterRequests} chapter request(s)`);

    // ---- chapters 2 → 5 ----
    for (const chapter of [2, 3, 4]) {
      const label = await reachDecision(page, `CHAPTER ${chapter}`);
      assert(label === "生成下一章，继续故事", `expected generate label at chapter ${chapter}, got "${label}"`);
      await page.click(".story-continue");
      await page.waitForFunction(
        (next) => document.querySelector(".scene-count")?.textContent?.includes(next),
        { timeout: 30000 },
        `CHAPTER ${chapter + 1}`,
      );
      log(`CHAPTER ${chapter + 1} OK`);
    }

    // ---- final chapter → ending ----
    const finalDots = await page.$$eval(".chapter-progress i.active", (dots) => dots.length);
    assert(finalDots === 5, `expected 5 active dots at final chapter, got ${finalDots}`);
    const finalLabel = await reachDecision(page, "CHAPTER 5");
    assert(finalLabel === "听听 Life Coach 的旅途回望", `expected ending label, got "${finalLabel}"`);
    await page.click(".story-continue");
    await page.waitForFunction(() => location.pathname.startsWith("/ending"), { timeout: 30000 });
    log("ending reached — full chain OK");

    console.log("\nE2E PASSED");
  } finally {
    await browser.close();
    mock.kill();
  }
}

main().catch((error) => { console.error(`\nE2E FAILED: ${error.message}`); process.exit(1); });
