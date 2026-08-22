"use client";
import { AppHeader } from "@/components/AppHeader";
import { Portrait } from "@/components/Portrait";
import { getPortrait } from "@/lib/portraits";
import { getRun, saveRun } from "@/lib/store";
import type { GameRun } from "@/lib/types";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

type EndingProfile = { quotes: string[]; observations: { title: string; text: string }[] };

const defaultProfile: EndingProfile = {
  quotes: [
    "稳定不必以无限透支为代价。",
    "你不是在寻找标准答案，而是在辨认自己愿意承担的代价。",
    "接受支持和保留决定权，可以同时发生。",
    "能做到，不等于必须一直这样做。",
  ],
  observations: [
    { title: "我注意到的节奏", text: "面对不确定时，你会先选择一条可以恢复秩序的路。确定感对你很重要，但它并没有让其他可能性失去价值。" },
    { title: "反复出现的张力", text: "你既珍惜关系与承诺，也不愿把决定权交出去。你做的许多选择，都在尝试让支持、稳定和自主不必互相排斥。" },
    { title: "还可以带着走的问题", text: "下一次你又想用“再多做一点”换取安心时，怎样分辨这是你真心选择的投入，还是焦虑正在替你安排生活？" },
  ],
};

const endingProfiles: Record<string, EndingProfile> = {
  // 林澈 · 职业重建
  "test-story": {
    quotes: [
      "稳定不必以无限透支为代价。",
      "你不是在寻找标准答案，而是在辨认自己愿意承担的代价。",
      "接受支持和保留决定权，可以同时发生。",
      "能做到，不等于必须一直这样做。",
    ],
    observations: [
      { title: "我注意到的节奏", text: "面对重新开始，你倾向于先保留可能，再用行动换取判断依据。这为你留下了空间，也让你承担了双份责任。" },
      { title: "反复出现的张力", text: "你既珍惜稳定与承诺，也不愿把决定权交出去。你的许多选择，都在试着让支持、稳定和自主不必互相排斥。" },
      { title: "还可以带着走的问题", text: "下一次你又想用“再多做一点”换取安心时，怎样分辨这是真心投入，还是焦虑在替你安排生活？" },
    ],
  },
  // 安然 · 职业倦怠与间隔期
  "gap-year-anran": {
    quotes: [
      "停下来不会自动给出答案，但会让你重新听见身体的声音。",
      "恢复不是变成另一个人，而是重新与自己建立连接。",
      "你走的每条路，身体都会先告诉你代价。",
      "把退出条件写下来，不是悲观，而是对自己的保护。",
    ],
    observations: [
      { title: "我注意到的节奏", text: "你把自己的身体和恢复当成正式的目标，而不是职业的附属品。当停下时，你没有急着用“做点什么”来消除不安。" },
      { title: "反复出现的张力", text: "你在“守住边界”和“保障现金流”之间反复权衡，也看见透支的感觉总以更体面的名字回来。" },
      { title: "还可以带着走的问题", text: "当身体又一次发紧、失眠、胃痛时，你能不能把它听成信号，而不是继续用忙碌把它压过去？" },
    ],
  },
  // 陆明薇 · 亲密关系与自主边界
  "relationship-lumingwei": {
    quotes: [
      "门可以半开，不用全开，也不用全关。",
      "评估没有错，但它不能替代喜欢。",
      "结束的是关系，不是你的成长。",
      "好的亲密，是两个人都往前试探，也都在往后留一步。",
    ],
    observations: [
      { title: "我注意到的节奏", text: "你在靠近与后退之间反复校准距离。每一次微小的回应或后退，都在重新定义你能接受怎样的亲密。" },
      { title: "反复出现的张力", text: "你习惯先评估再靠近——评估保护过你，也让你很难允许自己在关系里不完全确定。" },
      { title: "还可以带着走的问题", text: "下一次你想后退半步时，先问问自己：我是真的想离开，还是只是害怕靠近？" },
    ],
  },
  // 林晚 · 城市、关系与职业迁移
  "two-cities-linwan": {
    quotes: [
      "城市不是选对就一劳永逸，而是一套可以共同调整的机制。",
      "迁移的代价，不该默认由某一个人承担。",
      "承认代价，不是否定爱，而是对它的尊重。",
      "没有同时到站的列车，也仍能决定怎样同行。",
    ],
    observations: [
      { title: "我注意到的节奏", text: "你把抽象的城市选择，拆成了谁付出、谁承担、什么时候复盘的账目。你很少把爱当成一道一劳永逸的答案。" },
      { title: "反复出现的张力", text: "你在职业方向和共同生活之间反复权衡，也一次次看清：迁移的成本从来不是平均分配的。" },
      { title: "还可以带着走的问题", text: "当迁移的代价又一次落到某个人身上时，你会把它摊到桌面上，还是继续默认那个“更灵活”的人承担？" },
    ],
  },
  // 许知夏 · 深造、稳定与机会成本
  "education-xuzhixia": {
    quotes: [
      "深造不是勇敢测试，留下也不是退缩。",
      "用数据回答，不用情绪回答。",
      "学习不是一次性的投资，而是一个持续的循环。",
      "录取信不是唯一的证书，真正的学习常在课堂之外。",
    ],
    observations: [
      { title: "我注意到的节奏", text: "你不把深造当成勇敢测试，而是一次需要目标、预算和退出条件的投资。做决定前，你总要先拿到一份证据。" },
      { title: "反复出现的张力", text: "你在“系统学习”和“职场实践”之间反复权衡，也在算清哪一条路能让真正的成长落地。" },
      { title: "还可以带着走的问题", text: "当坚持变成硬扛时，你是依据数据调整方向，还是被“已经投入这么多”困住？" },
    ],
  },
};

