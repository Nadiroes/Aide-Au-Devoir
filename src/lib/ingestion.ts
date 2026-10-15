// Ingestion: extract text from PDF / DOCX / TXT / MD / images, then chunk for RAG.
// Images (PNG/JPEG) are read via the built-in vision model (OCR-quality), with a
// tesseract CLI fallback.

import mammoth from "mammoth";
import { extractText as extractPdfText } from "unpdf";
import ZAI from "z-ai-web-dev-sdk";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

export const SUPPORTED_EXTENSIONS = [".pdf", ".docx", ".txt", ".md", ".png", ".jpg", ".jpeg", ".webp"] as const;

export function kindFromFileName(fileName: string): string | null {
  const ext = fileName.toLowerCase().replace(/^.*(\.[^.]+)$/, "$1");
  if (!(SUPPORTED_EXTENSIONS as readonly string[]).includes(ext)) return null;
  return ext.slice(1);
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

// ---------- Extraction ----------

export interface ExtractResult {
  text: string;
  pages: number | null;
  method: string;
}

export async function extractText(fileName: string, buffer: Buffer): Promise<ExtractResult> {
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
