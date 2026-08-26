import { NextResponse } from "next/server";
import { generateStoryIllustration } from "@/server/image-generation";

export const maxDuration = 300;

type Body = {
  portraitId?: number;
  characterName?: string;
  chapterTitle?: string;
  sceneTitle?: string;
  scene?: string;
};

export async function POST(request: Request) {
  const body = await request.json() as Body;
  if (!Number.isInteger(body.portraitId) || !body.characterName || !body.chapterTitle || !body.sceneTitle || !body.scene) {
    return NextResponse.json({ error: "invalid_illustration_input" }, { status: 400 });
  }
  const result = await generateStoryIllustration({
    portraitId: body.portraitId as number,
    characterName: body.characterName.slice(0, 20),
    chapterTitle: body.chapterTitle.slice(0, 80),
    sceneTitle: body.sceneTitle.slice(0, 80),
    scene: body.scene.slice(0, 3000),
  });
  if (!result.ok) {
    const status = result.code === "not_configured" ? 503 : 502;
    return NextResponse.json({ error: result.code }, { status });
  }
  return NextResponse.json({ provider: "wan", url: result.url, expiresAt: result.expiresAt, model: result.model });
}
