// POST /api/documents/[id]/save-pdf — enregistre le texte corrigé par l'élève.
// 1. Re-découpe le texte en segments (même logique que l'ingestion) et remplace
//    les anciens chunks en transaction (+ kind "pdf", status "prêt", note).
// 2. Génère un PDF propre (pdf-lib, Helvetica/WinAnsi, A4, marges 56 pt).
// 3. Écrit le fichier sur disque : upload/documents/{id}.pdf.
// 4. Invalide le cache de recherche.
// 5. Renvoie le DocumentDetailDTO à jour.
// Le PDF ensuite servi par GET /api/documents/[id]/pdf.

import { NextRequest, NextResponse } from "next/server";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import fs from "fs";
import path from "path";
import { db } from "@/lib/db";
import { chunkText } from "@/lib/ingestion";
import { invalidateSearchCache } from "@/lib/search";
import { getDocumentDetailDTO } from "@/lib/doc-dto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PDF_DIR = "/home/z/my-project/upload/documents";
const MAX_PDF_PAGES = 200;
const A4_WIDTH = 595.28;
const A4_HEIGHT = 841.89;
const MARGIN = 56;
const BODY_SIZE = 11;
const BODY_LINE_HEIGHT = 16;

/** Identifiant technique sûr (évite toute traversée de chemin). */
function isSafeId(id: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(id);
}

/** Titre → nom de fichier PDF : lettres/chiffres/espaces/tirets, max 80, + ".pdf". */
function sanitizePdfFileName(title: string): string {
  const base = title
    .replace(/[^\p{L}\p{N} \-]/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80)
    .trim();
  return `${base || "cours"}.pdf`;
}

// ---------- WinAnsi (CP1252) sanitization — pdf-lib StandardFonts throw on
// characters outside the encoding, so map common typographic glyphs to ASCII
// equivalents and drop anything else. ----------

const WINANSI_REPLACEMENTS: [RegExp, string][] = [
  [/[\u2018\u2019\u201A\u201B\u2032\u2035]/g, "'"],
  [/[\u201C\u201D\u201E\u201F\u2033\u2036]/g, '"'],
  [/[\u2012\u2013\u2014\u2015\u2212]/g, "-"],
  [/\u2026/g, "..."],
  [/[\u00A0\u202F\u2007\u2009\u200A\u200B]/g, " "],
  [/\u2022\u25CF\u25AA\u25E6/g, "-"],
  [/\t/g, "  "],
];

const WINANSI_ALLOWED =
  /^[\n\x20-\x7E\xA0-\xFF\u20AC\u201A\u0192\u201E\u2026\u2020\u2021\u02C6\u2030\u0160\u2039\u0152\u017D\u2018\u2019\u201C\u201D\u2022\u2013\u2014\u02DC\u2122\u0161\u203A\u0153\u017E\u0178]$/;

function toWinAnsi(input: string): string {
  let s = input;
  for (const [re, rep] of WINANSI_REPLACEMENTS) s = s.replace(re, rep);
  return [...s].filter((ch) => WINANSI_ALLOWED.test(ch)).join("");
}

// ---------- PDF rendering ----------

interface PdfHeader {
  title: string;
  subject: string;
  createdAt: Date;
}

