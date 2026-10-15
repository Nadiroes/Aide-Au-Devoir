// Documents API
// GET  /api/documents        → list imported courses
// POST /api/documents        → multipart upload, returns SSE stream of IngestEvent
//                              (agents Lecteur → Découpeur → Indexeur announce readiness)

import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { extractText, chunkText, kindFromFileName } from "@/lib/ingestion";
import { invalidateSearchCache } from "@/lib/search";
import { sseResponse, type SseEmit } from "@/lib/sse-server";
import type { DocumentDTO, IngestEvent } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_SIZE = 25 * 1024 * 1024; // 25 MB

function toDTO(d: {
  id: string;
  title: string;
  subject: string;
  kind: string;
  fileName: string;
  status: string;
  chunks: number;
  chars: number;
  note: string | null;
  createdAt: Date;
}): DocumentDTO {
  return { ...d, createdAt: d.createdAt.toISOString() };
}

export async function GET() {
  const docs = await db.document.findMany({ orderBy: { createdAt: "desc" } });
  return Response.json({ documents: docs.map(toDTO) });
}

export async function POST(req: NextRequest) {
  const signal = req.signal;
  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  const title = String(form?.get("title") ?? "").trim();
  const subject = String(form?.get("subject") ?? "").trim() || "Général";

  const invalid = (() => {
    if (!form) return "Requête invalide (formulaire manquant).";
    if (!(file instanceof File)) return "Aucun fichier reçu.";
    if (!title) return "Le titre du cours est obligatoire.";
    if (file.size > MAX_SIZE) return "Fichier trop volumineux (max 25 Mo).";
    if (!kindFromFileName(file.name))
      return "Format non supporté. Formats acceptés : PDF, DOCX, TXT, MD, PNG, JPEG, WEBP.";
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
      const result = await extractText(f.name, buffer);
      text = result.text;
      method = result.method;
      emit({
        type: "agent.log",
        id: "reader",
        message: result.pages
          ? `${result.pages} page(s) lue(s) — ${result.method}.`
          : `${result.method} — texte extrait.`,
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

    try {
      const doc = await db.document.create({
        data: {
          title,
          subject,
          kind,
          fileName: f.name,
          status: "prêt",
          chunks: chunks.length,
          chars: text.length,
          note: `Extraction : ${method}`,
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
      emit({ type: "ingest.done", document: toDTO(doc) } satisfies IngestEvent);
    } catch (err) {
      fail("indexer", err instanceof Error ? err.message : "Échec de l'indexation");
    }
  }, signal);
}
