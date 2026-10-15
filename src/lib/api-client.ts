// Typed fetch wrappers for the non-SSE endpoints.
// Error handling: prefer the server's `message` / `error` field.

import type {
  ChatMessageDTO,
  DocumentDTO,
  ProviderId,
  ProviderStatusDTO,
  StatsDTO,
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
