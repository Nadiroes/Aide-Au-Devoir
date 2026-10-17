// Exam engine — import parsing, course-linked resolution, biblical references,
// QCM bank (used by the Assistant) and the exam chat.
//
// Pipeline (mirrors the revision agents):
//   📋 Examinateur (structure the raw exam) → 🔍 Chercheur (retrieval over the
//   linked courses) → ✍️ Résolveur (answers, JSON) → 🧾 Vérificateur (refs).
//
// Theology/biblical context: when detected, answers ALWAYS carry biblical
// references (Livre Chapitre:Versets), even when the exam doesn't ask for
// them, so the student can verify the coherence of every answer.

import { db } from "@/lib/db";
import { getProvider, type LlmMessage } from "@/lib/llm";
import { fetchFullContents, searchChunks, tokenizeText } from "@/lib/search";
import { BIBLE_REF_PATTERN } from "@/lib/types";
import type { ProviderId } from "@/lib/types";

type Emit = (event: Record<string, unknown>) => void;

// ---------- Helpers ----------

/** Extracts the first JSON object/array embedded in an LLM answer. */
export function extractJson<T>(raw: string): T | null {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : raw;
  const start = candidate.search(/[[{]/);
  if (start === -1) return null;
  const end = Math.max(candidate.lastIndexOf("]"), candidate.lastIndexOf("}"));
  if (end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1)) as T;
  } catch {
    return null;
  }
}

const THEOLOGY_KEYWORDS = [
  "théologie", "theologie", "biblique", "biblique", "bible", "scripture", "écritures",
  "nouveau testament", "ancien testament", "exégèse", "exegete", "herméneutique",
  "grec biblique", "hébreu biblique", "pentateuque", "évangile", "evangile", "apôtre",
  "apotre", "psaume", "prophète", "prophete", "épître", "epitre", "christologie",
  "sotériologie", "soteriologie", "ecclésiologie", "ecclesiologie", "apologétique",
  "dogmatique", "pastorale", "homilétique", "candidat pastoral",
];

/** True when the text lives in a theology/biblical-studies context. */
export function detectTheology(...texts: string[]): boolean {
  const hay = texts.join(" ").toLowerCase();
  return THEOLOGY_KEYWORDS.some((k) => hay.includes(k));
}

/** Regex-based extraction of biblical references from a text (deduplicated). */
export function extractBibleRefs(...texts: string[]): string[] {
  const refs: string[] = [];
  for (const text of texts) {
    for (const m of text.matchAll(BIBLE_REF_PATTERN)) {
      const ref = (m[1] ?? "").trim();
      if (ref && !refs.some((r) => r.toLowerCase() === ref.toLowerCase())) refs.push(ref);
    }
  }
  return refs.slice(0, 8);
}

/** Derives a display title from the raw exam text. */
export function titleFromRawText(raw: string, fileName?: string | null): string {
  const firstLine = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 3);
  if (firstLine) {
    const clean = firstLine.replace(/[#*_>]/g, "").trim();
    return clean.length > 90 ? `${clean.slice(0, 87)}…` : clean;
  }
  return fileName ? fileName.replace(/\.[^.]+$/, "") : "Examen importé";
}

// ---------- Parsing (📋 Examinateur) ----------

export interface ParsedQuestion {
  type: "qcm" | "qa";
  prompt: string;
  options: string[];
}

export interface ParseResult {
  questions: ParsedQuestion[];
  kind: "qcm" | "qa" | "mixte";
  subject: string;
  theology: boolean;
  method: "llm" | "regex";
}

const EXAMINER_SYSTEM =
  "Tu es un examinateur minutieux. On te fournit le texte brut d'un examen, d'un QCM ou " +
  "d'un exercice. Extrais TOUTES les questions dans l'ordre, sans en inventer ni en oublier. " +
  'Réponds UNIQUEMENT avec du JSON strict de la forme : {"subject": "<matière brève en français>", ' +
  '"questions": [{"type": "qcm"|"qa", "prompt": "<énoncé complet>", "options": ["A. …", "B. …"]}]} ' +
  "Pour une question à choix multiples, liste TOUTES les options (A., B., C., D.) dans le champ " +
  '"options" (ne mets jamais la réponse). Pour une question ouverte, "options" est un tableau vide. ' +
  "Pas de commentaire autour du JSON.";

/** Regex fallback: numbered questions + "A) …" options. */
function parseExamRegex(raw: string): ParsedQuestion[] {
  const text = raw.replace(/\r\n?/g, "\n").trim();
  const blocks = text
    .split(/\n(?=\s*(?:\d{1,2}\s*[).:]|Question\s+\d+|Q\s?\d+\s*[).:]))/i)
    .map((b) => b.trim())
    .filter((b) => b.length > 8);

  const questions: ParsedQuestion[] = [];
  for (const block of blocks) {
    const optionLines: string[] = [];
    let promptLines: string[] = [];
    for (const line of block.split("\n")) {
      const m = line.match(/^\s*([A-Ha-h])\s*[).:]\s+(.+)$/);
      if (m && promptLines.length > 0) {
        optionLines.push(`${m[1].toUpperCase()}. ${m[2].trim()}`);
      } else {
        promptLines.push(line);
      }
    }
    let prompt = promptLines.join(" ").replace(/\s+/g, " ").trim();
    prompt = prompt.replace(/^\s*(?:\d{1,2}\s*[).:]|Question\s+\d+\s*[).:]?|Q\s?\d+\s*[).:])\s*/i, "").trim();
    if (prompt.length < 6) continue;
    if (optionLines.length >= 2) {
      questions.push({ type: "qcm", prompt, options: optionLines.slice(0, 8) });
    } else {
      questions.push({ type: "qa", prompt, options: [] });
    }
  }
  return questions;
}

