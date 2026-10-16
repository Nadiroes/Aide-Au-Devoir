// PATCH  /api/qa/[id] — update a stored Q&A (hide/show, self-assessment rating,
//                         manual answer/feedback edits).
// DELETE /api/qa/[id] — permanently remove one entry.

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { qaToDTO } from "@/lib/revision";
import type { QARating } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RATINGS: (QARating | null)[] = ["connu", "moyen", "arevoir", null];

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const body = (await req.json().catch(() => null)) as {
    hidden?: boolean;
    rating?: QARating | null;
    answer?: string;
    feedback?: string;
  } | null;

  if (!body) {
    return NextResponse.json({ message: "Requête invalide." }, { status: 400 });
  }

  const data: {
    hidden?: boolean;
    rating?: QARating | null;
    answer?: string;
    feedback?: string | null;
  } = {};

  if (body.hidden !== undefined) data.hidden = Boolean(body.hidden);

  if (body.rating !== undefined) {
    const rating = body.rating;
    if (!RATINGS.includes(rating ?? null)) {
      return NextResponse.json(
        { message: "Évaluation invalide (connu, moyen, arevoir ou null)." },
        { status: 400 }
      );
    }
    data.rating = rating ?? null;
  }

  if (body.answer !== undefined) {
    const answer = String(body.answer ?? "").trim();
    if (!answer) {
      return NextResponse.json({ message: "La réponse ne peut pas être vide." }, { status: 400 });
    }
    data.answer = answer;
  }

  if (body.feedback !== undefined) {
    const feedback = String(body.feedback ?? "").trim();
    data.feedback = feedback || null;
  }

  if (!Object.keys(data).length) {
    return NextResponse.json({ message: "Aucune modification fournie." }, { status: 400 });
  }

  try {
    const updated = await db.revisionQA.update({ where: { id }, data });
    return NextResponse.json(qaToDTO(updated));
  } catch {
    return NextResponse.json({ message: "Question/réponse introuvable." }, { status: 404 });
  }
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  try {
    await db.revisionQA.delete({ where: { id } });
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ ok: false, message: "Question/réponse introuvable." }, { status: 404 });
  }
}
