// Documents API
// GET  /api/documents        → list imported courses (with folder + Q&A metrics)
// POST /api/documents        → multipart upload, returns SSE stream of IngestEvent
//                              (agents Lecteur → Découpeur → Indexeur announce readiness)

import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { extractText, chunkText, kindFromFileName } from "@/lib/ingestion";
import { detectLanguage, languageLabel } from "@/lib/language";
import { invalidateSearchCache } from "@/lib/search";
import { sseResponse, type SseEmit } from "@/lib/sse-server";
import type { DocLanguage, DocumentDTO, IngestEvent } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_SIZE = 25 * 1024 * 1024; // 25 MB
const MAX_AUDIO_SIZE = 80 * 1024 * 1024; // 80 MB — audio is chunked server-side before ASR

/** Freshly created document (POST path) — no folder, no Q&A yet. */
function toIngestDTO(d: {
  id: string;
  title: string;
  subject: string;
  kind: string;
  fileName: string;
  status: string;
  chunks: number;
  chars: number;
  note: string | null;
  language: string;
  createdAt: Date;
}): DocumentDTO {
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
    folderId: null,
    folderName: null,
    folderColor: null,
    qaCount: 0,
    qaToReview: 0,
    mastery: 0,
    createdAt: d.createdAt.toISOString(),
  };
}

export async function GET() {
  const [docs, arevoirGroups, connuGroups, ratedGroups] = await Promise.all([
    db.document.findMany({
      orderBy: { createdAt: "desc" },
      include: {
        folder: { select: { name: true, color: true } },
        _count: { select: { revisionQAs: true } },
      },
    }),
    db.revisionQA.groupBy({ by: ["documentId"], where: { rating: "arevoir" }, _count: { _all: true } }),
    db.revisionQA.groupBy({ by: ["documentId"], where: { rating: "connu" }, _count: { _all: true } }),
    db.revisionQA.groupBy({
      by: ["documentId"],
      where: { rating: { not: null } },
      _count: { _all: true },
    }),
  ]);

  const arevoirMap = new Map(arevoirGroups.map((g) => [g.documentId, g._count._all]));
  const connuMap = new Map(connuGroups.map((g) => [g.documentId, g._count._all]));
  const ratedMap = new Map(ratedGroups.map((g) => [g.documentId, g._count._all]));

  const documents: DocumentDTO[] = docs.map((d) => {
    const rated = ratedMap.get(d.id) ?? 0;
    const connu = connuMap.get(d.id) ?? 0;
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
      qaCount: d._count.revisionQAs,
      qaToReview: arevoirMap.get(d.id) ?? 0,
      mastery: rated > 0 ? Math.round((connu / rated) * 100) : 0,
      createdAt: d.createdAt.toISOString(),
    };
  });

  return Response.json({ documents });
}

