// Server-side Text-To-Speech (z-ai-web-dev-sdk — backend ONLY, never import client-side).
// - splitTtsText: sentence-boundary splitting with a max length per segment
// - synthesizeSpeech: WAV synthesis with an in-memory LRU cache (~48 MB cap)

import ZAI from "z-ai-web-dev-sdk";
import { createHash } from "node:crypto";
import type { DocLanguage } from "@/lib/types";

type ZaiClient = Awaited<ReturnType<typeof ZAI.create>>;

let zaiPromise: Promise<ZaiClient> | null = null;

/** Shared SDK client (singleton promise). Backend-only. */
export function getZaiClient(): Promise<ZaiClient> {
  if (!zaiPromise) zaiPromise = ZAI.create();
  return zaiPromise;
}

// ---------- Text splitting ----------

/**
 * Splits text on sentence boundaries (periods / ! / ? / newlines), accumulating
 * segments up to maxLen characters. Falls back to hard slicing for sentences
 * longer than maxLen.
 */
export function splitTtsText(text: string, maxLen = 900): string[] {
  const clean = text.trim();
  if (!clean) return [];
  if (clean.length <= maxLen) return [clean];

  const parts: string[] = [];
  const sentences = clean.split(/(?<=[.!?…])\s+|\n+/);

  let current = "";
  for (const raw of sentences) {
    const piece = raw.trim();
    if (!piece) continue;

    if (piece.length > maxLen) {
      if (current) {
        parts.push(current.trim());
        current = "";
      }
      for (let i = 0; i < piece.length; i += maxLen) {
        const slice = piece.slice(i, i + maxLen).trim();
        if (slice) parts.push(slice);
      }
      continue;
    }

    if ((current + " " + piece).trim().length > maxLen) {
      if (current) parts.push(current.trim());
      current = piece;
    } else {
      current = `${current} ${piece}`.trim();
    }
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

// ---------- Voice ----------

/** Default voice per course language: fr → tongtong, en → jam. */
export function autoVoice(lang: DocLanguage): string {
  return lang === "en" ? "jam" : "tongtong";
}

// ---------- LRU cache ----------

const ttsCache = new Map<string, Buffer>(); // insertion-ordered = LRU order
const MAX_CACHE_BYTES = 48 * 1024 * 1024; // ~48 MB total

function cacheKey(voice: string, speed: number, text: string): string {
  const hash = createHash("sha1").update(text).digest("hex");
  return `${voice}|${speed}|${hash}`;
}

function cacheGet(key: string): Buffer | null {
  const buf = ttsCache.get(key);
  if (!buf) return null;
  // Refresh recency (Map iteration order = insertion order).
  ttsCache.delete(key);
  ttsCache.set(key, buf);
  return buf;
}

function cacheSet(key: string, buf: Buffer): void {
  ttsCache.set(key, buf);
  let total = 0;
  for (const b of ttsCache.values()) total += b.byteLength;
  while (total > MAX_CACHE_BYTES && ttsCache.size > 1) {
    const oldestKey = ttsCache.keys().next().value;
    if (oldestKey === undefined) break;
    const oldest = ttsCache.get(oldestKey);
    total -= oldest?.byteLength ?? 0;
    ttsCache.delete(oldestKey);
  }
}

// ---------- Sanitization ----------

/** Collapse whitespace, strip markdown characters that pollute spoken audio. */
function sanitizeTtsText(text: string): string {
  return text
    .replace(/[*#`|_~>]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ---------- Synthesis ----------

export interface SynthOptions {
  voice?: string;
  speed?: number; // 0.5 .. 2.0
  language?: DocLanguage;
}

export async function synthesizeSpeech(
  text: string,
  opts: SynthOptions = {}
): Promise<{ buffer: Buffer; cacheHit: boolean }> {
  const o = opts;
  const requested = Number(o.speed ?? 1);
  const speed = Number.isFinite(requested) ? Math.min(2, Math.max(0.5, requested)) : 1;
  const lang: DocLanguage = o.language === "en" ? "en" : "fr";
  const voice = (o.voice ?? "").trim() || autoVoice(lang);

  const input = splitTtsText(sanitizeTtsText(text), 900)[0] ?? "";
  if (!input) {
    throw new Error("Synthèse vocale indisponible : le texte est vide.");
  }

  const key = cacheKey(voice, speed, input);
  const cached = cacheGet(key);
  if (cached) {
    console.log(`[tts] cache HIT (${voice}, x${speed}, ${cached.byteLength} octets)`);
    return { buffer: cached, cacheHit: true };
  }

  try {
    const zai = await getZaiClient();
    const response = await zai.audio.tts.create({
      input,
      voice,
      speed,
      response_format: "wav",
      stream: false,
    });
    const ab = await response.arrayBuffer();
    const buffer = Buffer.from(ab);
    if (!buffer.byteLength) throw new Error("réponse audio vide");
    cacheSet(key, buffer);
    console.log(`[tts] cache MISS → ${buffer.byteLength} octets (voix ${voice}, vitesse x${speed})`);
    return { buffer, cacheHit: false };
  } catch (err) {
    const message = err instanceof Error ? err.message : "erreur inconnue";
    throw new Error(`Synthèse vocale indisponible : ${message}`);
  }
}