async function buildCoursePdf(header: PdfHeader, rawText: string): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(toWinAnsi(header.title));
  pdf.setSubject(toWinAnsi(header.subject));
  pdf.setProducer("Aide au Devoir");
  pdf.setCreationDate(new Date());
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const ink = rgb(0.1, 0.1, 0.1);
  const gray = rgb(0.45, 0.45, 0.45);

  let page = pdf.addPage([A4_WIDTH, A4_HEIGHT]);
  let y = A4_HEIGHT - MARGIN;
  let truncated = false;

  const newPage = () => {
    page = pdf.addPage([A4_WIDTH, A4_HEIGHT]);
    y = A4_HEIGHT - MARGIN;
  };

  /** True if there is room for `needed` pt (new page if required, else truncate). */
  const ensureRoom = (needed: number): boolean => {
    if (truncated) return false;
    if (y - needed < MARGIN) {
      if (pdf.getPageCount() >= MAX_PDF_PAGES) {
        truncated = true;
        return false;
      }
      newPage();
    }
    return true;
  };

  const drawLine = (text: string, size: number, lineHeight: number, f = font, color = ink) => {
    if (!ensureRoom(lineHeight)) return;
    y -= lineHeight;
    page.drawText(text, { x: MARGIN, y, size, font: f, color });
  };

  /** Greedy word wrap measured with the real font (≈ 95 chars/line at 11 pt). */
  const wrap = (line: string, size: number, f = font): string[] => {
    const maxWidth = A4_WIDTH - MARGIN * 2;
    const out: string[] = [];
    let current = "";
    const pushCurrent = () => {
      out.push(current);
      current = "";
    };
    for (const word of line.split(" ")) {
      // Pathological tokens (URLs…) are hard-sliced character by character.
      if (f.widthOfTextAtSize(word, size) > maxWidth) {
        if (current) pushCurrent();
        let piece = "";
        for (const ch of word) {
          if (f.widthOfTextAtSize(piece + ch, size) > maxWidth) {
            out.push(piece);
            piece = ch;
          } else {
            piece += ch;
          }
        }
        current = piece;
        continue;
      }
      const candidate = current ? `${current} ${word}` : word;
      if (f.widthOfTextAtSize(candidate, size) > maxWidth) {
        if (current) pushCurrent();
        current = word;
      } else {
        current = candidate;
      }
    }
    if (current) out.push(current);
    return out.length ? out : [""];
  };

  // ---- Header: title (bold 18) + subject/date line (10 pt gray) ----
  for (const line of wrap(toWinAnsi(header.title), 18, bold)) {
    drawLine(line, 18, 24, bold);
  }
  drawLine(
    toWinAnsi(`${header.subject} — ${header.createdAt.toLocaleDateString("fr-FR")}`),
    10,
    16,
    font,
    gray
  );
  y -= 12; // spacing after the header block

  // ---- Body: paragraphs wrapped line by line, page breaks on demand ----
  for (const paragraph of rawText.split("\n")) {
    if (truncated) break;
    const clean = toWinAnsi(paragraph);
    if (!clean.trim()) {
      y -= 8; // blank line between paragraphs
      if (y - BODY_LINE_HEIGHT < MARGIN) {
        if (pdf.getPageCount() >= MAX_PDF_PAGES) {
          truncated = true;
          break;
        }
        newPage();
      }
      continue;
    }
    for (const line of wrap(clean, BODY_SIZE)) {
      if (!ensureRoom(BODY_LINE_HEIGHT)) break;
      y -= BODY_LINE_HEIGHT;
      page.drawText(line, { x: MARGIN, y, size: BODY_SIZE, font, color: ink });
    }
  }

  if (truncated) {
    page.drawText("... (tronqué)", { x: MARGIN, y: MARGIN, size: 10, font, color: gray });
  }

  return pdf.save();
}

// ---------- Route ----------

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!isSafeId(id)) {
    return NextResponse.json({ message: "Cours introuvable." }, { status: 404 });
  }

  const body = (await req.json().catch(() => null)) as { text?: unknown } | null;
  if (!body || typeof body.text !== "string" || !body.text.trim()) {
    return NextResponse.json(
      { message: "Texte manquant ou vide : impossible d'enregistrer le PDF." },
      { status: 400 }
    );
  }

  const existing = await db.document.findUnique({
    where: { id },
    select: { id: true, title: true, subject: true, createdAt: true },
  });
  if (!existing) {
    return NextResponse.json({ message: "Cours introuvable." }, { status: 404 });
  }

  const text = body.text.replace(/\r\n?/g, "\n").trim();

  // 1) Re-chunk + persist (same chunking as ingestion) — the agents "take
  //    knowledge" of the corrected text BEFORE the endpoint answers done.
  const chunks = chunkText(text);
  if (!chunks.length) {
    return NextResponse.json(
      { message: "Texte vide : impossible de le découper ou de générer un PDF." },
      { status: 400 }
    );
  }
  const fileName = sanitizePdfFileName(existing.title);
  await db.$transaction([
    db.chunk.deleteMany({ where: { documentId: id } }),
    db.document.update({
      where: { id },
      data: {
        textContent: text,
        chars: text.length,
        chunks: chunks.length,
        kind: "pdf",
        status: "prêt",
        fileName,
        note: "Texte corrigé par l'élève — PDF généré.",
      },
    }),
    db.chunk.createMany({
      data: chunks.map((c) => ({ documentId: id, idx: c.idx, content: c.content })),
    }),
  ]);

  // 2) Generate the clean PDF (A4, Helvetica, long docs supported, 200 p. cap).
  let bytes: Uint8Array;
  try {
    bytes = await buildCoursePdf(
      { title: existing.title, subject: existing.subject, createdAt: existing.createdAt },
      text
    );
  } catch (err) {
    return NextResponse.json(
      {
        message: `Génération du PDF impossible : ${
          err instanceof Error ? err.message : "erreur inconnue"
        }`,
      },
      { status: 500 }
    );
  }

  // 3) Persist the file on disk.
  fs.mkdirSync(PDF_DIR, { recursive: true });
  fs.writeFileSync(path.join(PDF_DIR, `${id}.pdf`), bytes);

  // 4) The chunks changed — the BM25 index must be rebuilt.
  invalidateSearchCache();

  // 5) Return the updated detail DTO.
  const dto = await getDocumentDetailDTO(id);
  if (!dto) {
    return NextResponse.json({ message: "Cours introuvable." }, { status: 404 });
  }
  return NextResponse.json(dto);
}
