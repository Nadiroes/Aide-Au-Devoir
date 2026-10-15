// LLM router — pluggable providers with a common interface.
// - zai     : built-in SDK (no key required) — default provider
// - mistral : api.mistral.ai (OpenAI-ish, supports SSE streaming)
// - agnes   : generic OpenAI-compatible adapter, configured via env vars

import ZAI from "z-ai-web-dev-sdk";
import { db } from "@/lib/db";
import { secretbox } from "@/lib/secretbox";
import type { ProviderId } from "@/lib/types";

export interface LlmMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatOptions {
  messages: LlmMessage[];
  temperature?: number;
  /** If provided, the provider streams incremental tokens (best effort). */
  onToken?: (token: string) => void | Promise<void>;
  /** API key to use (test mode). If absent, the stored key for the provider is used. */
  apiKey?: string;
}

export interface ChatResult {
  content: string;
}

export interface VerifyResult {
  ok: boolean;
  message: string;
}

export interface LlmProvider {
  id: ProviderId;
  label: string;
  description: string;
  builtIn: boolean;
  /** Server-side readiness (agnes needs AGNES_BASE_URL). */
  serverReady: boolean;
  serverNote?: string;
  verify(key: string): Promise<VerifyResult>;
  chat(opts: ChatOptions): Promise<ChatResult>;
}

// ---------- helpers ----------

function shortHttpError(status: number, body: string): string {
  const snippet = body.slice(0, 180).replace(/\s+/g, " ");
  if (status === 401 || status === 403) return `Clé refusée par le fournisseur (${status}).`;
  if (status === 429) return `Quota / limite de débit atteint (${status}). Réessayez dans un instant.`;
  return `Le fournisseur a répondu ${status} : ${snippet || "sans détail"}`;
}

async function emitTokens(content: string, onToken?: (t: string) => void | Promise<void>) {
  if (!onToken || !content) return;
  const parts = content.match(/\S+\s*/g) ?? [content];
  const delay = Math.min(40, 2200 / Math.max(parts.length, 1));
  for (const p of parts) {
    await onToken(p);
    if (delay > 2) await new Promise((r) => setTimeout(r, delay));
  }
}

/** Read an SSE stream of OpenAI-style chunks, calling onToken per delta. */
async function streamOpenAiSse(
  url: string,
  headers: Record<string, string>,
  body: Record<string, unknown>,
  onToken?: (t: string) => void | Promise<void>
): Promise<string> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(shortHttpError(res.status, text));
  }
  if (!onToken || !res.body) {
    const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    return json.choices?.[0]?.message?.content ?? "";
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let full = "";
  let done = false;

  while (!done) {
    const { value, done: readerDone } = await reader.read();
    if (readerDone) break;
    buffer += decoder.decode(value, { stream: true });
    let sep: number;
    while ((sep = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, sep).trim();
      buffer = buffer.slice(sep + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") {
        done = true;
        break;
      }
      try {
        const chunk = JSON.parse(payload) as {
          choices?: { delta?: { content?: string }; message?: { content?: string } }[];
        };
        const delta = chunk.choices?.[0]?.delta?.content ?? "";
        if (delta) {
          full += delta;
          await onToken(delta);
        }
      } catch {
        // ignore malformed keep-alive lines
      }
    }
  }
  return full;
}

// ---------- Z.ai (built-in) ----------

export const zaiProvider: LlmProvider = {
  id: "zai",
  label: "Z.ai (intégré)",
  description: "Modèle fourni avec l'application — aucune clé requise.",
  builtIn: true,
  serverReady: true,

  async verify() {
    return { ok: true, message: "Fournisseur intégré, toujours disponible." };
  },

  async chat({ messages, temperature, onToken }) {
    const zai = await ZAI.create();
    // The SDK expects system-style prompts with the "assistant" role.
    const sdkMessages = messages.map((m) => ({
      role: m.role === "system" ? ("assistant" as const) : m.role,
      content: m.content,
    }));
    try {
      const completion = await zai.chat.completions.create({
        messages: sdkMessages,
        temperature: temperature ?? 0.3,
        thinking: { type: "disabled" },
      });
      const content = completion.choices[0]?.message?.content ?? "";
      await emitTokens(content, onToken);
      return { content };
    } catch (err) {
      // Retry once without temperature (some backends reject custom values).
      try {
        const completion = await zai.chat.completions.create({
          messages: sdkMessages,
          thinking: { type: "disabled" },
        });
        const content = completion.choices[0]?.message?.content ?? "";
        await emitTokens(content, onToken);
        return { content };
      } catch {
        throw err instanceof Error ? err : new Error("Erreur du modèle intégré");
      }
    }
  },
};

// ---------- Mistral ----------

const MISTRAL_BASE = "https://api.mistral.ai/v1";
const MISTRAL_MODEL = process.env.MISTRAL_MODEL || "mistral-large-latest";

