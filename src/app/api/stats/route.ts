// GET /api/stats — dashboard counters (StatsDTO v2).

import { db } from "@/lib/db";
import type { StatsDTO } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const [documents, folders, chunks, questions, chatQuestions, memoryCount, keys, fr, en] =
    await Promise.all([
      db.document.count(),
      db.folder.count(),
      db.chunk.count(),
      db.revisionQA.count(),
      db.chatMessage.count(),
      db.agentMemory.count(),
      db.apiKey.count(),
      db.document.count({ where: { language: "fr" } }),
      db.document.count({ where: { language: "en" } }),
    ]);

  const stats: StatsDTO = {
    documents,
    folders,
    chunks,
    questions,
    chatQuestions,
    memoryCount,
    keysConfigured: keys,
    languages: { fr, en },
  };
  return Response.json(stats);
}
