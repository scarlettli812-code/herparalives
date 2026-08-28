import assert from "node:assert/strict";
import {
  formatOutcomeProse,
  formatSceneProse,
  normalizeStoryProse,
  splitProseParagraphs,
  storyParagraphOptions,
} from "../lib/story-prose.ts";

const collapsedScene = "林婉放下筷子，没有解释下午去了哪里，也没有提答辩材料还没定稿的事。她看着周叙，第一次没有用“忙”或“累”作为缓冲词：“我最近在做一个自己的项目，不是公司任务，是我自己想做的。”话音落下，餐厅安静得能听见冰箱压缩机的嗡鸣。周叙关掉平板屏幕，身体微微后仰，这个姿势她太熟悉了——是他准备进入理性对话模式的前兆。“所以这三个月你频繁晚归、周末消失，不是因为晋升压力？”他问，语气依然平稳，但指尖无意识地摩挲着桌面边缘。林婉点头，补充道：“我需要每周至少两个完整晚上和半天周末投入这件事，短期内无法调整。”她没有说“对不起”，也没有承诺“等忙完就好”，因为她知道那些话一旦出口，就会变成新的债务。周叙沉默了几秒，目光落在她脸上，像是在重新辨认眼前这个人。冲突在此刻具象化了：她要的不是他的许可，而是对一段关系中时间分配规则的重新协商；而他需要的也不是她的道歉，是对这段关系是否还被优先对待的确认。工作手机在包里震动起来，是同事发来的消息。她知道，无论现在回复还是忽略，都是在用行动定义自己刚刚说出的边界究竟有多真实。";
const formattedScene = formatSceneProse(collapsedScene);
const sceneParagraphs = formattedScene.split("\n\n");
assert(sceneParagraphs.length >= 3 && sceneParagraphs.length <= 5, `scene paragraph count: ${sceneParagraphs.length}`);
assert.equal(formattedScene.replace(/\s/gu, ""), collapsedScene.replace(/\s/gu, ""), "scene wording changed");
assert(sceneParagraphs.every((paragraph) => !paragraph.startsWith("”")), "dialogue closing quote was detached");

const existing = "第一段写清现实。\n\n第二段推进人物关系。\n\n第三段把冲突推到选择面前。";
assert.equal(formatSceneProse(existing), existing, "valid existing paragraphs should stay unchanged");

const collapsedOutcome = "她先把手机扣在桌上，向周叙说明今晚不会立刻离开。周叙没有马上同意，只问她愿意固定留下哪两个晚上。她报出具体时间，也承认项目可能因此放慢。两个人都没有得到完美答案，但下一周的安排终于变得可以检验。";
const formattedOutcome = formatOutcomeProse(collapsedOutcome);
const outcomeParagraphs = formattedOutcome.split("\n\n");
assert(outcomeParagraphs.length >= 2 && outcomeParagraphs.length <= 3, `outcome paragraph count: ${outcomeParagraphs.length}`);
assert.equal(formattedOutcome.replace(/\s/gu, ""), collapsedOutcome.replace(/\s/gu, ""), "outcome wording changed");

const normalized = normalizeStoryProse([{ scene: collapsedScene, choices: [{ outcome: collapsedOutcome }] }]);
assert(normalized[0].scene.includes("\n\n"), "story scene was not normalized");
assert(normalized[0].choices[0].outcome.includes("\n\n"), "choice outcome was not normalized");
assert.equal(splitProseParagraphs(collapsedScene, storyParagraphOptions.scene).length, sceneParagraphs.length);

console.log("story prose paragraph regression checks passed");