/** Full parse: LLM first, regex fallback. Never throws — worst case 1 "qa". */
export async function parseExamText(
  raw: string,
  providerId: ProviderId,
  onLog?: (message: string) => void
): Promise<ParseResult> {
  const theology = detectTheology(raw);
  const provider = getProvider(providerId);

  try {
    onLog?.("Lecture de l'énoncé par l'examinateur…");
    const res = await provider.chat({
      messages: [
        { role: "system", content: EXAMINER_SYSTEM },
        { role: "user", content: raw.slice(0, 12_000) },
      ],
      temperature: 0.1,
    });
    const parsed = extractJson<{
      subject?: string;
      questions?: { type?: string; prompt?: string; options?: string[] }[];
    }>(res.content);

    const questions: ParsedQuestion[] = [];
    for (const q of parsed?.questions ?? []) {
      const prompt = String(q.prompt ?? "").trim();
      if (prompt.length < 6) continue;
      const options = (q.options ?? [])
        .map((o) => String(o).trim())
        .filter(Boolean)
        .slice(0, 8);
      const isQcm = (q.type === "qcm" || options.length >= 2) && q.type !== "qa";
      questions.push({
        type: isQcm ? "qcm" : "qa",
        prompt,
        options: isQcm ? options : [],
      });
    }

    if (questions.length) {
      onLog?.(`${questions.length} question(s) identifiée(s).`);
      const kind =
        questions.every((q) => q.type === "qcm")
          ? "qcm"
          : questions.every((q) => q.type === "qa")
            ? "qa"
            : "mixte";
      const subject = String(parsed?.subject ?? "").trim() || (theology ? "Théologie" : "Général");
      return { questions, kind, subject, theology, method: "llm" };
    }
    onLog?.("Extraction LLM vide — analyse structurelle de secours…");
  } catch (err) {
    onLog?.(
      `Examinateur indisponible (${err instanceof Error ? err.message : "erreur"}) — analyse de secours…`
    );
  }

  // Fallback
  const questions = parseExamRegex(raw);
  if (questions.length) {
    const kind =
      questions.every((q) => q.type === "qcm")
        ? "qcm"
        : questions.every((q) => q.type === "qa")
          ? "qa"
          : "mixte";
    return {
      questions,
      kind,
      subject: theology ? "Théologie" : "Général",
      theology,
      method: "regex",
    };
  }
  // Last resort: the whole text becomes one open question.
  return {
    questions: [{ type: "qa", prompt: raw.slice(0, 1200), options: [] }],
    kind: "qa",
    subject: theology ? "Théologie" : "Général",
    theology,
    method: "regex",
  };
}

// ---------- Course retrieval (🔍 Chercheur) ----------

export interface ExamRetrieval {
  context: string;
  hitTitles: string[];
}

/** BM25 retrieval restricted to the exam's linked courses (or global when none). */
export async function retrieveForExam(
  query: string,
  documentIds: string[]
): Promise<ExamRetrieval> {
  let hits = await searchChunks(query, documentIds.length ? 16 : 6);
  if (documentIds.length) {
    const allowed = new Set(documentIds);
    hits = hits.filter((h) => allowed.has(h.documentId)).slice(0, 6);
  }
  if (!hits.length) return { context: "(aucun extrait de cours pertinent)", hitTitles: [] };
  const full = await fetchFullContents(hits);
  const context = hits
    .map((h, i) => {
      const body = full.get(`${h.documentId}:${h.idx}`) ?? h.preview;
      return `[Extrait ${i + 1} — « ${h.title} »]\n${body.slice(0, 2000)}`;
    })
    .join("\n\n---\n\n");
  return { context, hitTitles: [...new Set(hits.map((h) => h.title))] };
}

