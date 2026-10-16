// POST /api/asr — Automatic Speech Recognition (multipart/form-data, field "audio").
// Returns { text } — the transcription. Backend-only SDK usage.

import { NextRequest, NextResponse } from "next/server";
import { getZaiClient } from "@/lib/tts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_AUDIO_BYTES = 20 * 1024 * 1024; // 20 MB

function extractText(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (raw && typeof raw === "object") {
    const r = raw as Record<string, unknown>;
    if (typeof r.text === "string") return r.text;
    if (r.data && typeof r.data === "object") {
      const d = r.data as Record<string, unknown>;
      if (typeof d.text === "string") return d.text;
    }
  }
  return "";
}

export async function POST(req: NextRequest) {
  const form = await req.formData().catch(() => null);
  const audio = form?.get("audio");

  if (!(audio instanceof File)) {
    return NextResponse.json(
      { message: "Aucun fichier audio reçu (champ « audio » attendu)." },
      { status: 400 }
    );
  }
  if (audio.size === 0) {
    return NextResponse.json({ message: "Le fichier audio est vide." }, { status: 400 });
  }
  if (audio.size > MAX_AUDIO_BYTES) {
    return NextResponse.json({ message: "Fichier audio trop volumineux (max 20 Mo)." }, { status: 400 });
  }

  try {
    const buffer = Buffer.from(await audio.arrayBuffer());
    const fileBase64 = buffer.toString("base64");
    const zai = await getZaiClient();
    const result: unknown = await zai.audio.asr.create({ file_base64: fileBase64 });
    const text = extractText(result).trim();

    if (!text) {
      return NextResponse.json(
        { message: "Transcription vide — vérifie que l'audio est audible et réessaie." },
        { status: 400 }
      );
    }
    return NextResponse.json({ text });
  } catch (err) {
    console.error("[asr] transcription failed:", err);
    return NextResponse.json(
      {
        message: `Reconnaissance vocale indisponible : ${
          err instanceof Error ? err.message : "erreur inconnue"
        }`,
      },
      { status: 500 }
    );
  }
}
