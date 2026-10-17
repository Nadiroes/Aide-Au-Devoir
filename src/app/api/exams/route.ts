// /api/exams
// GET  → list exams (DTO with counters)
// POST → import an exam: JSON { rawText, title?, provider? } or multipart
//        { file, title? } (PDF/DOCX/TXT/MD/images/audio/EPUB — same extraction
//        pipeline as the courses). Creates the exam; questions are structured
//        afterwards by POST /api/exams/[id]/parse (the 📋 Examinateur).

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { extractText, kindFromFileName } from "@/lib/ingestion";
import { titleFromRawText } from "@/lib/exam";
import { toExamDTO } from "@/lib/exam-dto";
import type { ProviderId } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_RAW = 200_000; // ~200k chars of exam text

export async function GET() {
  const rows = await db.exam.findMany({
    include: { questions: { select: { answer: true } } },
    orderBy: { createdAt: "desc" },
  });
  const exams = rows.map((r) => toExamDTO(r));
  return NextResponse.json({ exams });
}

export async function POST(req: NextRequest) {
  const contentType = req.headers.get("content-type") ?? "";
  let rawText = "";
  let fileName: string | null = null;
  let title: string | null = null;
  let provider: ProviderId = "zai";

  try {
    if (contentType.includes("multipart/form-data")) {
      const form = await req.formData();
      const file = form.get("file");
      title = (form.get("title") as string | null)?.trim() || null;
      const p = (form.get("provider") as string | null) ?? "zai";
      if (p === "mistral" || p === "agnes") provider = p;
      if (!(file instanceof File)) {
        return NextResponse.json({ message: "Fichier manquant." }, { status: 400 });
      }
      const kind = kindFromFileName(file.name);
      if (!kind) {
        return NextResponse.json(
          { message: `Format non supporté : ${file.name}. Astuce : collez le texte directement.` },
          { status: 400 }
        );
      }
      const buffer = Buffer.from(await file.arrayBuffer());
      const extracted = await extractText(file.name, buffer);
      rawText = extracted.text;
      fileName = file.name;
    } else {
      const body = (await req.json().catch(() => null)) as {
        rawText?: string;
        title?: string;
        provider?: string;
      } | null;
      rawText = String(body?.rawText ?? "").trim();
      title = body?.title?.trim() || null;
      if (body?.provider === "mistral" || body?.provider === "agnes") provider = body.provider;
    }
  } catch (err) {
    return NextResponse.json(
      {
        message:
          err instanceof Error
            ? `Lecture impossible : ${err.message}`
            : "Lecture du fichier impossible.",
      },
      { status: 400 }
    );
  }

  rawText = rawText.slice(0, MAX_RAW);
  if (rawText.replace(/\s/g, "").length < 20) {
    return NextResponse.json(
      { message: "Le texte de l'examen est trop court (20 caractères minimum)." },
      { status: 400 }
    );
  }

  const created = await db.exam.create({
    data: {
      title: title || titleFromRawText(rawText, fileName),
      rawText,
      fileName,
      kind: "mixte",
      linkStatus: "pending",
      documentIds: "[]",
      theology: false,
    },
  });

  return NextResponse.json({ exam: toExamDTO(created) });
}
