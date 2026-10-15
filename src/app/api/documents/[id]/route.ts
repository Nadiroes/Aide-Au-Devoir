// DELETE /api/documents/[id] — remove a course and its chunks.

import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { invalidateSearchCache } from "@/lib/search";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  try {
    await db.document.delete({ where: { id } });
    invalidateSearchCache();
    return Response.json({ ok: true });
  } catch {
    return Response.json({ ok: false, error: "Cours introuvable" }, { status: 404 });
  }
}
