// Ingestion: extract text from PDF / DOCX / EPUB / TXT / MD / images / audio,
// then chunk for RAG.
// - Images (PNG/JPEG) are read via the built-in vision model (OCR-quality), with
//   a tesseract CLI fallback.
// - EPUB files are unzipped (adm-zip): container.xml → OPF → spine XHTML files,
//   stripped of tags and HTML entities.
// - Audio files are converted to 16 kHz mono WAV segments with ffmpeg, then
//   transcribed with the built-in ASR (z-ai SDK).

import mammoth from "mammoth";
import { extractText as extractPdfText } from "unpdf";
import AdmZip from "adm-zip";
import ZAI from "z-ai-web-dev-sdk";
import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs";
import path from "path";
import { getZaiClient } from "@/lib/tts";

const execFileAsync = promisify(execFile);

export const SUPPORTED_EXTENSIONS = [
  ".pdf",
  ".docx",
  ".txt",
  ".md",
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".epub",
  ".mp3",
  ".wav",
  ".m4a",
  ".ogg",
  ".webm",
  ".aac",
  ".flac",
] as const;

/** Extensions whose extracted `kind` is normalized (not the raw extension). */
const KIND_OVERRIDES: Record<string, string> = {
  ".mp3": "audio",
  ".wav": "audio",
  ".m4a": "audio",
  ".ogg": "audio",
  ".webm": "audio",
  ".aac": "audio",
  ".flac": "audio",
};

export function kindFromFileName(fileName: string): string | null {
  const ext = fileName.toLowerCase().replace(/^.*(\.[^.]+)$/, "$1");
  if (!(SUPPORTED_EXTENSIONS as readonly string[]).includes(ext)) return null;
  return KIND_OVERRIDES[ext] ?? ext.slice(1);
}

// ---------- Image OCR ----------

async function ocrWithVision(buffer: Buffer, mime: string): Promise<string> {
  const zai = await ZAI.create();
  const dataUrl = `data:${mime};base64,${buffer.toString("base64")}`;
  const response = await zai.chat.completions.createVision({
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text:
              "Extrais TOUT le texte visible de cette image (cours, livre, schéma annoté, exercice). " +
              "Conserves la structure : titres, listes, formules (en notation texte lisible), " +
              "légendes. Ne commente pas, ne résume pas : renvoie uniquement le texte extrait.",
          },
          { type: "image_url", image_url: { url: dataUrl } },
        ],
      },
    ],
    thinking: { type: "disabled" },
  });
  const content = response.choices[0]?.message?.content ?? "";
  if (!content.trim()) throw new Error("Vision: réponse vide");
  return content;
}

async function ocrWithTesseract(buffer: Buffer): Promise<string> {
  const tmp = `/tmp/ocr-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const fs = await import("fs");
  fs.writeFileSync(tmp, buffer);
  try {
    const { stdout } = await execFileAsync("tesseract", [tmp, "stdout", "-l", "fra+eng"], {
      timeout: 60_000,
    });
    return stdout ?? "";
  } finally {
    fs.unlinkSync(tmp);
  }
}

async function extractImageText(buffer: Buffer, mime: string): Promise<string> {
  try {
    return await ocrWithVision(buffer, mime);
  } catch (err) {
    try {
      return await ocrWithTesseract(buffer);
    } catch {
      throw new Error(
        `Lecture de l'image impossible : ${err instanceof Error ? err.message : "erreur inconnue"}`
      );
    }
  }
}

// ---------- EPUB ----------

function xmlAttr(tag: string, name: string): string | null {
  const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i"));
  if (!m) return null;
  return (m[2] ?? m[3] ?? "").trim();
}

/** Resolves "./a/../b" style segments for paths inside the ZIP archive. */
function normalizeZipPath(p: string): string {
  const parts = p.replace(/^\/+/, "").split("/");
  const out: string[] = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return out.join("/");
}

function findEpubEntry(zip: AdmZip, zipPath: string): AdmZip.IZipEntry | null {
  const direct = zip.getEntry(zipPath);
  if (direct) return direct;
  const target = zipPath.toLowerCase();
  return zip.getEntries().find((e) => e.entryName.toLowerCase() === target) ?? null;
}

function readEpubText(entry: AdmZip.IZipEntry): string {
  return entry.getData().toString("utf8").replace(/^\uFEFF/, "");
}

function safeCodePoint(code: number): string {
  if (!Number.isFinite(code) || code < 9 || code > 0x10ffff) return " ";
  if ((code >= 0xd800 && code <= 0xdfff) || (code >= 0x7f && code < 0xa0)) return " ";
  try {
    return String.fromCodePoint(code);
  } catch {
    return " ";
  }
}

