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

// ---------- Agnes (generic OpenAI-compatible, configurable from the UI) ----------

import type { AgnesConfig } from "@/lib/types";
export type { AgnesConfig };

const AGNES_DEFAULTS = {
  baseUrl: (process.env.AGNES_BASE_URL || "").replace(/\/+$/, ""),
  model: process.env.AGNES_MODEL || "agnes-chat",
  testPath: process.env.AGNES_TEST_PATH || "/models",
  authStyle: ((process.env.AGNES_AUTH_STYLE || "bearer").toLowerCase() as AgnesConfig["authStyle"]),
};

const AGNES_SETTING_KEY = "agnes_config";

/**
 * Agnes configuration = DB (Paramètres UI, AppSetting) overlaid on env defaults.
 * Read on every call so saving in Paramètres takes effect immediately.
 */
export async function getAgnesConfig(): Promise<AgnesConfig> {
  let stored: Partial<AgnesConfig> = {};
  try {
    const row = await db.appSetting.findUnique({ where: { key: AGNES_SETTING_KEY } });
    if (row) stored = JSON.parse(row.value) as Partial<AgnesConfig>;
  } catch {
    // DB unavailable — fall back to env only.
  }
  const style = String(stored.authStyle ?? AGNES_DEFAULTS.authStyle);
  return {
    baseUrl: String(stored.baseUrl ?? AGNES_DEFAULTS.baseUrl).replace(/\/+$/, ""),
    model: stored.model || AGNES_DEFAULTS.model,
    authStyle: (style === "x-api-key" || style === "query" ? style : "bearer") as AgnesConfig["authStyle"],
  };
}

export async function saveAgnesConfig(config: Partial<AgnesConfig>): Promise<AgnesConfig> {
  const current = await getAgnesConfig();
  const next: AgnesConfig = {
    baseUrl: String(config.baseUrl ?? current.baseUrl).replace(/\/+$/, ""),
    model: config.model?.trim() || current.model,
    authStyle:
      config.authStyle === "x-api-key" || config.authStyle === "query" || config.authStyle === "bearer"
        ? config.authStyle
        : current.authStyle,
  };
  await db.appSetting.upsert({
    where: { key: AGNES_SETTING_KEY },
    update: { value: JSON.stringify(next) },
    create: { key: AGNES_SETTING_KEY, value: JSON.stringify(next) },
  });
  return next;
}

function agnesHeaders(config: AgnesConfig, key: string): Record<string, string> {
  if (config.authStyle === "x-api-key") return { "x-api-key": key };
  if (config.authStyle === "query") return {};
  return { Authorization: `Bearer ${key}` };
}

export const agnesProvider: LlmProvider = {
  id: "agnes",
  label: "Agnes",
  description:
    "Serveur OpenAI-compatible — URL et clé configurables dans Paramètres (testez puis enregistrez).",
  builtIn: false,
  serverReady: true, // dynamic: evaluated per request from DB/env config

  async verify(key) {
    const config = await getAgnesConfig();
    if (!config.baseUrl) {
      return {
        ok: false,
        message: "Renseignez d'abord l'URL du serveur Agnes (ex. http://…/v1) ci-dessus.",
      };
    }
    try {
      const url =
        config.authStyle === "query"
          ? `${config.baseUrl}${AGNES_DEFAULTS.testPath}?api_key=${encodeURIComponent(key)}`
          : `${config.baseUrl}${AGNES_DEFAULTS.testPath}`;
      const res = await fetch(url, {
        headers: agnesHeaders(config, key),
        signal: AbortSignal.timeout(15_000),
      });
      if (res.ok) return { ok: true, message: `Clé Agnes valide ✓ (${config.baseUrl})` };
      if (res.status === 401 || res.status === 403)
        return { ok: false, message: "Clé Agnes refusée. Vérifiez la clé et le style d'authentification." };
      return { ok: false, message: shortHttpError(res.status, await res.text().catch(() => "")) };
    } catch (err) {
      return {
        ok: false,
        message: `Serveur Agnes injoignable : ${err instanceof Error ? err.message : "erreur"}`,
      };
    }
  },

  async chat({ messages, temperature, onToken, apiKey }) {
    const config = await getAgnesConfig();
    if (!config.baseUrl)
      throw new Error("Agnes non configuré : renseignez l'URL du serveur dans Paramètres.");
    const key = apiKey ?? (await getStoredKey("agnes"));
    if (!key) throw new Error("Aucune clé Agnes enregistrée. Ajoutez-la dans Paramètres.");
    const url =
      config.authStyle === "query"
        ? `${config.baseUrl}/chat/completions?api_key=${encodeURIComponent(key)}`
        : `${config.baseUrl}/chat/completions`;
    const content = await streamOpenAiSse(
      url,
      { ...agnesHeaders(config, key), "Content-Type": "application/json" },
      {
        model: config.model,
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
