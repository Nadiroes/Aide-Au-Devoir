// POST /api/tts — Text-To-Speech (WAV audio). Backend-only SDK usage.
// body: TtsRequestBody { text, voice?, speed?, language? }

import { NextRequest, NextResponse } from "next/server";
import { synthesizeSpeech } from "@/lib/tts";
import type { DocLanguage, TtsRequestBody } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_INPUT = 9000; // hard guard; server slices to 900 chars before synthesis

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as TtsRequestBody | null;

  const text = String(body?.text ?? "");
  if (!text.trim()) {
    return NextResponse.json({ message: "Aucun texte à lire à voix haute." }, { status: 400 });
  }

  const language: DocLanguage = body?.language === "en" ? "en" : "fr";
  const speed = typeof body?.speed === "number" ? body.speed : undefined;

  try {
    const { buffer } = await synthesizeSpeech(text.slice(0, MAX_INPUT), {
      voice: body?.voice ? String(body.voice) : undefined,
      speed,
      language,
    });
    return new NextResponse(new Uint8Array(buffer), {
      headers: {
        "Content-Type": "audio/wav",
        "Content-Length": String(buffer.byteLength),
        "Cache-Control": "private, max-age=86400",
      },
    });
  } catch (err) {
    console.error("[tts] synthesis failed:", err);
    return NextResponse.json(
      { message: err instanceof Error ? err.message : "Synthèse vocale indisponible." },
      { status: 500 }
    );
  }
}
