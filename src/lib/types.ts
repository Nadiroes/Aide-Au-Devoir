// Shared types — API contracts between backend routes and frontend (client-safe).

export type ProviderId = "zai" | "mistral" | "agnes";

export type ChatMode = "cours" | "libre";

export type AgentId = "planner" | "retriever" | "solver" | "tutor" | "reader" | "chunker" | "indexer";

export type AgentStatus = "idle" | "running" | "done" | "error";

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

// ---------- DTOs ----------

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
  createdAt: string;
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
  chunks: number;
  questions: number;
  keysConfigured: number;
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
