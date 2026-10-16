// Multi-agent revision pipeline (SSE, mirrors src/lib/agents.ts style).
// 🎯 Coach (asks the next question) → 🧐 Évaluateur (grades the answer vs the
// course) → 🧠 Mémoire (self-learning agent persisting insights).
//
// runRevision(body, emit) — the SSE route wires emit() to the response stream.

import { db } from "@/lib/db";
import { getProvider, type LlmMessage } from "@/lib/llm";
import { searchChunks, fetchFullContents } from "@/lib/search";
import { buildMemoryContext, applyMemoryOps, memoryToDTO, type MemoryOp } from "@/lib/memory";
import type {
  AgentMemoryDTO,
  DocLanguage,
  MemoryKind,
  ProviderId,
  QARating,
  RevisionEvent,
  RevisionQADTO,
  RevisionRequestBody,
  RevisionVerdict,
} from "@/lib/types";
import type { RevisionQA } from "@prisma/client";

type Emit = (event: RevisionEvent) => void;

const COACH_LABEL = "🎯 Coach";
const EVALUATOR_LABEL = "🧐 Évaluateur";
const LEARNER_LABEL = "🧠 Mémoire";

const VERDICT_LABELS: Record<RevisionVerdict, string> = {
  correct: "Correct",
  partly: "Partiel",
  wrong: "À revoir",
  info: "Information",
};

const MEMORY_KINDS: MemoryKind[] = ["weakness", "strength", "preference", "style", "context"];

// ---------- Prompts ----------

const COACH_QUESTION_SYSTEM =
  "Tu es un coach de révision bienveillant pour un élève. À partir des extraits du cours " +
  "fournis et du profil de l'élève, tu choisis LA prochaine question de révision : claire, " +
  "adaptée à son niveau, difficile juste ce qu'il faut. Aucun commentaire, uniquement la question.";

const EVALUATOR_SYSTEM =
  "Tu es un évaluateur bienveillant de révisions scolaires. Tu juges la réponse de l'élève " +
  "STRICTEMENT à partir du passage de cours fourni. Renvoie UNIQUEMENT un JSON valide : " +
  '{"verdict":"correct|partly|wrong","score":<0-100>,' +
  '"feedback":"1 à 3 phrases encourageantes et précises (précise ce qui manque si incomplet)",' +
  '"modelAnswer":"la réponse idéale, fidèle au cours, 1 à 4 phrases"}';

const ASK_SYSTEM =
  "Tu es le coach de révision. Réponds à la question de l'élève UNIQUEMENT à partir du passage " +
  "de cours fourni ; si le passage ne suffit pas dis-le honnêtement. 2 à 6 phrases claires.";

const LEARNER_SYSTEM =
  "Tu es l'agent auto-apprenant d'une application de révisions. Tu observes les échanges " +
  "élève/coach et tu entretiens une mémoire durable du profil de l'élève. Tu renvoies " +
  "UNIQUEMENT du JSON, aucun commentaire.";