// ---------- Resolution (✍️ Résolveur + 🧾 Vérificateur) ----------

export interface SolveResult {
  answer: string;
  refs: string[];
  rationale: string;
}

const SOLVER_BASE =
  "Tu es un professeur qui corrige un examen pour un élève français. Utilise en PRIORITÉ les " +
  "extraits de cours fournis (cite le titre du cours). Si l'information manque, réponds avec tes " +
  "connaissances en le signalant. Réponds UNIQUEMENT avec du JSON strict : " +
  '{"answer": "<réponse>", "refs": ["<référence 1>", "<référence 2>"], "rationale": "<justification courte, 1-4 phrases, citant le(s) cours ou passage(s) utilisés>"}';

const SOLVER_THEOLOGY =
  " CONTEXTE THÉOLOGIQUE/BIBLIQUE : cite systématiquement les références bibliques complètes " +
  "(Livre Chapitre:Versets, ex. « Jean 3:16 », « 1 Corinthiens 13:4-7 », « Genèse 1:1-3 ») dans " +
  "le tableau refs — MÊME SI L'EXERCICE NE LE DEMANDE PAS — afin que l'élève puisse vérifier la " +
  "cohérence de chaque réponse avec les Écritures. Utilise les noms français des livres.";

export async function solveExamQuestion(
  params: {
    prompt: string;
    options: string[];
    type: "qcm" | "qa";
    documentIds: string[];
    theology: boolean;
    examTitle: string;
  },
  providerId: ProviderId,
  onLog?: (message: string) => void
): Promise<SolveResult> {
  const provider = getProvider(providerId);
  const { context } = await retrieveForExam(params.prompt, params.documentIds);

  const isQcm = params.type === "qcm" && params.options.length >= 2;
  const instruction = isQcm
    ? "C'est un QCM : choisis la MEILLEURE option. Dans answer, mets d'abord la lettre puis le " +
      "texte de l'option (ex. « B. La justification par la foi »), puis explique pourquoi les " +
      "autres options principales sont incorrectes dans rationale."
    : "Réponds de façon complète mais concise (5-15 lignes), comme attendu à un examen.";

  const userBlock =
    `<cours>\n${context}\n</cours>\n\n` +
    `Examen : ${params.examTitle}\n` +
    `Question : ${params.prompt}\n` +
    (isQcm ? `Options :\n${params.options.map((o) => `- ${o}`).join("\n")}\n` : "") +
    `\n${instruction}`;

  const system = SOLVER_BASE + (params.theology ? SOLVER_THEOLOGY : "");

  try {
    onLog?.(isQcm ? "Analyse des options…" : "Rédaction de la réponse…");
    const res = await provider.chat({
      messages: [
        { role: "system", content: system },
        { role: "user", content: userBlock },
      ],
      temperature: 0.2,
    });
    const parsed = extractJson<{ answer?: string; refs?: unknown; rationale?: string }>(res.content);
    let answer = String(parsed?.answer ?? "").trim();
    let rationale = String(parsed?.rationale ?? "").trim();
    if (!answer) {
      // Model ignored the JSON contract — use the raw text as the answer.
      answer = res.content.trim();
      rationale = rationale || "Réponse directe du modèle (hors format JSON).";
    }

    // 🧾 Vérificateur: merge LLM refs + regex-detected biblical references.
    const refs = new Set<string>();
    for (const r of Array.isArray(parsed?.refs) ? (parsed.refs as unknown[]) : []) {
      const s = String(r).trim();
      if (s) refs.add(s.slice(0, 80));
    }
    for (const ref of extractBibleRefs(answer, rationale)) refs.add(ref);

    onLog?.(refs.size ? `Réponse prête (${refs.size} référence(s) citée(s)).` : "Réponse prête.");
    return { answer, refs: [...refs].slice(0, 8), rationale };
  } catch (err) {
    throw new Error(
      `Résolution impossible : ${err instanceof Error ? err.message : "erreur du modèle"}`
    );
  }
}

// ---------- QCM bank (banque de QCM pour l'Assistant) ----------

export interface QcmHit {
  questionId: string;
  examId: string;
  examTitle: string;
  idx: number;
  type: "qcm" | "qa";
  prompt: string;
  options: string[];
  answer: string | null;
  refs: string[];
  score: number;
}

/** Shared terms between the query and a stored question (0..1 overlap). */
function overlap(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  const setB = new Set(b);
  let shared = 0;
  for (const t of new Set(a)) if (setB.has(t)) shared += 1;
  return shared / Math.min(new Set(a).size, setB.size || 1);
}

