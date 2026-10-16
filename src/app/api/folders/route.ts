// Folders API — thematic organization of documents.
// GET  /api/folders → FolderDTO[] (sorted by name)
// POST /api/folders → 201 FolderDTO

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import type { FolderDTO } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const DEFAULT_COLOR = "#059669";

export async function GET() {
  const folders = await db.folder.findMany({
    include: { _count: { select: { documents: true } } },
    orderBy: { name: "asc" },
  });
  const dtos: FolderDTO[] = folders.map((f) => ({
    id: f.id,
    name: f.name,
    color: f.color,
    documentCount: f._count.documents,
    createdAt: f.createdAt.toISOString(),
  }));
  return NextResponse.json({ folders: dtos });
}

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as { name?: string; color?: string } | null;

  const name = String(body?.name ?? "").trim();
  if (!name) {
    return NextResponse.json({ message: "Le nom du dossier est obligatoire." }, { status: 400 });
  }
  if (name.length > 60) {
    return NextResponse.json({ message: "Le nom du dossier est trop long (60 caractères max)." }, { status: 400 });
  }
  const color = String(body?.color ?? "").trim() || DEFAULT_COLOR;
  if (!COLOR_RE.test(color)) {
    return NextResponse.json({ message: "Couleur invalide (format attendu : #RRGGBB)." }, { status: 400 });
  }

  const folder = await db.folder.create({ data: { name, color } });
  const dto: FolderDTO = {
    id: folder.id,
    name: folder.name,
    color: folder.color,
    documentCount: 0,
    createdAt: folder.createdAt.toISOString(),
  };
  return NextResponse.json(dto, { status: 201 });
}
