// Typed fetch wrappers for the non-SSE endpoints.
// Error handling: prefer the server's `message` / `error` field.

import type {
  AgentMemoryDTO,
  ChatMessageDTO,
  DocumentDetailDTO,
  DocumentDTO,
  DocLanguage,
  FolderDTO,
  ProviderId,
  ProviderStatusDTO,
  QAFilter,
  QARating,
  QASort,
  RevisionQADTO,
  StatsDTO,
  TtsRequestBody,
} from "@/lib/types";

export class ApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

async function extractMessage(res: Response): Promise<string> {
  try {
    const data = (await res.json()) as { message?: string; error?: string };
    return data.message ?? data.error ?? `Erreur ${res.status}`;
  } catch {
    return `Erreur ${res.status}`;
  }
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new ApiError(await extractMessage(res), res.status);
  return (await res.json()) as T;
}

// ---------- Documents ----------

export async function fetchDocuments(): Promise<DocumentDTO[]> {
  const data = await getJson<{ documents: DocumentDTO[] }>("/api/documents");
  return data.documents;
}

export async function deleteDocument(id: string): Promise<void> {
  const res = await fetch(`/api/documents/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!res.ok) throw new ApiError(await extractMessage(res), res.status);
}

// ---------- Keys ----------

export async function fetchProviders(): Promise<ProviderStatusDTO[]> {
  const data = await getJson<{ providers: ProviderStatusDTO[] }>("/api/keys");
  return data.providers;
}

export interface KeyActionResult {
  ok: boolean;
  message: string;
  masked?: string;
  verifiedAt?: string;
}

async function keyAction(url: string, provider: ProviderId, key: string): Promise<KeyActionResult> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider, key }),
  });
  // HTTP 400 with { ok:false, message } is a normal outcome (invalid key) —
  // surface it as a result, not an exception.
  if (!res.ok) {
    const contentType = res.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      const data = (await res.json().catch(() => null)) as
        | { ok?: boolean; message?: string; error?: string }
        | null;
      if (data && data.ok === false) {
        return { ok: false, message: data.message ?? data.error ?? "Échec de l'opération" };
      }
    }
    throw new ApiError(await extractMessage(res), res.status);
  }
  return (await res.json()) as KeyActionResult;
}

export function testApiKey(provider: ProviderId, key: string): Promise<KeyActionResult> {
  return keyAction("/api/keys/test", provider, key);
}

export function saveApiKey(provider: ProviderId, key: string): Promise<KeyActionResult> {
  return keyAction("/api/keys/save", provider, key);
}

export async function deleteApiKey(provider: ProviderId): Promise<string> {
  const res = await fetch(`/api/keys/${encodeURIComponent(provider)}`, { method: "DELETE" });
  const data = (await res.json().catch(() => ({}))) as { ok?: boolean; message?: string };
  if (!res.ok) throw new ApiError(data.message ?? `Erreur ${res.status}`, res.status);
  return data.message ?? "Clé supprimée";
}

// ---------- Chat / Stats ----------

export async function fetchChatHistory(): Promise<ChatMessageDTO[]> {
  const data = await getJson<{ messages: ChatMessageDTO[] }>("/api/chat");
  return data.messages;
}

export async function fetchStats(): Promise<StatsDTO> {
  return getJson<StatsDTO>("/api/stats");
}

// ---------- Folders ----------

/** Accepts either a bare array or an envelope { folders: [...] }. */
function asArray<T>(data: unknown, key: string): T[] {
  if (Array.isArray(data)) return data as T[];
  if (data && typeof data === "object" && Array.isArray((data as Record<string, unknown>)[key])) {
    return (data as Record<string, unknown>)[key] as T[];
  }
  return [];
}

/** Accepts either a bare object or an envelope { folder: {...} } / { document: {...} } etc. */
function unwrap<T>(data: unknown, key: string): T {
  if (data && typeof data === "object" && (data as Record<string, unknown>)[key] !== undefined) {
    return (data as Record<string, unknown>)[key] as T;
  }
  return data as T;
}

export async function fetchFolders(): Promise<FolderDTO[]> {
  const data: unknown = await getJson<unknown>("/api/folders");
  return asArray<FolderDTO>(data, "folders");
}

export async function createFolder(body: { name: string; color?: string }): Promise<FolderDTO> {
  const res = await fetch("/api/folders", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new ApiError(await extractMessage(res), res.status);
  return unwrap<FolderDTO>(await res.json(), "folder");
}

export async function updateFolder(
  id: string,
  body: { name?: string; color?: string }
): Promise<FolderDTO> {
  const res = await fetch(`/api/folders/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new ApiError(await extractMessage(res), res.status);
  return unwrap<FolderDTO>(await res.json(), "folder");
}

export async function deleteFolder(id: string): Promise<void> {
  const res = await fetch(`/api/folders/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!res.ok && res.status !== 204) throw new ApiError(await extractMessage(res), res.status);
}

// ---------- Document detail / editing ----------

export async function fetchDocumentDetail(id: string): Promise<DocumentDetailDTO> {
  const data: unknown = await getJson<unknown>(`/api/documents/${encodeURIComponent(id)}`);
  return unwrap<DocumentDetailDTO>(data, "document");
}

export async function updateDocument(
  id: string,
  body: Partial<{
    title: string;
    subject: string;
    folderId: string | null;
    language: DocLanguage;
    textContent: string;
  }>
): Promise<DocumentDetailDTO> {
  const res = await fetch(`/api/documents/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new ApiError(await extractMessage(res), res.status);
  return unwrap<DocumentDetailDTO>(await res.json(), "document");
}

// ---------- Revision Q&A ----------

export async function fetchQAs(
  documentId: string,
  opts?: { filter?: QAFilter; sort?: QASort; limit?: number }
): Promise<RevisionQADTO[]> {
  const params = new URLSearchParams({ documentId });
  if (opts?.filter) params.set("filter", opts.filter);
  if (opts?.sort) params.set("sort", opts.sort);
  if (opts?.limit !== undefined) params.set("limit", String(opts.limit));
  const data: unknown = await getJson<unknown>(`/api/qa?${params.toString()}`);
  return asArray<RevisionQADTO>(data, "qas");
}

export async function patchQA(
  id: string,
  body: Partial<{ hidden: boolean; rating: QARating | null }>
): Promise<RevisionQADTO> {
  const res = await fetch(`/api/qa/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new ApiError(await extractMessage(res), res.status);
  return unwrap<RevisionQADTO>(await res.json(), "qa");
}

export async function deleteQA(id: string): Promise<void> {
  const res = await fetch(`/api/qa/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!res.ok && res.status !== 204) throw new ApiError(await extractMessage(res), res.status);
}

/**
 * Bulk-clear the Q&A ledger. Backend semantics:
 *  - "shown": hide every visible entry (they stay remembered by the course)
 *  - "hidden": permanently delete every already-hidden entry
 *  - "all": hide everything, or delete everything when alsoDelete is true
 * (To re-show hidden entries, PATCH each QA with { hidden: false }.)
 */
export async function clearQAs(body: {
  documentId: string;
  mode: "shown" | "hidden" | "all";
  alsoDelete?: boolean;
}): Promise<{ count: number }> {
  const res = await fetch("/api/qa/clear", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new ApiError(await extractMessage(res), res.status);
  const data = (await res.json().catch(() => ({}))) as { count?: number };
  return { count: data.count ?? 0 };
}

// ---------- Agent memory ----------

export async function fetchMemory(): Promise<AgentMemoryDTO[]> {
  const data: unknown = await getJson<unknown>("/api/memory");
  return asArray<AgentMemoryDTO>(data, "memories");
}

export async function deleteMemory(id?: string): Promise<void> {
  const url = id ? `/api/memory?id=${encodeURIComponent(id)}` : "/api/memory";
  const res = await fetch(url, { method: "DELETE" });
  if (!res.ok && res.status !== 204) throw new ApiError(await extractMessage(res), res.status);
}

// ---------- Audio: ASR (speech-to-text) & TTS (text-to-speech) ----------

export async function transcribeAudio(file: Blob): Promise<string> {
  const fd = new FormData();
  fd.append("audio", file, "reponse.webm");
  const res = await fetch("/api/asr", { method: "POST", body: fd });
  if (!res.ok) throw new ApiError(await extractMessage(res), res.status);
  const data = (await res.json()) as { text?: string };
  return (data.text ?? "").trim();
}

export async function ttsToBlob(body: TtsRequestBody): Promise<Blob> {
  const res = await fetch("/api/tts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new ApiError(await extractMessage(res), res.status);
  return await res.blob();
}

// ---------- Scanned documents: OCR correction & PDF conversion ----------

/**
 * Saves the corrected OCR text of a scanned document and converts it into a
 * clean PDF (the agents read the corrected text first, so revision can start
 * right after). Returns the updated detail: kind becomes "pdf", status "prêt".
 */
export async function savePdf(id: string, text: string): Promise<DocumentDetailDTO> {
  const res = await fetch(`/api/documents/${encodeURIComponent(id)}/save-pdf`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) throw new ApiError(await extractMessage(res), res.status);
  return unwrap<DocumentDetailDTO>(await res.json(), "document");
}

/** Downloads the generated PDF as a Blob (throws if it has not been generated yet). */
export async function fetchDocumentPdf(id: string): Promise<Blob> {
  const res = await fetch(`/api/documents/${encodeURIComponent(id)}/pdf`);
  if (!res.ok) {
    let message = "PDF non encore généré — corrige d'abord le texte.";
    if (res.headers.get("content-type")?.includes("application/json")) {
      message = await extractMessage(res);
    }
    throw new ApiError(message, res.status);
  }
  return await res.blob();
}
