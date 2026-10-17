// POST /api/exams/[id]/link — the association step the agents ask for after
// the import: "Cet examen est-il lié à un cours ?" { documentIds: string[] }
// (empty array = "sans lien particulier").

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { toExamDTO } from "@/lib/exam-dto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const body = (await req.json().catch(() => null)) as { documentIds?: unknown } | null;

  if (!body || !Array.isArray(body.documentIds)) {
    return NextResponse.json({ message: "documentIds (tableau) requis." }, { status: 400 });
  }

  const requested = [...new Set(body.documentIds.map((v) => String(v).trim()).filter(Boolean))];
  if (requested.length) {
    const existing = await db.document.findMany({
      where: { id: { in: requested } },
      select: { id: true },
    });
    const valid = new Set(existing.map((d) => d.id));
    const unknown = requested.filter((r) => !valid.has(r));
    if (unknown.length) {
      return NextResponse.json(
        { message: `Cours introuvable : ${unknown.join(", ")}` },
        { status: 400 }
      );
    }
  }

  const exam = await db.exam.update({
    where: { id },
    data: {
      documentIds: JSON.stringify(requested),
      linkStatus: requested.length ? "linked" : "sans",
    },
    include: { questions: true },
  });

  return NextResponse.json({ exam: toExamDTO(exam) });
}
