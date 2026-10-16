// Agent memory API — the persistent profile the learner agent builds.
// GET    /api/memory        → { memories: AgentMemoryDTO[] } (weight desc, limit 200)
// DELETE /api/memory?id=…   → delete one insight
// DELETE /api/memory        → delete ALL insights

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { memoryToDTO } from "@/lib/memory";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const rows = await db.agentMemory.findMany({
    include: { document: { select: { title: true } } },
    orderBy: [{ weight: "desc" }, { updatedAt: "desc" }],
    take: 200,
  });
  return NextResponse.json({ memories: rows.map(memoryToDTO) });
}

export async function DELETE(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const id = searchParams.get("id")?.trim() ?? "";

  try {
    if (id) {
      await db.agentMemory.delete({ where: { id } });
      return NextResponse.json({ ok: true, deleted: 1 });
    }
    const res = await db.agentMemory.deleteMany({});
    return NextResponse.json({ ok: true, deleted: res.count });
  } catch {
    return NextResponse.json({ ok: false, message: "Entrée de mémoire introuvable." }, { status: 404 });
  }
}
