// Chat API
// GET  /api/chat → recent history (last 30 messages, chronological)
// POST /api/chat → SSE stream of ChatEvent (multi-agent pipeline)

import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { runChatPipeline } from "@/lib/agents";
import { sseResponse } from "@/lib/sse-server";
import type { ChatEvent, ChatMessageDTO, ChatMode, ProviderId, RetrievalHit } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const VALID_PROVIDERS: ProviderId[] = ["zai", "mistral", "agnes"];

export async function GET() {
  const rows = await db.chatMessage.findMany({ orderBy: { createdAt: "desc" }, take: 30 });
  const messages: ChatMessageDTO[] = rows
    .map((r) => ({
      id: r.id,
      question: r.question,
      answer: r.answer,
      tutor: r.tutor,
      plan: r.plan,
      provider: r.provider,
      mode: r.mode,
      sources: r.sources ? (JSON.parse(r.sources) as RetrievalHit[]) : null,
      createdAt: r.createdAt.toISOString(),
    }))
    .reverse();
  return Response.json({ messages });
}

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as
    | { question?: string; provider?: string; mode?: string }
    | null;

  const question = body?.question?.trim() ?? "";
  const provider = (VALID_PROVIDERS.includes(body?.provider as ProviderId)
    ? body?.provider
    : "zai") as ProviderId;
  const mode: ChatMode = body?.mode === "libre" ? "libre" : "cours";

  if (!question) {
    return Response.json({ error: "La question est vide." }, { status: 400 });
  }

  // Conversation context: last 3 exchanges.
  const recent = await db.chatMessage.findMany({ orderBy: { createdAt: "desc" }, take: 3 });
  const history = recent.reverse().map((r) => ({ question: r.question, answer: r.answer }));

  return sseResponse(async (emit) => {
    await runChatPipeline({ question, provider, mode, history, signal: req.signal }, (event) =>
      emit(event as ChatEvent)
    );
  }, req.signal);
}
