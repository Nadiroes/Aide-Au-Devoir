// POST /api/revision — SSE stream of RevisionEvent (multi-agent revision pipeline).
// GET → 405.

import { NextRequest } from "next/server";
import { runRevision } from "@/lib/revision";
import { sseResponse } from "@/lib/sse-server";
import type { RevisionEvent, RevisionRequestBody } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as RevisionRequestBody | null;

  if (!body || !body.action || !String(body.documentId ?? "").trim()) {
    return Response.json(
      { error: "Requête de révision invalide (action et documentId requis)." },
      { status: 400 }
    );
  }

  return sseResponse(async (emit) => {
    await runRevision(body, (event) => emit(event as RevisionEvent));
  }, req.signal);
}

export async function GET() {
  return Response.json({ error: "Méthode non autorisée" }, { status: 405 });
}
