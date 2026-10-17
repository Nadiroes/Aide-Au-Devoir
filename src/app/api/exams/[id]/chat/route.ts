// POST /api/exams/[id]/chat — SSE: the student asks a question "au fil de
// l'exercice" (about the exam, the homework, or a hand-typed QCM). The agent
// answers with the linked courses + the exam's own questions/answers, with
// biblical references in theology contexts. Both sides are persisted.

import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { runExamChat } from "@/lib/exam";
import { toMessageDTO } from "@/lib/exam-dto";
import { sseResponse } from "@/lib/sse-server";
import type { ExamEvent, ProviderId } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const body = (await req.json().catch(() => null)) as
    | { content?: string; provider?: string }
    | null;

  const content = String(body?.content ?? "").trim();
  if (!content) {
    return Response.json({ message: "Le message est vide." }, { status: 400 });
  }
  const provider: ProviderId =
    body?.provider === "mistral" || body?.provider === "agnes" ? body.provider : "zai";

  const exam = await db.exam.findUnique({ where: { id }, select: { id: true } });
  if (!exam) {
    return Response.json({ message: "Examen introuvable." }, { status: 404 });
  }

  return sseResponse(async (emit) => {
    const send = (event: ExamEvent) => emit(event);
    send({ type: "exam.start", phase: "chat", examId: id });

    // Persist the user's message first.
    const userMessage = await db.examMessage.create({
      data: { examId: id, role: "user", content: content.slice(0, 4000), refs: "[]" },
    });
    send({ type: "chat.saved", message: toMessageDTO(userMessage) });

    const history = await db.examMessage.findMany({
      where: { examId: id },
      orderBy: { createdAt: "desc" },
      take: 7,
    });

    try {
      send({ type: "agent.start", id: "solver", label: "✍️ Résolveur" });
      const result = await runExamChat({
        examId: id,
        question: content,
        providerId: provider,
        history: history
          .reverse()
          .filter((m) => m.id !== userMessage.id)
          .map((m) => ({ role: m.role, content: m.content })),
        onToken: (token) => send({ type: "chat.token", token }),
      });

      const agentMessage = await db.examMessage.create({
        data: {
          examId: id,
          role: "agent",
          content: result.content.slice(0, 12_000),
          refs: JSON.stringify(result.refs),
        },
      });

      send({
        type: "agent.done",
        id: "solver",
        label: "✍️ Résolveur",
        summary: result.refs.length ? `${result.refs.length} référence(s) citée(s)` : "Réponse prête",
      });
      send({ type: "chat.saved", message: toMessageDTO(agentMessage) });
      send({ type: "exam.done" });
    } catch (err) {
      send({
        type: "exam.error",
        message: err instanceof Error ? err.message : "La réponse a échoué.",
      });
    }
  }, req.signal);
}