// ---------- Small helpers ----------

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** RevisionQA row → RevisionQADTO. */
export function qaToDTO(row: RevisionQA): RevisionQADTO {
  return {
    id: row.id,
    documentId: row.documentId,
    question: row.question,
    answer: row.answer,
    feedback: row.feedback,
    verdict: row.verdict as RevisionVerdict,
    modelAnswer: row.modelAnswer,
    rating: (row.rating as QARating | null) ?? null,
    hidden: row.hidden,
    source: row.source,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Loose JSON extraction: strips ``` fences, takes first {…} / […] block. */
function parseJsonLoose(raw: string): unknown {
  let s = raw.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence && fence[1].trim()) s = fence[1].trim();
  try {
    return JSON.parse(s);
  } catch {
    const start = s.search(/[{[]/);
    const end = Math.max(s.lastIndexOf("}"), s.lastIndexOf("]"));
    if (start === -1 || end <= start) throw new Error("aucun JSON trouvé");
    return JSON.parse(s.slice(start, end + 1));
  }
}

/** 2 random distinct chunks (simple Fisher-Yates shuffle on a copy). */
function pickRandomChunks<T>(arr: T[], n: number): T[] {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, n);
}

/**
 * Course context for the evaluator/coach: BM25 hits filtered to the document
 * (top 2), falling back to the first ~1500 chars of the full text.
 */
async function retrieveCourseContext(
  query: string,
  documentId: string,
  textContent: string
): Promise<string> {
  try {
    const hits = (await searchChunks(query, 8))
      .filter((h) => h.documentId === documentId)
      .slice(0, 2);
    if (hits.length) {
      const full = await fetchFullContents(hits);
      return hits
        .map((h) => full.get(`${h.documentId}:${h.idx}`) ?? h.preview)
        .join("\n\n---\n\n");
    }
  } catch {
    // fall through to raw text
  }
  return textContent.slice(0, 1500);
}

/** Learner ops sanitization (max 3, valid kinds/ids only). */
function sanitizeMemoryOps(parsed: unknown): MemoryOp[] {
  if (!Array.isArray(parsed)) return [];
  const ops: MemoryOp[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    if (o.op === "add" && typeof o.content === "string" && o.content.trim()) {
      const kind = MEMORY_KINDS.includes(o.kind as MemoryKind) ? (o.kind as MemoryKind) : "context";
      ops.push({ op: "add", kind, content: o.content.trim().slice(0, 400) });
    } else if (o.op === "reinforce" && typeof o.id === "string") {
      ops.push({ op: "reinforce", id: o.id });
    } else if (o.op === "weaken" && typeof o.id === "string") {
      ops.push({ op: "weaken", id: o.id });
    }
    if (ops.length >= 3) break;
  }
  return ops;
}

interface EvalResult {
  verdict: RevisionVerdict;
  score: number;
  feedback: string;
  modelAnswer: string;
}

function parseEvaluation(raw: string): EvalResult {
  const fallback: EvalResult = {
    verdict: "info",
    score: 50,
    feedback: raw.trim().slice(0, 500) || "Évaluation indisponible.",
    modelAnswer: "",
  };
  try {
    const parsed = parseJsonLoose(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return fallback;
    const o = parsed as Record<string, unknown>;
    const verdictRaw = String(o.verdict ?? "").toLowerCase();
    const verdict: RevisionVerdict = ["correct", "partly", "wrong", "info"].includes(verdictRaw)
      ? (verdictRaw as RevisionVerdict)
      : "info";
    const scoreRaw = Number(o.score);
    const score = Number.isFinite(scoreRaw) ? Math.min(100, Math.max(0, Math.round(scoreRaw))) : 50;
    const feedback = typeof o.feedback === "string" && o.feedback.trim() ? o.feedback.trim() : fallback.feedback;
    const modelAnswer = typeof o.modelAnswer === "string" ? o.modelAnswer.trim() : "";
    return { verdict, score, feedback, modelAnswer };
  } catch {
    return fallback;
  }
}

// ---------- Pipeline ----------

export async function runRevision(body: RevisionRequestBody, emit: Emit): Promise<void> {
  try {
    const action = body.action;
    const documentId = String(body.documentId ?? "");
    if (!documentId) {
      emit({ type: "revision.error", message: "Aucun cours sélectionné pour la révision." });
      return;
    }

    const doc = await db.document.findUnique({ where: { id: documentId } });
    if (!doc) {
      emit({ type: "revision.error", message: "Cours introuvable." });
      return;
    }

    const language: DocLanguage = doc.language === "en" ? "en" : "fr";
    const langRule = `\n\nRéponds TOUJOURS dans la langue du cours : ${language === "en" ? "English." : "français."}`;
    const memoryContext = await buildMemoryContext(documentId);
    const memoryBlock = memoryContext
      ? `\n\nPROFIL DE L'ÉLÈVE (mémoire persistante des agents) :\n${memoryContext}`
      : "";

    emit({ type: "revision.start", action, documentId });

    const provider = getProvider((body.provider ?? "zai") as ProviderId);

    if (action === "greet") {
      await runGreet(doc.title, doc.chars, documentId, language, emit);
      return;
    }

    if (action === "question") {
      await runQuestion(provider.id, doc, body.avoidIds ?? [], memoryBlock, langRule, emit);
      return;
    }

    if (action === "answer") {
      await runAnswer(body, provider.id, doc, memoryBlock, langRule, emit);
      return;
    }

    if (action === "ask") {
      await runAsk(body, provider.id, doc, memoryBlock, langRule, emit);
      return;
    }

    emit({ type: "revision.error", message: `Action de révision inconnue : ${String(action)}` });
  } catch (err) {
    console.error("[revision] pipeline error:", err);
    emit({
      type: "revision.error",
      message: err instanceof Error
        ? err.message
        : "La révision a échoué de manière inattendue. Réessayez.",
    });
  }
}