/** Common HTML named entities (French/Latin-1 focus) beyond the base set. */
const NAMED_ENTITIES: Record<string, string> = {
  eacute: "é", Eacute: "É", egrave: "è", Egrave: "È", agrave: "à", Agrave: "À",
  ecirc: "ê", Ecirc: "Ê", acirc: "â", icirc: "î", ocirc: "ô", ucirc: "û",
  ugrave: "ù", ccedil: "ç", Ccedil: "Ç", auml: "ä", euml: "ë", iuml: "ï",
  ouml: "ö", uuml: "ü", oelig: "œ", OElig: "Œ", laquo: "«", raquo: "»",
  mdash: "—", ndash: "–", hellip: "…", middot: "·", deg: "°", rsquo: "’",
  lsquo: "‘", ldquo: "“", rdquo: "”", euro: "€", copy: "©", reg: "®",
  trade: "™", szlig: "ß", sect: "§", para: "¶",
};

/**
 * XHTML/HTML → plain text: strips script/style/head blocks and comments, turns
 * block closings into newlines, strips the remaining tags, then decodes the
 * common HTML entities (named + numeric). `&amp;` is decoded last so that
 * "&amp;lt;" stays "&lt;" (single-pass decode).
 */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|head)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(
      /<\/(p|div|h[1-6]|li|tr|section|article|blockquote|figcaption|dd|dt)\s*>/gi,
      "\n"
    )
    .replace(/<[^>]+>/g, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&nbsp;/gi, " ")
    .replace(/&([A-Za-z][A-Za-z0-9]*);/g, (m, name: string) => NAMED_ENTITIES[name] ?? m)
    .replace(/&#(\d+);/g, (_m, code: string) => safeCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex: string) => safeCodePoint(parseInt(hex, 16)))
    .replace(/&amp;/gi, "&")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export interface EpubResult {
  text: string;
  chapters: number;
}

/**
 * Extracts the spine text of an EPUB (a ZIP: container.xml → OPF → XHTML files).
 * No XML parser dependency: manifest/spine are read with small regexes, which is
 * robust enough for standard EPUB 2/3 containers.
 */
export async function epubToText(buffer: Buffer): Promise<EpubResult> {
  let zip: AdmZip;
  try {
    zip = new AdmZip(buffer);
  } catch (err) {
    throw new Error(
      `EPUB illisible : archive corrompue (${err instanceof Error ? err.message : "erreur inconnue"}).`
    );
  }

  // 1) container.xml → rootfile full-path
  const containerEntry = findEpubEntry(zip, "META-INF/container.xml");
  if (!containerEntry) throw new Error("EPUB illisible : META-INF/container.xml introuvable.");
  const containerXml = readEpubText(containerEntry);
  const firstRootfile = containerXml.match(/<rootfile\b[^>]*>/i)?.[0] ?? "";
  const opfPath = xmlAttr(firstRootfile, "full-path");
  if (!opfPath) throw new Error("EPUB illisible : fichier OPF introuvable (rootfile sans full-path).");

  // 2) OPF → manifest + spine
  const opfEntry = findEpubEntry(zip, normalizeZipPath(opfPath));
  if (!opfEntry) throw new Error(`EPUB illisible : ${opfPath} introuvable dans l'archive.`);
  const opfXml = readEpubText(opfEntry);

  const manifest = new Map<string, { href: string; mediaType: string }>();
  for (const tag of opfXml.match(/<item\b[^>]*>/gi) ?? []) {
    const id = xmlAttr(tag, "id");
    const href = xmlAttr(tag, "href");
    if (!id || !href) continue;
    manifest.set(id, { href, mediaType: (xmlAttr(tag, "media-type") ?? "").toLowerCase() });
  }
  if (!manifest.size) throw new Error("EPUB illisible : manifest vide (aucun <item>).");

  const spineBlock = opfXml.match(/<spine\b[^>]*>([\s\S]*?)<\/spine>/i)?.[1] ?? "";
  const idrefs = (spineBlock.match(/<itemref\b[^>]*>/gi) ?? [])
    .map((tag) => xmlAttr(tag, "idref"))
    .filter((v): v is string => Boolean(v));
  const order = idrefs.length ? idrefs : [...manifest.keys()];

  // Base directory of the OPF, used to resolve relative manifest hrefs.
  const opfEntryName = opfEntry.entryName;
  const opfDir = opfEntryName.includes("/")
    ? opfEntryName.slice(0, opfEntryName.lastIndexOf("/") + 1)
    : "";

  // 3) Spine XHTML chapters → text
  const chapters: string[] = [];
  for (const id of order) {
    const item = manifest.get(id);
    if (!item) continue;
    const bareHref = item.href.split("#")[0];
    if (!bareHref) continue;
    const isHtml =
      item.mediaType.includes("html") || /\.(xhtml|html|htm)$/i.test(bareHref);
    if (!isHtml) continue;
    const entry = findEpubEntry(zip, normalizeZipPath(opfDir + decodeURIComponent(bareHref)));
    if (!entry) continue;
    let chapter = "";
    try {
      chapter = htmlToText(readEpubText(entry));
    } catch {
      continue; // unreadable chapter → skip
    }
    if (chapter) chapters.push(chapter);
  }

  if (!chapters.length) {
    throw new Error("EPUB illisible : aucun chapitre de texte trouvé dans le spine.");
  }
  return { text: chapters.join("\n\n"), chapters: chapters.length };
}

// ---------- Audio (ffmpeg → segments → ASR) ----------

const AUDIO_MAX_BYTES = 80 * 1024 * 1024; // 80 MB
const SEGMENT_SECONDS = 420; // 7 min per ASR segment
const FFMPEG_TIMEOUT_MS = 300_000;

/** Same multi-shape extraction as /api/asr (string | {text} | {data:{text}}). */
function extractAsrText(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (raw && typeof raw === "object") {
    const r = raw as Record<string, unknown>;
    if (typeof r.text === "string") return r.text;
    if (r.data && typeof r.data === "object") {
      const d = r.data as Record<string, unknown>;
      if (typeof d.text === "string") return d.text;
    }
  }
  return "";
}

async function transcribeAudioFile(
  buffer: Buffer,
  fileName: string,
  onProgress?: (message: string) => void
): Promise<{ text: string; segments: number }> {
  if (buffer.byteLength > AUDIO_MAX_BYTES) {
    throw new Error(
      "Fichier audio trop volumineux (max 80 Mo). Découpe-le ou convertis-le en mp3."
    );
  }

  const ext = (fileName.toLowerCase().match(/\.([a-z0-9]+)$/) ?? [])[1] || "bin";
  const dir = `/tmp/ad-audio-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  fs.mkdirSync(dir, { recursive: true });
  const inputPath = path.join(dir, `input.${ext}`);

  try {
    fs.writeFileSync(inputPath, buffer);

    // 1) ffmpeg: convert + split into 16 kHz mono WAV segments (max 420 s).
    try {
      await execFileAsync(
        "ffmpeg",
        [
          "-hide_banner",
          "-loglevel",
          "error",
          "-y",
          "-i",
          inputPath,
          "-vn", // drop cover art / video streams
          "-f",
          "segment",
          "-segment_time",
          String(SEGMENT_SECONDS),
          "-ac",
          "1",
          "-ar",
          "16000",
          path.join(dir, "seg_%03d.wav"),
        ],
        { timeout: FFMPEG_TIMEOUT_MS }
      );
    } catch (err) {
      const detail = err instanceof Error ? err.message : "erreur inconnue";
      throw new Error(`Conversion audio impossible (ffmpeg indisponible) : ${detail}`);
    }

    const segmentFiles = fs
      .readdirSync(dir)
      .filter((f) => /^seg_\d+\.wav$/i.test(f))
      .sort();
    if (!segmentFiles.length) {
      throw new Error(
        "Conversion audio impossible (ffmpeg indisponible) : aucun segment produit."
      );
    }

    // 2) ASR per segment, in order.
    const zai = await getZaiClient();
    const parts: string[] = [];
    for (let i = 0; i < segmentFiles.length; i++) {
      onProgress?.(`Transcription : segment ${i + 1}/${segmentFiles.length}…`);
      try {
        const wav = fs.readFileSync(path.join(dir, segmentFiles[i]));
        const result: unknown = await zai.audio.asr.create({
          file_base64: wav.toString("base64"),
        });
        parts.push(extractAsrText(result).trim());
      } catch {
        parts.push(`[segment ${i + 1} non transcrit]`);
      }
    }

    const text = parts.join(" ").replace(/\s+/g, " ").trim();
    const withoutMarkers = text.replace(/\[segment \d+ non transcrit\]/g, "").trim();
    if (!withoutMarkers) {
      throw new Error("Aucune parole détectée dans le fichier audio.");
    }
    return { text, segments: segmentFiles.length };
  } finally {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // best effort cleanup
    }
  }
}

// ---------- Extraction ----------

export interface ExtractResult {
  text: string;
  pages: number | null;
  method: string;
}

export async function extractText(
  fileName: string,
  buffer: Buffer,
  onProgress?: (message: string) => void
): Promise<ExtractResult> {
  const kind = kindFromFileName(fileName);
  if (!kind) throw new Error(`Format non supporté : ${fileName}`);

  switch (kind) {
    case "pdf": {
      const pdf = new Uint8Array(buffer);
      const { totalPages, text } = await extractPdfText(pdf, { mergePages: true });
      const merged = (Array.isArray(text) ? text.join("\n") : text) ?? "";
      if (merged.replace(/\s/g, "").length < 40) {
        throw new Error(
          "Ce PDF ne contient pas de texte extractible (probablement scanné). " +
            "Astuce : importez ses pages comme images PNG/JPEG, elles seront lues par OCR."
        );
      }
      return { text: merged, pages: totalPages ?? null, method: "PDF texte" };
    }
    case "docx": {
      const { value } = await mammoth.extractRawText({ buffer });
      if (!value.trim()) throw new Error("Document DOCX vide ou illisible.");
      return { text: value, pages: null, method: "DOCX" };
    }
    case "txt":
    case "md": {
      const text = buffer.toString("utf8");
      if (!text.trim()) throw new Error("Fichier texte vide.");
      return { text, pages: null, method: kind === "md" ? "Markdown" : "Texte" };
    }
    case "epub": {
      const { text, chapters } = await epubToText(buffer);
      const plural = chapters > 1 ? "s" : "";
      return {
        text,
        pages: null,
        method: `EPUB — ${chapters} chapitre${plural} extrait${plural}`,
      };
    }
    case "audio": {
      const { text, segments } = await transcribeAudioFile(buffer, fileName, onProgress);
      const plural = segments > 1 ? "s" : "";
      return {
        text,
        pages: null,
        method: `Transcription audio (ASR) — ${segments} segment${plural}`,
      };
    }
    case "png":
      return { text: await extractImageText(buffer, "image/png"), pages: 1, method: "OCR (vision)" };
    case "jpg":
    case "jpeg":
      return { text: await extractImageText(buffer, "image/jpeg"), pages: 1, method: "OCR (vision)" };
    case "webp":
      return { text: await extractImageText(buffer, "image/webp"), pages: 1, method: "OCR (vision)" };
    default:
      throw new Error(`Format non supporté : ${kind}`);
  }
}

// ---------- Chunking (French-aware) ----------

function normalizeText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const SENTENCE_SPLIT = /(?<=[.!?;:…])\s+(?=[A-ZÀ-ÖØ-Þ0-9«"'(\-—•\d])/;

export interface ChunkOut {
  idx: number;
  content: string;
}

/**
 * Splits text into overlapping chunks (~900 chars) on sentence boundaries when
 * possible, keeping the context of the previous chunk (overlap).
 */
export function chunkText(raw: string, target = 900, minChunk = 80): ChunkOut[] {
  const text = normalizeText(raw);
  if (!text) return [];

  const blocks = text.split(/\n{2,}/); // paragraphs / sections
  const sentences: string[] = [];
  for (const block of blocks) {
    const parts = block.split(SENTENCE_SPLIT).filter((s) => s.trim());
    if (parts.length <= 1) {
      sentences.push(block.trim());
    } else {
      sentences.push(...parts.map((s) => s.trim()));
    }
  }

  const chunks: string[] = [];
  let current = "";

  const push = () => {
    const c = current.trim();
    if (c.length >= minChunk) chunks.push(c);
    current = "";
  };

  for (const sentence of sentences) {
    // Sentence longer than target: hard-split it.
    if (sentence.length > target * 1.5) {
      push();
      for (let i = 0; i < sentence.length; i += target) {
        const piece = sentence.slice(i, i + target);
        if (piece.trim().length >= minChunk) chunks.push(piece.trim());
      }
      continue;
    }
    if ((current + " " + sentence).trim().length > target) {
      push();
      // Overlap: keep the tail of the previous chunk for context.
      const tail = chunks.length ? chunks[chunks.length - 1].slice(-180) : "";
      current = tail ? `${tail} … ` : "";
    }
    current = `${current} ${sentence}`.trim();
  }
  push();

  // Merge a tiny last chunk into the previous one.
  if (chunks.length >= 2 && chunks[chunks.length - 1].length < minChunk * 2) {
    const last = chunks.pop()!;
    chunks[chunks.length - 1] += ` … ${last}`;
  }

  return chunks.map((content, idx) => ({ idx, content }));
}
