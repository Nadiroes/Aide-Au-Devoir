// GET /api/documents/[id]/pdf — sert le PDF généré par …/save-pdf.
// 404 tant que le fichier n'existe pas ou que le cours est introuvable.

import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { db } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PDF_DIR = "/home/z/my-project/upload/documents";

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!/^[A-Za-z0-9_-]+$/.test(id)) {
    return NextResponse.json({ message: "PDF non encore généré pour ce cours." }, { status: 404 });
  }

  const doc = await db.document.findUnique({ where: { id }, select: { fileName: true } });
  if (!doc) {
    return NextResponse.json({ message: "PDF non encore généré pour ce cours." }, { status: 404 });
  }

  const filePath = path.join(PDF_DIR, `${id}.pdf`);
  if (!fs.existsSync(filePath)) {
    return NextResponse.json({ message: "PDF non encore généré pour ce cours." }, { status: 404 });
  }

  const pdf = await fs.promises.readFile(filePath);
  const asciiName =
    doc.fileName.replace(/[^\x20-\x7E]/g, "_").replace(/["\\]/g, "").trim() || "cours.pdf";

  return new Response(new Uint8Array(pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(
        doc.fileName
      )}`,
      "Content-Length": String(pdf.byteLength),
      "Cache-Control": "no-store",
    },
  });
}