// ---------- action: greet (post-import welcome, no LLM) ----------

async function runGreet(
  title: string,
  chars: number,
  documentId: string,
  language: DocLanguage,
  emit: Emit
): Promise<void> {
  const chunkCount = await db.chunk.count({ where: { documentId } });
  const seg = chunkCount > 1 ? "segments extraits" : "segment extrait";
  const langName = language === "en" ? "Anglais" : "Français";
  const greeting =
    `Bonjour ! J'ai fini de lire « ${title} » (${chunkCount} ${seg}, ` +
    `${chars.toLocaleString("fr-FR")} caractères, langue ${langName}). ` +
    `Je suis ton coach de révision : je vais te poser des questions sur ce cours et on verra ` +
    `ensemble ce qui est acquis. On commence la révision ?`;

  emit({ type: "agent.start", id: "coach", label: COACH_LABEL });
  for (const token of greeting.split(/(\s+)/)) {
    if (!token) continue;
    emit({ type: "message.token", token });
    await sleep(12);
  }
  emit({
    type: "agent.done",
    id: "coach",
    label: COACH_LABEL,
    summary: "Cours prêt",
    content: greeting,
  });
  emit({ type: "revision.done" });
}

// ---------- action: question (coach picks the NEXT question) ----------

async function runQuestion(
  providerId: ProviderId,
  doc: { id: string; title: string; subject: string },
  avoidIds: string[],
  memoryBlock: string,
  langRule: string,
  emit: Emit
): Promise<void> {
  emit({ type: "agent.start", id: "coach", label: COACH_LABEL });
  emit({
    type: "agent.log",
    id: "coach",
    message: "Analyse du cours, des questions déjà posées et de la mémoire…",
  });

  const provider = getProvider(providerId);
  const chunks = await db.chunk.findMany({
    where: { documentId: doc.id },
    orderBy: { idx: "asc" },
  });
  if (!chunks.length) throw new Error("Ce cours n'a aucun segment exploitable pour créer une question.");

  const recent = await db.revisionQA.findMany({
    where: { documentId: doc.id },
    orderBy: { createdAt: "desc" },
    take: 8,
    select: { id: true, question: true },
  });
  const avoidSet = new Set(avoidIds);
  const recentQs = recent.filter((q) => !avoidSet.has(q.id));

  const samples = pickRandomChunks(chunks, 2);
  emit({
    type: "agent.log",
    id: "coach",
    message: `${samples.length} extrait(s) du cours sélectionné(s)${recentQs.length ? `, ${recentQs.length} question(s) déjà posée(s) à éviter` : ""}.`,
  });

  const excerpts = samples.map((c) => `- ${c.content.slice(0, 1200)}`).join("\n---\n");
  const askedBlock = recentQs.length
    ? `\nDÉJÀ POSÉES (ne répète PAS) :\n${recentQs.map((q) => `- ${q.question}`).join("\n")}\n`
    : "\nAucune question posée pour l'instant.\n";

  const userPrompt =
    `Cours : « ${doc.title} » (matière : ${doc.subject})\n\n` +
    `EXTRAITS DU COURS :\n${excerpts}\n${askedBlock}\n` +
    `Choisis LA prochaine question de révision : une seule question claire, adaptée au niveau ` +
    `de l'élève (cible ses points faibles connus, évite ce qu'il maîtrise), difficulté ` +
    `progressive, maximum 2 phrases, termine par '?'. Ne mets AUCUN préambule ni commentaire : ` +
    `renvoie uniquement la question.`;

  const messages: LlmMessage[] = [
    { role: "system", content: COACH_QUESTION_SYSTEM + memoryBlock + langRule },
    { role: "user", content: userPrompt },
  ];

  const res = await provider.chat({
    messages,
    temperature: 0.6,
    onToken: (token) => emit({ type: "message.token", token }),
  });
  const question = res.content.trim();

  emit({
    type: "agent.done",
    id: "coach",
    label: COACH_LABEL,
    summary: question,
    content: question,
  });
  emit({ type: "revision.done" });
}

