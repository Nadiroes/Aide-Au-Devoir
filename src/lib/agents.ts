// Multi-agent chat pipeline (push-based, streamed over SSE).
// Planificateur → Chercheur (RAG) → Solveur → Tuteur
//
// The pipeline calls `emit(event)` for every ChatEvent; the SSE route wires
// emit() to the response stream, giving true real-time agent updates.

import { db } from "@/lib/db";
import { getProvider, type LlmMessage } from "@/lib/llm";
import { searchChunks, fetchFullContents, buildContext } from "@/lib/search";
import { matchQcmBank, classifyCategory } from "@/lib/exam";
import type { ChatEvent, ChatMode, ProviderId, QcmHit, RetrievalHit } from "@/lib/types";

export interface PipelineOptions {
  question: string;
  provider: ProviderId;
  mode: ChatMode;
  history?: { question: string; answer: string }[];
  signal?: AbortSignal;
}

type Emit = (event: ChatEvent) => void;

const PLANNER_SYSTEM =
  "Tu es un planificateur pédagogique. Décompose la question de l'élève en 3 sous-tâches " +
  "maximum, en français, sous forme de puces très courtes (- ...). Aucun commentaire supplémentaire.";

const SOLVER_SYSTEM =
  "Tu es un professeur particulier bienveillant qui aide un élève français. " +
  "Réponds en français, structuré en Markdown (titres courts, listes, étapes numérotées). " +
  "Appuie-toi en priorité sur les extraits fournis entre <cours>…</cours> et indique de quel " +
  "cours vient l'information (ex. : « d'après le cours … »). S'il existe des réponses déjà " +
  "validées dans <banque_qcm>…</banque_qcm> qui répondent à la question, appuie-toi dessus et " +
  "précise qu'elles viennent de la banque de QCM. Si l'information ne s'y trouve pas, réponds " +
  "avec tes connaissances en le signalant clairement. Si le contexte est théologique ou " +
  "biblique, insère les références bibliques complètes (Livre Chapitre:Versets) utiles, même si " +
  "elles ne sont pas demandées. Termine par une section **À retenir** de 2 à 3 puces.";

const TUTOR_SYSTEM =
  "À partir de la réponse du professeur, rédige une fiche élève en Markdown, simple et " +
  "encourageante, avec exactement : 1) **L'essentiel** (3 puces), 2) **Questions de vérification** " +
  "(2 questions avec leur réponse en italique juste dessous), 3) **Exercice d'application** " +
  "(1 mini-exercice + sa correction). Français, ton adapté à un élève.";

function aborted(signal?: AbortSignal): boolean {
  return Boolean(signal?.aborted);
}

