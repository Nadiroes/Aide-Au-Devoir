// /api/documents/[id]
// GET    → DocumentDetailDTO (full payload incl. editable textContent)
// PATCH  → edit title / subject / folder / language / textContent
//          (textContent change ⇒ re-chunk + search cache invalidation)
// DELETE → remove the course and its chunks.

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { chunkText } from "@/lib/ingestion";
import { invalidateSearchCache } from "@/lib/search";
import type { DocLanguage, DocumentDetailDTO } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** One-document variant of the list metrics (qaCount / qaToReview / mastery). */
async function toDetailDTO(id: string): Promise<DocumentDetailDTO | null> {
  const d = await db.document.findUnique({
    where: { id },
    include: { folder: { select: { name: true, color: true } } },
  });
  if (!d) return null;

  const [qaCount, qaToReview, rated, connu] = await Promise.all([
    db.revisionQA.count({ where: { documentId: id } }),
    db.revisionQA.count({ where: { documentId: id, rating: "arevoir" } }),
    db.revisionQA.count({ where: { documentId: id, rating: { not: null } } }),
    db.revisionQA.count({ where: { documentId: id, rating: "connu" } }),
  ]);

  return {
    id: d.id,
    title: d.title,
    subject: d.subject,
    kind: d.kind,
    fileName: d.fileName,
    status: d.status,
    chunks: d.chunks,
    chars: d.chars,
    note: d.note,
    language: (d.language === "en" ? "en" : "fr") as DocLanguage,
    folderId: d.folderId,
    folderName: d.folder?.name ?? null,
    folderColor: d.folder?.color ?? null,
    qaCount,
    qaToReview,
    mastery: rated > 0 ? Math.round((connu / rated) * 100) : 0,
    createdAt: d.createdAt.toISOString(),
    textContent: d.textContent,
  };
}

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  let dto = await toDetailDTO(id);
  if (!dto) {
    return NextResponse.json({ message: "Cours introuvable." }, { status: 404 });
  }

  // Auto-heal: legacy documents ingested before the textContent column have an
  // empty full-text. When the user opens the course, rebuild it from its indexed
  // segments (in reading order) so the audio reader and edition tools work.
  if (dto.textContent.trim().length === 0 && dto.chunks > 0) {
    const segs = await db.chunk.findMany({ where: { documentId: id }, orderBy: { idx: "asc" } });
    const rebuilt = segs.map((s) => s.content).join("\n\n");
    if (rebuilt.trim().length > 0) {
      await db.document.update({
        where: { id },
        data: { textContent: rebuilt, chars: rebuilt.length },
      });
      dto = { ...dto, textContent: rebuilt, chars: rebuilt.length };
    }
  }

  return NextResponse.json(dto);
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const body = (await req.json().catch(() => null)) as {
    title?: string;
    subject?: string;
    folderId?: string | null;
    language?: string;
    textContent?: string;
  } | null;

  if (!body) {
    return NextResponse.json({ message: "Requête invalide." }, { status: 400 });
  }

  const existing = await db.document.findUnique({ where: { id } });
  if (!existing) {
    return NextResponse.json({ message: "Cours introuvable." }, { status: 404 });
  }

  const data: {
    title?: string;
    subject?: string;
    folderId?: string | null;
    language?: string;
    textContent?: string;
    chars?: number;
    chunks?: number;
  } = {};

  if (body.title !== undefined) {
    const title = String(body.title ?? "").trim();
    if (!title) {
      return NextResponse.json({ message: "Le titre ne peut pas être vide." }, { status: 400 });
    }
    data.title = title;
  }

  if (body.subject !== undefined) {
    const subject = String(body.subject ?? "").trim();
    if (subject) data.subject = subject;
  }

  if (body.folderId !== undefined) {
    const folderId = body.folderId === null ? null : String(body.folderId ?? "").trim() || null;
    if (folderId) {
      const folder = await db.folder.findUnique({ where: { id: folderId }, select: { id: true } });
      if (!folder) {
        return NextResponse.json({ message: "Dossier introuvable." }, { status: 400 });
      }
    }
    data.folderId = folderId;
  }

  if (body.language !== undefined) {
    if (body.language !== "fr" && body.language !== "en") {
      return NextResponse.json({ message: "Langue invalide (fr ou en attendu)." }, { status: 400 });
    }
    data.language = body.language;
  }

  const newText = body.textContent;
  const shouldRechunk =
    typeof newText === "string" && newText !== existing.textContent;

  if (shouldRechunk && newText !== undefined) {
    const newChunks = chunkText(newText);
    if (!newChunks.length) {
      return NextResponse.json(
        { message: "Le nouveau texte est vide : impossible de le découper." },
        { status: 400 }
      );
    }
    await db.$transaction([
      db.chunk.deleteMany({ where: { documentId: id } }),
      db.document.update({
        where: { id },
        data: { ...data, textContent: newText, chars: newText.length, chunks: newChunks.length },
      }),
      db.chunk.createMany({
        data: newChunks.map((c) => ({ documentId: id, idx: c.idx, content: c.content })),
      }),
    ]);
    invalidateSearchCache();
  } else {
    if (!Object.keys(data).length) {
      // Nothing to change — return the current state.
      const dto = await toDetailDTO(id);
      return NextResponse.json(dto);
    }
    await db.document.update({ where: { id }, data });
  }

  const dto = await toDetailDTO(id);
  if (!dto) {
    return NextResponse.json({ message: "Cours introuvable." }, { status: 404 });
  }
  return NextResponse.json(dto);
}

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