// ---------- action: answer (evaluate the user's answer) ----------

async function runAnswer(
  body: RevisionRequestBody,
  providerId: ProviderId,
  doc: { id: string; title: string; subject: string; textContent: string },
  memoryBlock: string,
  langRule: string,
  emit: Emit
): Promise<void> {
  const question = String(body.question ?? "").trim();
  const userAnswer = String(body.userAnswer ?? "").trim();
  if (!question) {
    emit({ type: "revision.error", message: "Question manquante pour l'évaluation." });
    return;
  }
  if (!userAnswer) {
    emit({ type: "revision.error", message: "Réponse vide" });
    return;
  }

  const provider = getProvider(providerId);

  // ----- Évaluateur -----
  emit({ type: "agent.start", id: "evaluator", label: EVALUATOR_LABEL });
  emit({
    type: "agent.log",
    id: "evaluator",
    message: "Recherche du passage de cours correspondant à la question…",
  });
  const courseContext = await retrieveCourseContext(question, doc.id, doc.textContent);

  emit({
    type: "agent.log",
    id: "evaluator",
    message: "Comparaison de la réponse de l'élève avec le cours…",
  });

  const evalMessages: LlmMessage[] = [
    { role: "system", content: EVALUATOR_SYSTEM + memoryBlock + langRule },
    {
      role: "user",
      content:
        `Cours « ${doc.title} »\n\nPASSAGE DU COURS :\n${courseContext}\n\n` +
        `QUESTION : ${question}\n\nRÉPONSE DE L'ÉLÈVE : ${userAnswer}`,
    },
  ];
  const evalRes = await provider.chat({ messages: evalMessages, temperature: 0.2 });
  const { verdict, score, feedback, modelAnswer } = parseEvaluation(evalRes.content);

  emit({ type: "evaluation", verdict, feedback, modelAnswer, score });

  const saved = await db.revisionQA.create({
    data: {
      documentId: doc.id,
      question,
      answer: userAnswer,
      feedback,
      verdict,
      modelAnswer,
      source: body.qaId ? "coach" : "user",
      hidden: false,
    },
  });
  emit({ type: "qa.saved", qa: qaToDTO(saved) });

  emit({
    type: "agent.done",
    id: "evaluator",
    label: EVALUATOR_LABEL,
    summary: `${VERDICT_LABELS[verdict]} — score ${score}/100`,
  });

  // ----- Mémoire (learner) -----
  await runLearner(providerId, doc.id, doc.title, question, userAnswer, verdict, score, emit);

  emit({ type: "revision.done" });
}

// ---------- learner (self-learning memory agent) ----------

