// GET /api/stats — dashboard counters.

import { db } from "@/lib/db";
import type { StatsDTO } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const [documents, chunks, questions, keys] = await Promise.all([
    db.document.count(),
    db.chunk.count(),
    db.chatMessage.count(),
    db.apiKey.count(),
  ]);
  const stats: StatsDTO = { documents, chunks, questions, keysConfigured: keys };
  return Response.json(stats);
}
