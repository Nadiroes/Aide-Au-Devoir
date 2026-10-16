// Shared DocumentDetailDTO mapper for the new document endpoints (save-pdf).
// The PATCH/GET route src/app/api/documents/[id]/route.ts is frozen and keeps
// its own local copy — this helper must stay behavior-identical to it.

import { db } from "@/lib/db";
import type { DocLanguage, DocumentDetailDTO } from "@/lib/types";

/** One-document detail payload (folder + Q&A metrics + editable text). */
export async function getDocumentDetailDTO(id: string): Promise<DocumentDetailDTO | null> {
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
