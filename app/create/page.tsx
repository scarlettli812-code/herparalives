"use client";

import { AppHeader } from "@/components/AppHeader";
import { Portrait } from "@/components/Portrait";
import { creationPortraits } from "@/lib/portraits";
import { createCustomRun } from "@/lib/store";
import type { StoryPreferences } from "@/lib/types";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

const preferenceConfig: Array<{ key: keyof StoryPreferences; label: string; low: string; high: string }> = [
  { key: "difficulty", label: "选择难度", low: "留有余地", high: "艰难取舍" },
  { key: "conflict", label: "冲突强度", low: "温和推进", high: "张力更强" },
  { key: "drama", label: "戏剧程度", low: "日常克制", high: "更多转折" },
  { key: "realism", label: "现实质感", low: "轻盈想象", high: "真实平实" },
];

export default function CreatePage() {
  const router = useRouter();
  const [portrait, setPortrait] = useState(0);
  const [name, setName] = useState("");
  const [situation, setSituation] = useState("");
  const [preferences, setPreferences] = useState<StoryPreferences>({ difficulty: 3, conflict: 3, drama: 2, realism: 4 });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = async () => {
    if (situation.trim().length < 4) return;
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/characters/generate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: name.trim(), portrait, situation, preferences }),
      });
      const result = await response.json();
      if (!response.ok) { setError(result.message || result.error || "暂时无法生成角色卡"); return; }
      const run = createCustomRun({ id: crypto.randomUUID(), ...result.card, isCustom: true });
      setSituation(""); router.push(`/prepare?run=${run.id}`);
    } catch { setError("网络暂时不可用，请稍后再试。"); } finally { setBusy(false); }
  };

  return <main><AppHeader />
    <section className="play-mode-head">
      <div className="play-mode-wrap">
        <p className="eyebrow dark">CHOOSE HOW TO BEGIN</p>
        <h1>这一段平行人生，想从哪里开始？</h1>
        <div className="play-mode-grid">
          <article className="active"><span>01 · 我的故事</span><h2>描述我的处境</h2><p>AI 将现实经历脱敏为虚构角色，并按照你选择的故事风格编织后续人生。</p><a href="#custom-story">生成我的平行人生 ↓</a></article>
          <article><span>02 · 她们的故事</span><h2>体验另一位女性的人生</h2><p>进入经本人授权与团队审核的故事库。未来也可以邀请公众女性分享一段被虚构改编的人生经历。</p><Link href="/lobby#stories">浏览女性故事库 →</Link></article>
        </div>
      </div>
    </section>
    <section className="create-layout" id="custom-story"><div>
      <p className="eyebrow dark">CREATE YOUR PARALLEL SELF</p><h2>她像你，但不等于你</h2>
      <p className="muted">你输入的现实处境只用于生成脱敏角色卡，不保存原文。故事中的人物、事件和未来均为虚构。</p>
      <h3 className="step-title"><span>1</span>选择她的形象</h3>
      <div className="portrait-picker">{creationPortraits.map((item, index) => <button type="button" aria-label={`选择形象 ${index + 1}`} className={portrait === item.id ? "selected" : ""} onClick={() => setPortrait(item.id)} key={item.id}><Portrait id={item.id} size="small" /></button>)}</div>
      <h3 className="step-title"><span>2</span>给她一个名字</h3>
      <input className="field" value={name} onChange={(event) => setName(event.target.value)} placeholder="留空则由 AI 命名" />
      <h3 className="step-title"><span>3</span>描述她此刻的处境</h3>
      <textarea className="field textarea" maxLength={500} value={situation} onChange={(event) => setSituation(event.target.value)} placeholder="例如：28岁，最近被裁员，投递工作没有回音。过去事业和感情都很顺利，现在有些焦虑……" />
      <div className="field-foot"><span>请勿填写姓名、地址、公司等可识别信息</span><span>{situation.length}/500</span></div>
      <h3 className="step-title"><span>4</span>调整这段故事的气质</h3>
      <p className="preference-note">这些选择会转化为故事生成约束，不代表人生难易，也不会制造“正确答案”。</p>
      <div className="story-sliders">{preferenceConfig.map((item) => <label key={item.key}><div><b>{item.label}</b><output>{preferences[item.key]}/5</output></div><input type="range" min="1" max="5" step="1" value={preferences[item.key]} onChange={(event) => setPreferences({ ...preferences, [item.key]: Number(event.target.value) })} /><small><span>{item.low}</span><span>{item.high}</span></small></label>)}</div>
      {error && <p className="form-error">{error}</p>}
      {!error && situation.trim().length > 0 && situation.trim().length < 4 && <p className="form-error">再写几笔，至少 4 个字就能生成角色卡</p>}
      <button disabled={situation.trim().length < 4 || busy} onClick={submit} className="primary dark-button full">{busy ? "正在生成脱敏角色卡…" : "生成我的平行角色"}</button>
    </div><aside className="character-preview"><Portrait id={portrait} /><div><small>即将成为</small><h3>{name || "未命名的她"}</h3><p>{situation ? "她的故事将从一个真实但已被改写的困境开始。" : "选择形象、写下处境，再决定故事的气质。"}</p><div className="preference-chips"><span>难度 {preferences.difficulty}</span><span>冲突 {preferences.conflict}</span><span>戏剧 {preferences.drama}</span><span>真实 {preferences.realism}</span></div></div></aside></section>
  </main>;
}
