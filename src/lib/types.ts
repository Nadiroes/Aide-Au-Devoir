// Shared types — API contracts between backend routes and frontend (client-safe).
// FROZEN CONTRACT (v2): both backend and frontend agents implement against this file.
// Do NOT modify without coordinating — every DTO/event below is used on both sides.

export type ProviderId = "zai" | "mistral" | "agnes";

export type ChatMode = "cours" | "libre";

export type AgentId =
  | "planner"
  | "retriever"
  | "solver"
  | "tutor"
  | "reader"
  | "chunker"
  | "indexer"
  | "coach" // asks revision questions (adapted from memory)
  | "evaluator" // evaluates user's answer vs course content
  | "learner" // self-learning agent (extracts insights into AgentMemory)
  | "examiner" // reads/structures an imported exam
  | "verifier"; // double-checks exam answers & references

export type AgentStatus = "idle" | "running" | "done" | "error";

export type DocLanguage = "fr" | "en";

export type QAFilter = "all" | "visible" | "hidden" | "arevoir" | "moyen" | "connu";

export type QASort = "recent" | "oldest" | "verdict" | "rating";

export type RevisionVerdict = "correct" | "partly" | "wrong" | "info";

export type QARating = "connu" | "moyen" | "arevoir";

export type MemoryKind = "weakness" | "strength" | "preference" | "style" | "context";

export type RevisionAction = "greet" | "question" | "answer" | "ask";

// ---------- Retrieval ----------

export interface RetrievalHit {
  documentId: string;
  title: string;
  subject: string;
  idx: number;
  score: number;
  preview: string;
}

// ---------- Chat pipeline events (SSE: POST /api/chat) ----------

export type ChatEvent =
  | { type: "pipeline.start"; question: string; provider: ProviderId; mode: ChatMode }
  | { type: "agent.start"; id: AgentId; label: string }
  | { type: "agent.log"; id: AgentId; message: string }
  | { type: "agent.done"; id: AgentId; label: string; summary: string; content?: string }
  | { type: "agent.error"; id: AgentId; message: string }
  | { type: "retrieval.hit"; hit: RetrievalHit }
  | { type: "answer.token"; token: string }
  | { type: "tutor.token"; token: string }
  | { type: "pipeline.done"; messageId: string; answer: string; tutor: string }
  | { type: "pipeline.error"; message: string };

// ---------- Ingestion events (SSE: POST /api/documents) ----------

export type IngestEvent =
  | { type: "ingest.start"; fileName: string; title: string; kind: string }
  | { type: "agent.start"; id: AgentId; label: string }
  | { type: "agent.log"; id: AgentId; message: string }
  | { type: "agent.done"; id: AgentId; label: string; summary: string }
  | { type: "agent.error"; id: AgentId; message: string }
  | { type: "ingest.done"; document: DocumentDTO }
  | { type: "ingest.error"; message: string };

// ---------- Revision pipeline events (SSE: POST /api/revision) ----------

export type RevisionEvent =
  | { type: "revision.start"; action: RevisionAction; documentId: string }
  | { type: "agent.start"; id: AgentId; label: string }
  | { type: "agent.log"; id: AgentId; message: string }
  | { type: "agent.done"; id: AgentId; label: string; summary: string; content?: string }
  | { type: "agent.error"; id: AgentId; message: string }
  /** coach/evaluator streamed message (greeting, question, feedback text) */
  | { type: "message.token"; token: string }
  /** structured evaluation result of a user's answer */
  | {
      type: "evaluation";
      verdict: RevisionVerdict;
      feedback: string;
      modelAnswer: string;
      score: number; // 0..100
    }
  /** persisted Q&A entry (question asked or answer evaluated) */
  | { type: "qa.saved"; qa: RevisionQADTO }
  /** learner agent stored a new/updated insight about the student */
  | { type: "memory.saved"; memory: AgentMemoryDTO }
  | { type: "revision.done"; }
  | { type: "revision.error"; message: string };

// ---------- DTOs ----------

export interface FolderDTO {
  id: string;
  name: string;
  color: string;
  documentCount: number;
  createdAt: string;
}

export interface DocumentDTO {
  id: string;
  title: string;
  subject: string;
  kind: string;
  fileName: string;
  status: string;
  chunks: number;
  chars: number;
  note?: string | null;
  language: DocLanguage;
  folderId?: string | null;
  folderName?: string | null;
  folderColor?: string | null;
  qaCount: number; // total stored Q&A for this doc
  qaToReview: number; // count with rating "arevoir"
  mastery: number; // 0..100 — % of rated QAs marked "connu"
  createdAt: string;
}

/** Full document payload for the revision workspace (includes editable text). */
export interface DocumentDetailDTO extends DocumentDTO {
  textContent: string;
}

export interface RevisionQADTO {
  id: string;
  documentId: string;
  question: string;
  answer: string;
  feedback?: string | null;
  verdict: RevisionVerdict;
  modelAnswer?: string | null;
  rating?: QARating | null;
  hidden: boolean;
  source: string;
  createdAt: string;
}