async function runLearner(
  providerId: ProviderId,
  documentId: string,
  docTitle: string,
  question: string,
  userAnswer: string,
  verdict: RevisionVerdict,
  score: number,
  emit: Emit
): Promise<void> {
  emit({ type: "agent.start", id: "learner", label: LEARNER_LABEL });
  emit({
    type: "agent.log",
    id: "learner",
    message: "Analyse de l'échange pour la mémoire à long terme…",
  });

  const provider = getProvider(providerId);
  const existing = await db.agentMemory.findMany({
    where: { OR: [{ documentId: null }, { documentId }] },
    orderBy: [{ weight: "desc" }, { updatedAt: "desc" }],
    take: 15,
  });
  const memList = existing.length
    ? existing.map((m) => `- id=${m.id} [${m.kind}] ${m.content}`).join("\n")
    : "(aucune mémoire existante)";

  const userPrompt =
    `Cours : « ${docTitle} »\n\n` +
    `MÉMOIRE EXISTANTE DE L'ÉLÈVE :\n${memList}\n\n` +
    `ÉCHANGE OBSERVÉ :\n` +
    `Question du coach : ${question}\n` +
    `Réponse de l'élève : ${userAnswer.slice(0, 900)}\n` +
    `Verdict : ${verdict} (score ${score}/100)\n\n` +
    `Renvoie UNIQUEMENT un JSON (array) d'opérations max 3 : ` +
    `[{"op":"add","kind":"weakness|strength|preference|style|context","content":"observation stable et utile sur l'élève, 1 phrase"}] ` +
    `et/ou [{"op":"reinforce","id":"..."}] / [{"op":"weaken","id":"..."}]. ` +
    `add = nouvelle info durable (ex : 'Échoue sur les additions de fractions', 'Préfère les réponses courtes'). ` +
    `reinforce/weaken = l'observation existe déjà dans la mémoire (utilise son id). ` +
    `Ne renvoie [] si rien de notable. N'inclus PAS de contenu trop spécifique à une seule question.`;

  let ops: MemoryOp[] = [];
  try {
    const res = await provider.chat({
      messages: [
        { role: "system", content: LEARNER_SYSTEM },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.2,
    });
    ops = sanitizeMemoryOps(parseJsonLoose(res.content));
  } catch (err) {
    emit({
      type: "agent.log",
      id: "learner",
      message: `Mémoire indisponible cette fois : ${err instanceof Error ? err.message : "erreur"}.`,
    });
  }

  const before = new Set(
    (
      await db.agentMemory.findMany({
        where: { OR: [{ documentId: null }, { documentId }] },
        select: { id: true },
        take: 500,
      })
    ).map((m) => m.id)
  );

  const touched = await applyMemoryOps(ops, documentId);
  if (touched > 0) {
    const after = await db.agentMemory.findMany({
      where: { OR: [{ documentId: null }, { documentId }] },
      include: { document: { select: { title: true } } },
      orderBy: { createdAt: "desc" },
      take: 20,
    });
    for (const row of after) {
      if (before.has(row.id)) continue;
      const dto: AgentMemoryDTO = memoryToDTO(row);
      emit({ type: "memory.saved", memory: dto });
    }
  }

  const summary =
    touched <= 0
      ? "0 apprentissage notable"
      : `${touched} apprentissage${touched > 1 ? "s" : ""} enregistré${touched > 1 ? "s" : ""}`;
  emit({ type: "agent.done", id: "learner", label: LEARNER_LABEL, summary });
}

// ---------- action: ask (user's own question about the course) ----------

async function runAsk(
  body: RevisionRequestBody,
  providerId: ProviderId,
  doc: { id: string; title: string; subject: string; textContent: string },
  memoryBlock: string,
  langRule: string,
  emit: Emit
): Promise<void> {
  const question = String(body.question ?? "").trim();
  if (!question) {
    emit({ type: "revision.error", message: "Ta question est vide." });
    return;
  }

  emit({ type: "agent.start", id: "coach", label: COACH_LABEL });
  emit({ type: "agent.log", id: "coach", message: "Recherche de la réponse dans le cours…" });

  const provider = getProvider(providerId);
  const courseContext = await retrieveCourseContext(question, doc.id, doc.textContent);

  const messages: LlmMessage[] = [
    { role: "system", content: ASK_SYSTEM + memoryBlock + langRule },
    {
      role: "user",
      content:
        `Cours « ${doc.title} »\n\nPASSAGE DU COURS :\n${courseContext}\n\n` +
        `QUESTION DE L'ÉLÈVE : ${question}`,
    },
  ];

  const res = await provider.chat({
    messages,
    temperature: 0.3,
    onToken: (token) => emit({ type: "message.token", token }),
  });
  const full = res.content.trim();

  const saved = await db.revisionQA.create({
    data: {
      documentId: doc.id,
      question,
      answer: full,
      verdict: "info",
      modelAnswer: full,
      feedback: null,
      source: "user",
      hidden: false,
    },
  });
  emit({ type: "qa.saved", qa: qaToDTO(saved) });
  emit({ type: "agent.done", id: "coach", label: COACH_LABEL, summary: "Réponse donnée" });
  emit({ type: "revision.done" });
}