/**
 * Searches the answered-questions bank (QCM + open questions) for entries that
 * match the user's query. The Assistant surfaces these as pre-validated
 * answers (green highlight on the correct option in the UI).
 */
export async function matchQcmBank(query: string, k = 3): Promise<QcmHit[]> {
  const rows = await db.examQuestion.findMany({
    where: { exam: {} },
    include: { exam: { select: { id: true, title: true, theology: true } } },
    orderBy: { createdAt: "desc" },
    take: 400,
  });
  const answered = rows.filter((r) => r.answer && r.answer.trim().length > 0);
  if (!answered.length) return [];

  const qTokens = tokenizeText(query);
  const scored: QcmHit[] = [];
  for (const row of answered) {
    const options = row.options ? (JSON.parse(row.options) as string[]) : [];
    const refs = row.refs ? (JSON.parse(row.refs) as string[]) : [];
    const hay = tokenizeText(`${row.prompt} ${options.join(" ")}`);
    const score = overlap(qTokens, hay);
    if (score < 0.22) continue;
    scored.push({
      questionId: row.id,
      examId: row.exam.id,
      examTitle: row.exam.title,
      idx: row.idx,
      type: row.type === "qcm" ? "qcm" : "qa",
      prompt: row.prompt,
      options,
      answer: row.answer,
      refs,
      score: Math.round(score * 100) / 100,
    });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k);
}

// ---------- Categories (rubrique « Réponses » de l'Assistant) ----------

/** Picks the rubric under which an assistant answer is filed. */
export function classifyCategory(
  question: string,
  answer: string,
  hitSubjects: string[],
  qcmHits: unknown[]
): string {
  if (qcmHits.length > 0) return "Examens & QCM";
  const subject = hitSubjects.find((s) => s && s !== "Général");
  if (subject) return subject;
  if (detectTheology(question, answer)) return "Théologie & Bible";
  return "Général";
}

// ---------- Exam chat (au fil de l'exercice) ----------

export interface ExamChatOptions {
  examId: string;
  question: string;
  providerId: ProviderId;
  history: { role: string; content: string }[];
  onToken: (token: string) => void | Promise<void>;
}

/** Streams an answer about the exam/homework, grounded in linked courses + the exam itself. */
export async function runExamChat(opts: ExamChatOptions): Promise<{
  content: string;
  refs: string[];
}> {
  const exam = await db.exam.findUnique({
    where: { id: opts.examId },
    include: { questions: { orderBy: { idx: "asc" } } },
  });
  if (!exam) throw new Error("Examen introuvable.");

  const documentIds = JSON.parse(exam.documentIds || "[]") as string[];
  const provider = getProvider(opts.providerId);

  const { context } = await retrieveForExam(opts.question, documentIds);

  const qSummary = exam.questions
    .slice(0, 30)
    .map((q) => {
      const options = q.options ? (JSON.parse(q.options) as string[]) : [];
      const opts = options.length ? ` (${options.join(" | ")})` : "";
      const ans = q.answer ? ` → RÉPONSE : ${q.answer}` : " (pas encore résolue)";
      return `${q.idx + 1}. ${q.prompt.slice(0, 300)}${opts}${ans}`;
    })
    .join("\n");

  const system =
    "Tu assistes un élève PENDANT un examen ou un devoir (« " +
    exam.title +
    " »). Réponds en français, en Markdown clair et concis. Appuie-toi sur l'extrait de cours " +
    "fourni et sur les réponses déjà données aux questions de l'examen. Si l'élève introduit un " +
    "QCM, désigne clairement la bonne option (lettre + texte) et justifie brièvement." +
    (exam.theology
      ? " CONTEXTE THÉOLOGIQUE : insère toujours les références bibliques complètes " +
        "(Livre Chapitre:Versets) utiles pour vérifier la cohérence, même si la question ne le " +
        "demande pas."
      : "");

  const messages: LlmMessage[] = [{ role: "system", content: system }];
  for (const h of opts.history.slice(-6)) {
    messages.push({ role: h.role === "user" ? "user" : "assistant", content: h.content.slice(0, 900) });
  }
  messages.push({
    role: "user",
    content:
      `<cours>\n${context}\n</cours>\n\n` +
      `Questions de l'examen et réponses déjà données :\n${qSummary || "(aucune)"}\n\n` +
      `Question de l'élève : ${opts.question}`,
  });

  const res = await provider.chat({
    messages,
    temperature: 0.3,
    onToken: opts.onToken,
  });
  const content = res.content.trim();
  return { content, refs: extractBibleRefs(content) };
}