export interface AgentMemoryDTO {
  id: string;
  kind: MemoryKind;
  content: string;
  weight: number;
  hits: number;
  documentId?: string | null;
  documentTitle?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProviderStatusDTO {
  id: ProviderId;
  label: string;
  description: string;
  builtIn: boolean;
  configured: boolean;
  masked?: string | null;
  verifiedAt?: string | null;
  serverReady: boolean; // agnes: AGNES_BASE_URL set
  serverNote?: string;
}

export interface ChatMessageDTO {
  id: string;
  question: string;
  answer: string;
  tutor?: string | null;
  plan?: string | null;
  provider: string;
  mode: string;
  sources?: RetrievalHit[] | null;
  createdAt: string;
}

export interface StatsDTO {
  documents: number;
  folders: number;
  chunks: number;
  questions: number; // revision Q&A stored
  chatQuestions: number; // assistant chat history
  memoryCount: number;
  keysConfigured: number;
  languages: { fr: number; en: number };
}

export interface TtsVoiceDTO {
  id: string;
  label: string;
  description: string;
  bestFor: DocLanguage | "both";
}

/**
 * Server voices measured against French intelligibility (ASR round-trip test).
 * They are anglophone-oriented: for a native French accent prefer the
 * "system" engine (browser/OS French voice) — see TtsEngine.
 */
export const TTS_VOICES: TtsVoiceDTO[] = [
  { id: "chuichui", label: "Chuichui", description: "La plus claire en français (voix serveur)", bestFor: "fr" },
  { id: "tongtong", label: "Tongtong", description: "Chaleureuse — français approximatif", bestFor: "fr" },
  { id: "jam", label: "Jam", description: "Accent britannique — idéale pour l'anglais", bestFor: "en" },
  { id: "kazi", label: "Kazi", description: "Claire et posée (accent anglophone)", bestFor: "both" },
  { id: "xiaochen", label: "Xiaochen", description: "Calme et professionnelle", bestFor: "both" },
  { id: "douji", label: "Douji", description: "Fluide en anglais, faible en français", bestFor: "en" },
  { id: "luodo", label: "Luodo", description: "Expressive — mieux en anglais", bestFor: "en" },
];

/**
 * Audio engine for the reader:
 * - "system"  : the browser/OS built-in speech voices (native French accent,
 *               e.g. Amélie/Hortense/Google français) — RECOMMENDED for French.
 * - "serveur" : the Z.ai server voices (TTS_VOICES) — accent is anglophone.
 * - "auto"    : system when a French voice exists on the device, else server.
 */
export type TtsEngine = "auto" | "system" | "serveur";

/** Sample sentence used by the voice testers (settings + reader). */
export const TTS_SAMPLE_TEXT =
  "Au commencement, Dieu créa les cieux et la terre. C'est un test de prononciation française.";

/** Highlights biblical references (Jean 3:16, 1 Corinthiens 13, Psaume 23:1-6…) in text. */
export const BIBLE_REF_PATTERN =
  /\b((?:[1-3]\s?)?(?:Genèse|Exode|Lévitique|Nombres|Deutéronome|Josué|Juges|Ruth|Samuel|Rois|Chroniques|Esdras|Néhémie|Nehemie|Esther|Job|Psaumes?|Proverbes|Ecclésiaste|Ecclesiaste|Cantique|Ésaïe|Esaie|Jérémie|Jeremie|Lamentations|Ézéchiel|Ezechiel|Daniel|Osée|Osee|Joël|Joel|Amos|Abdias|Jonas|Michée|Michee|Nahum|Habacuc|Sophonie|Aggée|Aggee|Zacharie|Malachie|Matthieu|Marc|Luc|Jean|Actes|Romains|Corinthiens|Galates|Éphésiens|Ephesiens|Philippiens|Colossiens|Thessaloniciens|Timothée|Timothee|Tite|Philémon|Philemon|Hébreux|Hebreux|Jacques|Pierre|Jude|Judas|Apocalypse)\s\d{1,3}(?:\s?[,;:.–-]\s?\d{1,3}(?:[–-]\d{1,3})?)?)\b/gu;

/** POST /api/tts request body */
export interface TtsRequestBody {
  text: string; // max ~900 chars (server splits if longer, first chunk only)
  voice?: string; // default: auto per language (fr→tongtong, en→jam)
  speed?: number; // 0.5..2.0
  language?: DocLanguage; // optional hint; auto-detected if absent
}

// ---------- Exams ----------

export type ExamKind = "qcm" | "qa" | "mixte";
export type ExamLinkStatus = "pending" | "linked" | "sans";
export type ExamQuestionType = "qcm" | "qa";

export interface ExamQuestionDTO {
  id: string;
  idx: number;
  type: ExamQuestionType;
  prompt: string;
  options: string[]; // QCM options ("A. …", "B. …")
  answer?: string | null; // agent answer (option letter + text for QCM)
  refs: string[]; // biblical / course references cited
  rationale?: string | null; // justification + course excerpts used
  answered: boolean;
}

export interface ExamMessageDTO {
  id: string;
  role: "user" | "agent";
  content: string;
  refs: string[];
  createdAt: string;
}

export interface ExamDTO {
  id: string;
  title: string;
  subject: string;
  kind: ExamKind;
  fileName?: string | null;
  linkStatus: ExamLinkStatus;
  theology: boolean; // theology/biblical context detected
  questionCount: number;
  answeredCount: number;
  documentIds: string[];
  documentTitles: { id: string; title: string }[];
  createdAt: string;
}

export interface ExamDetailDTO extends ExamDTO {
  rawText: string;
  questions: ExamQuestionDTO[];
  messages: ExamMessageDTO[];
}

export type ExamPhase = "parse" | "solve" | "chat";

/** SSE events for /api/exams/[id]/parse | /solve | /chat */
export type ExamEvent =
  | { type: "exam.start"; phase: ExamPhase; examId: string }
  | { type: "agent.start"; id: AgentId; label: string }
  | { type: "agent.log"; id: AgentId; message: string }
  | { type: "agent.done"; id: AgentId; label: string; summary: string; content?: string }
  | { type: "agent.error"; id: AgentId; message: string }
  | {
      type: "exam.parsed";
      kind: ExamKind;
      subject: string;
      theology: boolean;
      questions: ExamQuestionDTO[];
    }
  | { type: "question.answered"; question: ExamQuestionDTO }
  | { type: "chat.token"; token: string }
  | { type: "chat.saved"; message: ExamMessageDTO }
  | { type: "exam.done" }
  | { type: "exam.error"; message: string };

export const EXAM_AGENT_ORDER: { id: AgentId; label: string }[] = [
  { id: "examiner", label: "📋 Examinateur" },
  { id: "retriever", label: "🔍 Chercheur" },
  { id: "solver", label: "✍️ Résolveur" },
  { id: "verifier", label: "🧾 Vérificateur" },
];

/** POST /api/revision request body */
export interface RevisionRequestBody {
  action: RevisionAction;
  documentId: string;
  provider?: ProviderId; // default "zai"
  /** action="answer": the Q&A being evaluated */
  qaId?: string; // if the question came from a stored coach QA
  question?: string; // question text (action="answer" | "ask")
  userAnswer?: string; // user's spoken/typed answer (action="answer")
  /** action="ask": user's own free question about the course */
  /** action="question": coach picks the next question (uses memory to adapt) */
  avoidIds?: string[]; // recent QA ids the coach should not repeat
}

export const CHAT_AGENT_ORDER: { id: AgentId; label: string }[] = [
  { id: "planner", label: "🧭 Planificateur" },
  { id: "retriever", label: "🔍 Chercheur" },
  { id: "solver", label: "✍️ Solveur" },
  { id: "tutor", label: "👨‍🏫 Tuteur" },
];

export const INGEST_AGENT_ORDER: { id: AgentId; label: string }[] = [
  { id: "reader", label: "📖 Lecteur" },
  { id: "chunker", label: "✂️ Découpeur" },
  { id: "indexer", label: "🗂️ Indexeur" },
];

export const REVISION_AGENT_ORDER: { id: AgentId; label: string }[] = [
  { id: "coach", label: "🎯 Coach" },
  { id: "evaluator", label: "🧐 Évaluateur" },
  { id: "learner", label: "🧠 Mémoire" },
];

export const MEMORY_KIND_LABELS: Record<MemoryKind, { label: string; icon: string; color: string }> = {
  weakness: { label: "Point faible", icon: "🎯", color: "text-rose-600 bg-rose-50 border-rose-200" },
  strength: { label: "Point fort", icon: "💪", color: "text-emerald-700 bg-emerald-50 border-emerald-200" },
  preference: { label: "Préférence", icon: "⭐", color: "text-amber-700 bg-amber-50 border-amber-200" },
  style: { label: "Style d'apprentissage", icon: "🧩", color: "text-teal-700 bg-teal-50 border-teal-200" },
  context: { label: "Contexte", icon: "📌", color: "text-stone-600 bg-stone-50 border-stone-200" },
};

export const VERDICT_META: Record<RevisionVerdict, { label: string; className: string; icon: string }> = {
  correct: { label: "Correct", className: "bg-emerald-100 text-emerald-800 border-emerald-300", icon: "✅" },
  partly: { label: "Partiel", className: "bg-amber-100 text-amber-800 border-amber-300", icon: "🟡" },
  wrong: { label: "À revoir", className: "bg-rose-100 text-rose-800 border-rose-300", icon: "❌" },
  info: { label: "Information", className: "bg-stone-100 text-stone-700 border-stone-300", icon: "ℹ️" },
};
