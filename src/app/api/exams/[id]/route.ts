// /api/exams/[id]
// GET    → ExamDetailDTO (raw text + questions + chat messages)
// DELETE → remove the exam and everything attached to it.

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { toExamDetailDTO } from "@/lib/exam-dto";
import { invalidateSearchCache } from "@/lib/search";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const exam = await db.exam.findUnique({
    where: { id },
    include: { questions: { orderBy: { idx: "asc" } }, messages: { orderBy: { createdAt: "asc" } } },
  });
  if (!exam) {
    return NextResponse.json({ message: "Examen introuvable." }, { status: 404 });
  }
  const ids = JSON.parse(exam.documentIds || "[]") as string[];
  const linkedDocs = ids.length
    ? await db.document.findMany({
        where: { id: { in: ids } },
        select: { id: true, title: true },
      })
    : [];
  return NextResponse.json({ exam: toExamDetailDTO(exam, linkedDocs) });
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  try {
    await db.exam.delete({ where: { id } });
    invalidateSearchCache(); // QCM bank changed → the assistant matcher rebuilds lazily
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ ok: false, message: "Examen introuvable" }, { status: 404 });
  }
}
