// PATCH /api/folders/[id] — rename / recolor a folder.
// DELETE /api/folders/[id] — delete it (documents are detached: onDelete SetNull).

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import type { FolderDTO } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const body = (await req.json().catch(() => null)) as { name?: string; color?: string } | null;

  const data: { name?: string; color?: string } = {};

  if (body?.name !== undefined) {
    const name = String(body.name ?? "").trim();
    if (!name) {
      return NextResponse.json({ message: "Le nom du dossier ne peut pas être vide." }, { status: 400 });
    }
    if (name.length > 60) {
      return NextResponse.json({ message: "Le nom du dossier est trop long (60 caractères max)." }, { status: 400 });
    }
    data.name = name;
  }

  if (body?.color !== undefined) {
    const color = String(body.color ?? "").trim();
    if (!COLOR_RE.test(color)) {
      return NextResponse.json({ message: "Couleur invalide (format attendu : #RRGGBB)." }, { status: 400 });
    }
    data.color = color;
  }

  if (!Object.keys(data).length) {
    return NextResponse.json({ message: "Aucune modification fournie." }, { status: 400 });
  }

  try {
    const folder = await db.folder.update({ where: { id }, data });
    const dto: FolderDTO = {
      id: folder.id,
      name: folder.name,
      color: folder.color,
      documentCount: await db.document.count({ where: { folderId: folder.id } }),
      createdAt: folder.createdAt.toISOString(),
    };
    return NextResponse.json(dto);
  } catch {
    return NextResponse.json({ message: "Dossier introuvable." }, { status: 404 });
  }
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  try {
    await db.folder.delete({ where: { id } });
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ ok: false, message: "Dossier introuvable." }, { status: 404 });
  }
}