export async function POST(req: NextRequest) {
  const signal = req.signal;
  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  const title = String(form?.get("title") ?? "").trim();
  const subject = String(form?.get("subject") ?? "").trim() || "Général";
  const folderId = String(form?.get("folderId") ?? "").trim() || null;

  const invalid = (() => {
    if (!form) return "Requête invalide (formulaire manquant).";
    if (!(file instanceof File)) return "Aucun fichier reçu.";
    if (!title) return "Le titre du cours est obligatoire.";
    const uploadKind = kindFromFileName(file.name);
    if (!uploadKind) {
      return (
        "Format non supporté. Formats acceptés : PDF, DOCX, EPUB, TXT, MD, PNG, JPEG, WEBP, " +
        "MP3, WAV, M4A, OGG, WEBM, AAC, FLAC."
      );
    }
    const maxSize = uploadKind === "audio" ? MAX_AUDIO_SIZE : MAX_SIZE;
    if (file.size > maxSize)
      return `Fichier trop volumineux (max ${Math.round(maxSize / (1024 * 1024))} Mo).`;
    return null;
  })();

  return sseResponse(async (emit: SseEmit) => {
    if (invalid) {
      emit({ type: "ingest.error", message: invalid } satisfies IngestEvent);
      return;
    }
    const f = file as File;
    const kind = kindFromFileName(f.name)!;

    emit({ type: "ingest.start", fileName: f.name, title, kind } satisfies IngestEvent);

    const fail = (agentId: "reader" | "chunker" | "indexer", message: string) => {
      emit({ type: "agent.error", id: agentId, message } satisfies IngestEvent);
      emit({ type: "ingest.error", message } satisfies IngestEvent);
    };

    // ---- Agent Lecteur ----
    emit({ type: "agent.start", id: "reader", label: "📖 Lecteur" } satisfies IngestEvent);
    emit({
      type: "agent.log",
      id: "reader",
      message: `Lecture de « ${f.name} » (${Math.max(1, Math.round(f.size / 1024))} Ko)…`,
    } satisfies IngestEvent);

    let text = "";
    let method = "";
    try {
      const buffer = Buffer.from(await f.arrayBuffer());
      const result = await extractText(f.name, buffer, (message) => {
        emit({ type: "agent.log", id: "reader", message } satisfies IngestEvent);
      });
      text = result.text;
      method = result.method;
      emit({
        type: "agent.log",
        id: "reader",
        message: result.pages
          ? `${result.pages} page(s) lue(s) — ${result.method}.`
          : `${result.method} — texte extrait.`,
      } satisfies IngestEvent);

      const language = detectLanguage(text);
      emit({
        type: "agent.log",
        id: "reader",
        message: `Langue détectée : ${languageLabel(language)}.`,
      } satisfies IngestEvent);

      emit({
        type: "agent.done",
        id: "reader",
        label: "📖 Lecteur",
        summary: `${text.length.toLocaleString("fr-FR")} caractères extraits`,
      } satisfies IngestEvent);
    } catch (err) {
      fail("reader", err instanceof Error ? err.message : "Échec de la lecture du fichier");
      return;
    }

    if (signal.aborted) return;

    // ---- Agent Découpeur ----
    emit({ type: "agent.start", id: "chunker", label: "✂️ Découpeur" } satisfies IngestEvent);
    emit({
      type: "agent.log",
      id: "chunker",
      message: "Découpage en segments avec chevauchement…",
    } satisfies IngestEvent);

    let chunks: { idx: number; content: string }[] = [];
    try {
      chunks = chunkText(text);
      if (!chunks.length) throw new Error("Aucun texte exploitable après découpage.");
      emit({
        type: "agent.done",
        id: "chunker",
        label: "✂️ Découpeur",
        summary: `${chunks.length} segment(s) prêt(s)`,
      } satisfies IngestEvent);
    } catch (err) {
      fail("chunker", err instanceof Error ? err.message : "Échec du découpage");
      return;
    }

    if (signal.aborted) return;

    // ---- Agent Indexeur ----
    emit({ type: "agent.start", id: "indexer", label: "🗂️ Indexeur" } satisfies IngestEvent);
    emit({
      type: "agent.log",
      id: "indexer",
      message: `Indexation de ${chunks.length} segment(s) pour la recherche…`,
    } satisfies IngestEvent);

    // Scanned / photographed pages (OCR) keep a "to review" status until the
    // student proof-reads the recognized words and saves them as a clean PDF.
    const isOcrImage = kind === "png" || kind === "jpg" || kind === "jpeg" || kind === "webp";
    let note = `Extraction : ${method}`;
    if (isOcrImage) {
      note += " — vérifie les mots mal reconnus avant d'enregistrer en PDF.";
      if (text.trim().length < 40) {
        note += " Peu de texte détecté — la photo est-elle nette et complète ?";
      }
    }

    try {
      const language = detectLanguage(text);
      const doc = await db.document.create({
        data: {
          title,
          subject,
          kind,
          fileName: f.name,
          status: isOcrImage ? "à vérifier" : "prêt",
          chunks: chunks.length,
          chars: text.length,
          note,
          language,
          textContent: text,
          folderId,
          chunkList: { create: chunks.map((c) => ({ idx: c.idx, content: c.content })) },
        },
      });
      invalidateSearchCache();
      emit({
        type: "agent.done",
        id: "indexer",
        label: "🗂️ Indexeur",
        summary: "Index de recherche à jour",
      } satisfies IngestEvent);
      emit({ type: "ingest.done", document: toIngestDTO(doc) } satisfies IngestEvent);
    } catch (err) {
      fail("indexer", err instanceof Error ? err.message : "Échec de l'indexation");
    }
  }, signal);
}
