// POST /api/exams/[id]/parse — SSE: the 📋 Examinateur reads the raw exam text
// and structures it into questions (LLM, regex fallback). Emits `exam.parsed`
// with the full question list; the UI then asks which courses it relates to.

import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { parseExamText } from "@/lib/exam";
import { toQuestionDTO } from "@/lib/exam-dto";
import { sseResponse } from "@/lib/sse-server";
import type { ExamEvent, ProviderId } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const body = (await req.json().catch(() => null)) as { provider?: string } | null;
  const provider: ProviderId =
    body?.provider === "mistral" || body?.provider === "agnes" ? body.provider : "zai";

  const exam = await db.exam.findUnique({ where: { id } });
  if (!exam) {
    return Response.json({ message: "Examen introuvable." }, { status: 404 });
  }

  return sseResponse(async (emit) => {
    const send = (event: ExamEvent) => emit(event);
    send({ type: "exam.start", phase: "parse", examId: id });

    try {
      send({ type: "agent.start", id: "examiner", label: "📋 Examinateur" });
      const result = await parseExamText(exam.rawText, provider, (message) => {
        send({ type: "agent.log", id: "examiner", message });
      });

      // Re-parse replaces the previous questions (idempotent re-import).
      await db.$transaction([
        db.examQuestion.deleteMany({ where: { examId: id } }),
        db.examQuestion.createMany({
          data: result.questions.map((q, idx) => ({
            examId: id,
            idx,
            type: q.type,
            prompt: q.prompt.slice(0, 4000),
            options: q.options.length ? JSON.stringify(q.options) : null,
          })),
        }),
        db.exam.update({
          where: { id },
          data: { kind: result.kind, subject: result.subject, theology: result.theology },
        }),
      ]);

      const saved = await db.examQuestion.findMany({ where: { examId: id }, orderBy: { idx: "asc" } });

      send({
        type: "agent.done",
        id: "examiner",
        label: "📋 Examinateur",
        summary: `${result.questions.length} question(s) — ${result.method === "llm" ? "lecture agents" : "analyse structurelle"}`,
      });
      send({
        type: "exam.parsed",
        kind: result.kind,
        subject: result.subject,
        theology: result.theology,
        questions: saved.map(toQuestionDTO),
      });
      send({ type: "exam.done" });
    } catch (err) {
      send({
        type: "exam.error",
        message: err instanceof Error ? err.message : "Analyse de l'examen impossible.",
      });
    }
  }, req.signal);
}
