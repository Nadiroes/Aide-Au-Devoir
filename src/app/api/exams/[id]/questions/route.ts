// POST /api/exams/[id]/questions — the student adds a question manually
// (open question or a hand-typed QCM with options). Appended unanswered;
// the UI then calls /solve with the returned questionId to get the answer.

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { toQuestionDTO } from "@/lib/exam-dto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const body = (await req.json().catch(() => null)) as
    | { prompt?: string; options?: unknown; type?: string }
    | null;

  const prompt = String(body?.prompt ?? "").trim();
  if (prompt.length < 6) {
    return NextResponse.json(
      { message: "L'énoncé de la question est trop court." },
      { status: 400 }
    );
  }

  const exam = await db.exam.findUnique({ where: { id }, select: { id: true } });
  if (!exam) {
    return NextResponse.json({ message: "Examen introuvable." }, { status: 404 });
  }

  const rawOptions = Array.isArray(body?.options)
    ? body.options.map((o) => String(o).trim()).filter(Boolean).slice(0, 8)
    : [];
  const type = rawOptions.length >= 2 && body?.type !== "qa" ? "qcm" : "qa";

  const count = await db.examQuestion.count({ where: { examId: id } });
  const created = await db.examQuestion.create({
    data: {
      examId: id,
      idx: count,
      type,
      prompt: prompt.slice(0, 4000),
      options: type === "qcm" ? JSON.stringify(rawOptions) : null,
    },
  });

  return NextResponse.json({ question: toQuestionDTO(created) });
}