function resolveEndingProfile(run?: GameRun): EndingProfile {
  if (!run) return defaultProfile;
  const byPreset = run.presetId ? endingProfiles[run.presetId] : undefined;
  return byPreset ?? defaultProfile;
}

function drawWrappedText(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, maxWidth: number, lineHeight: number) {
  const lines: string[] = []; let line = "";
  for (const char of text) { const test = line + char; if (ctx.measureText(test).width > maxWidth && line) { lines.push(line); line = char; } else line = test; }
  if (line) lines.push(line); lines.forEach((item, index) => ctx.fillText(item, x, y + index * lineHeight));
}

export default function EndingPage() {
  const id = String(useParams().runId); const [run, setRun] = useState<GameRun>(); const [quoteIndex, setQuoteIndex] = useState(0); const [saved, setSaved] = useState(false);
  useEffect(() => { const current = getRun(id); setRun(current); if (current?.cardQuote) { const found = resolveEndingProfile(current).quotes.indexOf(current.cardQuote); if (found >= 0) setQuoteIndex(found); setSaved(true); } }, [id]);
  const observations = useMemo(() => {
    if (!run) return [];
    return resolveEndingProfile(run).observations;
  }, [run]);
  if (!run) return <main className="ending-page"><AppHeader compact /><section className="missing-journey"><p className="eyebrow">ROUTE NOT FOUND</p><h1>这条预览线路没有保存在当前浏览器里</h1><p>可能是链接编号有误，或游客存档已经更新。故事内容没有丢失，可以从图鉴打开已有线路，或者重新开始试玩。</p><div><Link href="/collection">打开我的图鉴</Link><Link href="/lobby#sample">重新开始试玩</Link></div></section></main>;
  const profile = resolveEndingProfile(run);
  const quotes = profile.quotes;
  const quote = quotes[quoteIndex];
  const saveCard = () => { const next = { ...run, cardQuote: quote, cardSavedAt: Date.now() }; saveRun(next); setRun(next); setSaved(true); };
  const downloadCard = async () => {
    const canvas = document.createElement("canvas"); canvas.width = 1080; canvas.height = 1440; const ctx = canvas.getContext("2d"); if (!ctx) return;
    const gradient = ctx.createLinearGradient(0, 0, 1080, 1440); gradient.addColorStop(0, "#665677"); gradient.addColorStop(1, "#282842"); ctx.fillStyle = gradient; ctx.fillRect(0, 0, 1080, 1440);
    const image = new Image(); image.src = getPortrait(run.character.portrait).src; await image.decode(); ctx.globalAlpha = .78; ctx.drawImage(image, 500, 530, 580, 910); ctx.globalAlpha = 1;
    ctx.fillStyle = "#efb0a5"; ctx.font = "700 28px Arial"; ctx.fillText("她的平行人生 · LIFE COACH", 80, 105);
    ctx.fillStyle = "#ffffff"; ctx.font = "64px 'Microsoft YaHei'"; drawWrappedText(ctx, quote, 80, 245, 750, 92);
    ctx.fillStyle = "rgba(255,255,255,.72)"; ctx.font = "30px 'Microsoft YaHei'"; ctx.fillText(`${run.character.name}走过的一条平行线路`, 80, 1220); ctx.font = "24px 'Microsoft YaHei'"; ctx.fillText("没有标准答案，只有仍可继续探索的方向。", 80, 1270);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png")); if (!blob) return;
    const url = URL.createObjectURL(blob); const link = document.createElement("a"); link.download = `${run.character.name}-平行人生卡.png`; link.href = url; document.body.appendChild(link); link.click(); link.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return <main className="ending-page"><AppHeader compact /><section className="ending-wrap"><header className="reflection-hero"><p className="eyebrow">A PLACE TO LOOK BACK</p><h1>这条路走到了一个<br />可以回望的站台</h1><p>不是终点，也不是对你的定义。Life Coach 只是把这一路反复出现的选择，重新放到你面前。</p></header>
    <article className="coach-reflection"><p className="eyebrow dark">LIFE COACH · 旅途回望</p><h2>{run.character.name}，我从你的选择里看见了这些</h2><div className="observation-grid">{observations.map((item, index) => <section key={item.title}><span>0{index + 1}</span><h3>{item.title}</h3><p>{item.text}</p></section>)}</div><div className="choice-ribbon"><small>你在这条线路留下的脚印</small><p>{run.choices.map((item) => item.choiceLabel).join(" · ")}</p></div></article>
    <section className="share-studio"><div className="share-copy"><p className="eyebrow dark">MAKE IT YOURS</p><h2>选一句想带走的话</h2><p>这句话不是结论。它只是此刻最想留在你身边的那句提醒。</p><div className="share-controls"><button onClick={() => { setQuoteIndex((quoteIndex + 1) % quotes.length); setSaved(false); }}>换一句</button><button onClick={saveCard}>{saved ? "已保存到图鉴" : "保存到我的图鉴"}</button><button onClick={downloadCard}>下载卡片</button></div></div><div className="journey-card"><div className="journey-card-copy"><small>她的平行人生 · LIFE COACH</small><blockquote>“{quote}”</blockquote><p>{run.character.name}走过的一条平行线路</p></div><Portrait id={run.character.portrait} /></div></section>
    <div className="ending-actions"><Link href={`/map/${id}`}>展开人生地图</Link><Link href="/lobby#sample">再走一条平行线路</Link><Link href="/collection">打开我的图鉴</Link></div></section></main>;
}