export async function runChatPipeline(opts: PipelineOptions, emit: Emit): Promise<void> {
  const { question, provider: providerId, mode, history = [], signal } = opts;
  const provider = getProvider(providerId);

  emit({ type: "pipeline.start", question, provider: providerId, mode });

  // ---------- 1. Planificateur ----------
  let plan = "";
  try {
    if (aborted(signal)) return;
    emit({ type: "agent.start", id: "planner", label: "🧭 Planificateur" });
    emit({ type: "agent.log", id: "planner", message: "Décomposition de la question…" });
    const res = await provider.chat({
      messages: [
        { role: "system", content: PLANNER_SYSTEM },
        { role: "user", content: question },
      ],
      temperature: 0.2,
    });
    plan = res.content.trim();
    emit({
      type: "agent.done",
      id: "planner",
      label: "🧭 Planificateur",
      summary: "Plan établi",
      content: plan,
    });
  } catch (err) {
    emit({
      type: "agent.error",
      id: "planner",
      message: err instanceof Error ? err.message : "Erreur du planificateur",
    });
    emit({
      type: "pipeline.error",
      message: err instanceof Error ? err.message : "Le pipeline a échoué au planificateur.",
    });
    return;
  }

  if (aborted(signal)) return;

  // ---------- 2. Chercheur + banque de QCM ----------
  let hits: RetrievalHit[] = [];
  let qcmHits: QcmHit[] = [];
  let context = "(aucun extrait de cours pertinent)";
  emit({ type: "agent.start", id: "retriever", label: "🔍 Chercheur" });

  // The QCM bank is consulted in BOTH modes: an exam answer already treated is
  // the most reliable source, whatever the mode of the question.
  try {
    qcmHits = await matchQcmBank(question, 3);
    for (const hit of qcmHits) emit({ type: "qcm.hit", hit });
    if (qcmHits.length) {
      emit({
        type: "agent.log",
        id: "retriever",
        message: `${qcmHits.length} réponse(s) retrouvée(s) dans la banque de QCM.`,
      });
    }
  } catch {
    // Bank unavailable — continue without it.
  }

  if (mode === "libre") {
    emit({
      type: "agent.log",
      id: "retriever",
      message: "Mode question libre : les cours ne sont pas consultés.",
    });
    emit({
      type: "agent.done",
      id: "retriever",
      label: "🔍 Chercheur",
      summary: "Recherche ignorée (mode libre)",
    });
  } else {
    try {
      const docCount = await db.document.count();
      const chunkCount = await db.chunk.count();
      if (docCount === 0) {
        emit({
          type: "agent.log",
          id: "retriever",
          message: "Aucun cours importé — la réponse s'appuiera sur les connaissances générales.",
        });
      } else {
        emit({
          type: "agent.log",
          id: "retriever",
          message: `Recherche dans ${docCount} cours (${chunkCount} segments)…`,
        });
        hits = await searchChunks(question, 6);
        for (const hit of hits) emit({ type: "retrieval.hit", hit });
        emit({
          type: "agent.log",
          id: "retriever",
          message: hits.length
            ? `${hits.length} passage${hits.length > 1 ? "s" : ""} pertinent${hits.length > 1 ? "s" : ""} trouvé${hits.length > 1 ? "s" : ""}.`
            : "Aucun passage pertinent — réponse sur connaissances générales.",
        });
      }
      const full = hits.length ? await fetchFullContents(hits) : new Map<string, string>();
      context = buildContext(hits, full);
      emit({
        type: "agent.done",
        id: "retriever",
        label: "🔍 Chercheur",
        summary: hits.length ? `${hits.length} passage(s) retenu(s)` : "Prêt",
      });
    } catch (err) {
      emit({
        type: "agent.error",
        id: "retriever",
        message: err instanceof Error ? err.message : "Erreur du chercheur",
      });
      emit({
        type: "agent.done",
        id: "retriever",
        label: "🔍 Chercheur",
        summary: "Recherche en échec — réponse sans cours",
      });
    }
  }

  if (aborted(signal)) return;

  // ---------- 3. Solveur ----------
  let answer = "";
  try {
    emit({ type: "agent.start", id: "solver", label: "✍️ Solveur" });
    emit({ type: "agent.log", id: "solver", message: "Rédaction de la réponse, étape par étape…" });

    const qcmBlock = qcmHits.length
      ? qcmHits
          .map(
            (h, i) =>
              `[QCM ${i + 1} — « ${h.examTitle} »]
Question : ${h.prompt}
` +
              (h.options.length ? `Options : ${h.options.join(" | ")}\n` : "") +
              `Réponse validée : ${h.answer ?? ""}`
          )
          .join("\n\n")
      : "";

    const messages: LlmMessage[] = [{ role: "system", content: SOLVER_SYSTEM }];
    for (const h of history.slice(-3)) {
      messages.push({ role: "user", content: h.question });
      messages.push({ role: "assistant", content: h.answer.slice(0, 700) });
    }
    messages.push({
      role: "user",
      content:
        `<cours>\n${context}\n</cours>\n\n` +
        (qcmBlock ? `<banque_qcm>\n${qcmBlock}\n</banque_qcm>\n\n` : "") +
        `Plan proposé :\n${plan || "(non disponible)"}\n\nQuestion : ${question}`,
    });

    const res = await provider.chat({
      messages,
      temperature: 0.3,
      onToken: (token) => {
        if (!aborted(signal)) emit({ type: "answer.token", token });
      },
    });
    answer = res.content.trim();
    emit({ type: "agent.done", id: "solver", label: "✍️ Solveur", summary: "Réponse rédigée" });
  } catch (err) {
    emit({
      type: "agent.error",
      id: "solver",
      message: err instanceof Error ? err.message : "Erreur du solveur",
    });
    emit({
      type: "pipeline.error",
      message: err instanceof Error ? err.message : "Le pipeline a échoué au solveur.",
    });
    return;
  }

  if (aborted(signal)) return;

  // ---------- 4. Tuteur ----------
  let tutor = "";
  try {
    emit({ type: "agent.start", id: "tutor", label: "👨‍🏫 Tuteur" });
    emit({ type: "agent.log", id: "tutor", message: "Préparation de la fiche élève…" });
    const res = await provider.chat({
      messages: [
        { role: "system", content: TUTOR_SYSTEM },
        { role: "user", content: `Question : ${question}\n\nRéponse du professeur :\n${answer}` },
      ],
      temperature: 0.4,
    });
    tutor = res.content.trim();
    emit({ type: "agent.done", id: "tutor", label: "👨‍🏫 Tuteur", summary: "Fiche élève prête" });
  } catch (err) {
    emit({
      type: "agent.error",
      id: "tutor",
      message: err instanceof Error ? err.message : "Erreur du tuteur",
    });
    emit({ type: "agent.done", id: "tutor", label: "👨‍🏫 Tuteur", summary: "Fiche élève indisponible" });
  }

  // ---------- Persist + done ----------
  try {
    const category = classifyCategory(
      question,
      answer,
      hits.map((h) => h.subject),
      qcmHits
    );
    const saved = await db.chatMessage.create({
      data: {
        question,
        answer,
        tutor: tutor || null,
        plan: plan || null,
        provider: providerId,
        mode,
        category,
        sources: hits.length ? JSON.stringify(hits) : null,
        qcmSources: qcmHits.length ? JSON.stringify(qcmHits) : null,
      },
    });
    emit({ type: "pipeline.done", messageId: saved.id, answer, tutor, qcm: qcmHits, category });
  } catch {
    emit({ type: "pipeline.done", messageId: "", answer, tutor, qcm: qcmHits });
  }
}