export const mistralProvider: LlmProvider = {
  id: "mistral",
  label: "Mistral AI",
  description: "Clé personnelle Mistral (console.mistral.ai) — vérifiée en direct.",
  builtIn: false,
  serverReady: true,

  async verify(key) {
    try {
      const res = await fetch(`${MISTRAL_BASE}/models`, {
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(15_000),
      });
      if (res.ok) return { ok: true, message: "Clé Mistral valide ✓" };
      if (res.status === 401 || res.status === 403)
        return { ok: false, message: "Clé Mistral refusée (401). Vérifiez la clé." };
      return { ok: false, message: shortHttpError(res.status, await res.text().catch(() => "")) };
    } catch (err) {
      return {
        ok: false,
        message: `Réseau Mistral injoignable : ${err instanceof Error ? err.message : "erreur"}`,
      };
    }
  },

  async chat({ messages, temperature, onToken, apiKey }) {
    const key = apiKey ?? (await getStoredKey("mistral"));
    if (!key) throw new Error("Aucune clé Mistral enregistrée. Ajoutez-la dans Paramètres.");
    const content = await streamOpenAiSse(
      `${MISTRAL_BASE}/chat/completions`,
      { Authorization: `Bearer ${key}` },
      {
        model: MISTRAL_MODEL,
        messages,
        temperature: temperature ?? 0.3,
        stream: Boolean(onToken),
      },
      onToken
    );
    if (!content.trim()) throw new Error("Mistral a renvoyé une réponse vide.");
    return { content };
  },
};

// ---------- Agnes (generic OpenAI-compatible) ----------

const AGNES_BASE = (process.env.AGNES_BASE_URL || "").replace(/\/+$/, "");
const AGNES_MODEL = process.env.AGNES_MODEL || "agnes-chat";
const AGNES_TEST_PATH = process.env.AGNES_TEST_PATH || "/models";
const AGNES_AUTH_STYLE = (process.env.AGNES_AUTH_STYLE || "bearer").toLowerCase();

function agnesHeaders(key: string): Record<string, string> {
  if (AGNES_AUTH_STYLE === "x-api-key") return { "x-api-key": key };
  if (AGNES_AUTH_STYLE === "query") return {};
  return { Authorization: `Bearer ${key}` };
}

export const agnesProvider: LlmProvider = {
  id: "agnes",
  label: "Agnes",
  description:
    "Adaptateur OpenAI-compatible (URL configurable côté serveur via AGNES_BASE_URL).",
  builtIn: false,
  serverReady: Boolean(AGNES_BASE),
  serverNote: AGNES_BASE
    ? undefined
    : "Serveur non configuré : définissez AGNES_BASE_URL (+ AGNES_MODEL) dans l'environnement.",

  async verify(key) {
    if (!AGNES_BASE) {
      return { ok: false, message: "Agnes non configuré côté serveur (AGNES_BASE_URL manquant)." };
    }
    try {
      const url = AGNES_AUTH_STYLE === "query" ? `${AGNES_BASE}${AGNES_TEST_PATH}?api_key=${encodeURIComponent(key)}` : `${AGNES_BASE}${AGNES_TEST_PATH}`;
      const res = await fetch(url, { headers: agnesHeaders(key), signal: AbortSignal.timeout(15_000) });
      if (res.ok) return { ok: true, message: "Clé Agnes valide ✓" };
      if (res.status === 401 || res.status === 403)
        return { ok: false, message: "Clé Agnes refusée. Vérifiez la clé." };
      return { ok: false, message: shortHttpError(res.status, await res.text().catch(() => "")) };
    } catch (err) {
      return {
        ok: false,
        message: `Réseau Agnes injoignable : ${err instanceof Error ? err.message : "erreur"}`,
      };
    }
  },

  async chat({ messages, temperature, onToken, apiKey }) {
    if (!AGNES_BASE) throw new Error("Agnes non configuré côté serveur (AGNES_BASE_URL manquant).");
    const key = apiKey ?? (await getStoredKey("agnes"));
    if (!key) throw new Error("Aucune clé Agnes enregistrée. Ajoutez-la dans Paramètres.");
    const url =
      AGNES_AUTH_STYLE === "query"
        ? `${AGNES_BASE}/chat/completions?api_key=${encodeURIComponent(key)}`
        : `${AGNES_BASE}/chat/completions`;
    const content = await streamOpenAiSse(
      url,
      agnesHeaders(key),
      {
        model: AGNES_MODEL,
        messages,
        temperature: temperature ?? 0.3,
        stream: Boolean(onToken),
      },
      onToken
    );
    if (!content.trim()) throw new Error("Agnes a renvoyé une réponse vide.");
    return { content };
  },
};

// ---------- Registry ----------

const PROVIDERS: Record<ProviderId, LlmProvider> = {
  zai: zaiProvider,
  mistral: mistralProvider,
  agnes: agnesProvider,
};

export function getProvider(id: string): LlmProvider {
  const p = PROVIDERS[id as ProviderId];
  if (!p) throw new Error(`Fournisseur inconnu : ${id}`);
  return p;
}

export function listProviders(): LlmProvider[] {
  return Object.values(PROVIDERS);
}

export async function getStoredKey(provider: ProviderId): Promise<string | null> {
  const row = await db.apiKey.findUnique({ where: { provider } });
  if (!row) return null;
  try {
    return secretbox.decrypt(row.encrypted);
  } catch {
    return null;
  }
}
