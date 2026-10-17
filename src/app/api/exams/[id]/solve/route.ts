// POST /api/exams/[id]/solve — SSE: the agents answer the exam questions.
// Body: { provider?, questionId? } — without questionId, every unanswered
// question is solved in order. Per question: 🔍 Chercheur (linked courses),
// ✍️ Résolveur (answer), 🧾 Vérificateur (references) → `question.answered`.

import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { solveExamQuestion } from "@/lib/exam";
import { toQuestionDTO } from "@/lib/exam-dto";
import { sseResponse } from "@/lib/sse-server";
import type { ExamEvent, ProviderId } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const body = (await req.json().catch(() => null)) as
    | { provider?: string; questionId?: string }
    | null;
  const provider: ProviderId =
    body?.provider === "mistral" || body?.provider === "agnes" ? body.provider : "zai";

  const exam = await db.exam.findUnique({ where: { id }, include: { questions: true } });
  if (!exam) {
    return Response.json({ message: "Examen introuvable." }, { status: 404 });
  }

  const documentIds = JSON.parse(exam.documentIds || "[]") as string[];

  const targets = body?.questionId
    ? exam.questions.filter((q) => q.id === body.questionId)
    : exam.questions.filter((q) => !(q.answer && q.answer.trim().length > 0)).sort((a, b) => a.idx - b.idx);

  return sseResponse(async (emit) => {
    const send = (event: ExamEvent) => emit(event);
    send({ type: "exam.start", phase: "solve", examId: id });

    if (!targets.length) {
      send({ type: "agent.done", id: "solver", label: "✍️ Résolveur", summary: "Tout est déjà résolu" });
      send({ type: "exam.done" });
      return;
    }

    send({
      type: "agent.log",
      id: "solver",
      message: `${targets.length} question(s) à traiter${documentIds.length ? ` — recherche dans ${documentIds.length} cours lié(s)` : " — aucune liaison de cours"}.`,
    });

    let solved = 0;
    for (const q of targets) {
      try {
        send({ type: "agent.start", id: "retriever", label: "🔍 Chercheur" });
        send({
          type: "agent.log",
          id: "retriever",
          message: `Recherche des passages utiles pour la question ${q.idx + 1}…`,
        });

        send({ type: "agent.start", id: "solver", label: "✍️ Résolveur" });
        const result = await solveExamQuestion(
          {
            prompt: q.prompt,
            options: q.options ? (JSON.parse(q.options) as string[]) : [],
            type: q.type === "qcm" ? "qcm" : "qa",
            documentIds,
            theology: exam.theology,
            examTitle: exam.title,
          },
          provider,
          (message) => send({ type: "agent.log", id: "solver", message })
        );

        send({
          type: "agent.done",
          id: "retriever",
          label: "🔍 Chercheur",
          summary: documentIds.length ? "Extraits des cours liés" : "Connaissances générales",
        });

        send({ type: "agent.start", id: "verifier", label: "🧾 Vérificateur" });
        send({
          type: "agent.log",
          id: "verifier",
          message: result.refs.length
            ? `Références vérifiées : ${result.refs.slice(0, 3).join(" · ")}${result.refs.length > 3 ? "…" : ""}`
            : "Pas de référence à vérifier.",
        });

        const updated = await db.examQuestion.update({
          where: { id: q.id },
          data: {
            answer: result.answer.slice(0, 6000),
            refs: JSON.stringify(result.refs),
            rationale: result.rationale.slice(0, 4000) || null,
          },
        });

        send({
          type: "agent.done",
          id: "solver",
          label: "✍️ Résolveur",
          summary: `Question ${q.idx + 1} répondue`,
        });
        send({
          type: "agent.done",
          id: "verifier",
          label: "🧾 Vérificateur",
          summary: result.refs.length ? `${result.refs.length} référence(s)` : "Cohérence OK",
        });
        send({ type: "question.answered", question: toQuestionDTO(updated) });
        solved += 1;
      } catch (err) {
        send({
          type: "agent.error",
          id: "solver",
          message: `Question ${q.idx + 1} : ${err instanceof Error ? err.message : "échec"}`,
        });
      }
    }

    send({
      type: "agent.done",
      id: "examiner",
      label: "📋 Examinateur",
      summary: `${solved}/${targets.length} question(s) traitée(s)`,
    });
    send({ type: "exam.done" });
  }, req.signal);
}
