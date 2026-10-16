"use client";

// Révision guidée — coach Q&A SSE screen with permanent audio reader.
// Left column: course selector + meta + TTS player (before / during / after Q&A).
// Right column: toolbar (filter/sort/clear/export), greeting prompt, live
// streamed exchange (question → answer → evaluation), stored Q&A fiche,
// answer input with voice dictation (ASR) and agent status strip.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronDown,
  Download,
  Eye,
  EyeOff,
  Headphones,
  HelpCircle,
  AlertTriangle,
  Loader2,
  Mic,
  Pause,
  Play,
  RotateCcw,
  SendHorizonal,
  SkipForward,
  Sparkles,
  Square,
  Trash2,
  Volume2,
} from "lucide-react";
import { motion } from "framer-motion";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Progress } from "@/components/ui/progress";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { AgentStatusList, type AgentDisplay } from "@/components/agent-status";
import { MarkdownView } from "@/components/markdown-view";
import { useTtsPlayer } from "@/hooks/use-tts-player";
import { useRecorder } from "@/hooks/use-recorder";
import { getTtsPrefs } from "@/components/settings-section";
import { isAbortError, postSse } from "@/lib/sse-client";
import {
  clearQAs,
  deleteQA,
  fetchDocumentDetail,
  fetchFolders,
  fetchQAs,
  patchQA,
} from "@/lib/api-client";
import {
  REVISION_AGENT_ORDER,
  TTS_VOICES,
  VERDICT_META,
} from "@/lib/types";
import type {
  DocLanguage,
  DocumentDTO,
  DocumentDetailDTO,
  FolderDTO,
  QAFilter,
  QARating,
  QASort,
  RevisionEvent,
  RevisionQADTO,
  RevisionRequestBody,
  RevisionVerdict,
} from "@/lib/types";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

// ---------- Local constants ----------

const RATING_META: Record<QARating, { label: string; active: string }> = {
  connu: { label: "Je sais 👍", active: "bg-emerald-600 text-white border-emerald-600 hover:bg-emerald-700" },
  moyen: { label: "Moyen 🤔", active: "bg-amber-500 text-white border-amber-500 hover:bg-amber-600" },
  arevoir: { label: "À revoir 🔁", active: "bg-rose-600 text-white border-rose-600 hover:bg-rose-700" },
};

const FILTER_CHIPS: { id: QAFilter; label: string }[] = [
  { id: "all", label: "Tous" },
  { id: "visible", label: "Affichées" },
  { id: "hidden", label: "Effacées" },
  { id: "arevoir", label: "À revoir" },
  { id: "moyen", label: "Moyen" },
  { id: "connu", label: "Je sais" },
];

const SPEED_OPTIONS = ["0.75", "1", "1.25", "1.5"];

/** Minimal markdown strip so the TTS doesn't read asterisks and hashes. */
function stripMd(md: string): string {
  return md
    .replace(/[#*`>_~[\]()>-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function freshAgents(): AgentDisplay[] {
  return REVISION_AGENT_ORDER.map((a) => ({
    id: a.id,
    label: a.label,
    status: "idle" as const,
    logs: [],
  }));
}

interface LiveEvaluation {
  verdict: RevisionVerdict;
  feedback: string;
  modelAnswer: string;
  score: number;
}

interface LiveExchange {
  mode: "question" | "ask";
  /** Streamed coach text (the question, or the reply to a free question). */
  coach: string;
  /** User's answer (mode=question) or asked question (mode=ask). Null while awaiting answer. */
  userText: string | null;
  /** Streamed evaluator feedback. */
  feedback: string;
  evaluation: LiveEvaluation | null;
  qaId: string | null;
}

function timeLabel(iso: string): string {
  return new Date(iso).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
}

// ---------- Small pieces ----------

function EqBars() {
  return (
    <span className="eq-bars" aria-hidden="true">
      <span className="eq-bar" />
      <span className="eq-bar" style={{ animationDelay: "0.15s" }} />
      <span className="eq-bar" style={{ animationDelay: "0.3s" }} />
    </span>
  );
}

function RatingButtons({
  value,
  onRate,
  size = "sm",
}: {
  value: QARating | null;
  onRate: (rating: QARating) => void;
  size?: "sm" | "xs";
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Auto-évaluation">
      {(Object.keys(RATING_META) as QARating[]).map((rating) => {
        const meta = RATING_META[rating];
        const active = value === rating;
        return (
          <Button
            key={rating}
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onRate(rating)}
            aria-pressed={active}
            aria-label={`Auto-évaluation : ${meta.label}`}
            className={cn(
              "h-8 rounded-full px-3 text-xs",
              size === "xs" && "h-7 px-2.5 text-[11px]",
              active ? meta.active : "bg-transparent"
            )}
          >
            {meta.label}
          </Button>
        );
      })}
    </div>
  );
}

function QaCard({
  qa,
  deleting,
  onRate,
  onToggleHidden,
  onDelete,
  language,
}: {
  qa: RevisionQADTO;
  deleting: boolean;
  onRate: (rating: QARating) => void;
  onToggleHidden: () => void;
  onDelete: () => void;
  language: DocLanguage;
}) {
  const [expanded, setExpanded] = useState(false);

  if (qa.hidden) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-dashed bg-muted/30 px-3 py-2.5">
        <p className="text-xs text-muted-foreground">
          Réponse effacée de l&apos;écran — conservée dans la fiche 👁️
        </p>
        <Button
          variant="outline"
          size="sm"
          className="h-8 gap-1.5 text-xs"
          onClick={onToggleHidden}
          aria-label="Afficher à nouveau cette réponse"
        >
          <Eye className="size-3.5" aria-hidden="true" />
          Afficher
        </Button>
      </div>
    );
  }

  const verdict = VERDICT_META[qa.verdict];

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2 }}
      className="rounded-xl border p-3"
    >
      <div className="flex items-start justify-between gap-2">
        <p className="min-w-0 text-sm font-semibold">{qa.question}</p>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="size-8 text-muted-foreground hover:text-foreground"
            onClick={onToggleHidden}
            aria-label="Effacer cette réponse de l'écran"
          >
            <EyeOff className="size-4" aria-hidden="true" />
          </Button>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="size-8 text-red-500 hover:bg-red-50 hover:text-red-600"
                disabled={deleting}
                aria-label="Supprimer définitivement cette question"
              >
                {deleting ? (
                  <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                ) : (
                  <Trash2 className="size-4" aria-hidden="true" />
                )}
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Supprimer cette question ?</AlertDialogTitle>
                <AlertDialogDescription>
                  Elle sera définitivement retirée de la fiche de révision.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Annuler</AlertDialogCancel>
                <AlertDialogAction
                  className="bg-red-600 text-white hover:bg-red-700"
                  onClick={onDelete}
                >
                  Supprimer
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </div>

      {qa.answer ? (
        <p className="mt-1.5 whitespace-pre-wrap text-sm text-foreground/90">{qa.answer}</p>
      ) : null}

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Badge variant="outline" className={cn("text-[10px]", verdict.className)}>
          {verdict.icon} {verdict.label}
        </Badge>
        <span className="text-[11px] text-muted-foreground">{timeLabel(qa.createdAt)}</span>
      </div>

      {qa.feedback ? (
        <div className="mt-2">
          <div className={cn("text-xs text-muted-foreground", !expanded && "line-clamp-3")}>
            <MarkdownView content={qa.feedback} />
          </div>
          <button
            type="button"
            onClick={() => setExpanded((e) => !e)}
            className="mt-1 inline-flex min-h-8 items-center gap-1 text-[11px] font-medium text-emerald-700 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
            aria-expanded={expanded}
          >
            {expanded ? "Réduire" : "Lire tout le feedback"}
            <ChevronDown className={cn("size-3 transition-transform", expanded && "rotate-180")} aria-hidden="true" />
          </button>
        </div>
      ) : null}

      {qa.modelAnswer ? (
        <Collapsible>
          <CollapsibleTrigger className="mt-1 inline-flex min-h-8 items-center gap-1 text-[11px] font-medium text-emerald-700 outline-none focus-visible:ring-2 focus-visible:ring-ring">
            Réponse attendue
            <ChevronDown className="size-3" aria-hidden="true" />
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="mt-1 rounded-lg border bg-muted/40 p-2">
              <div className="text-xs text-muted-foreground">
                <MarkdownView content={qa.modelAnswer} />
              </div>
            </div>
          </CollapsibleContent>
        </Collapsible>
      ) : null}

      <div className="mt-3 border-t pt-2.5">
        <RatingButtons value={qa.rating ?? null} onRate={onRate} size="xs" />
      </div>
      <span className="sr-only">Langue du cours : {language === "fr" ? "français" : "anglais"}</span>
    </motion.div>
  );
}

// ---------- Main section ----------

export interface RevisionSectionProps {
  documents: DocumentDTO[];
  onDocumentsChanged: () => void;
  selectedDocumentId: string | null;
  onSelectDocument: (id: string) => void;
  greetDocumentId?: string | null;
  onGreetConsumed?: () => void;
  onOpenCourses?: () => void;
  onMemoryChanged?: () => void;
}

export function RevisionSection({
  documents,
  onDocumentsChanged,
  selectedDocumentId,
  onSelectDocument,
  greetDocumentId,
  onGreetConsumed,
  onOpenCourses,
  onMemoryChanged,
}: RevisionSectionProps) {
  const docId = selectedDocumentId;
  const currentDoc = useMemo(
    () => documents.find((d) => d.id === docId) ?? null,
    [documents, docId]
  );

  const [folders, setFolders] = useState<FolderDTO[]>([]);
  const [detail, setDetail] = useState<DocumentDetailDTO | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [qas, setQas] = useState<RevisionQADTO[]>([]);
  const [qasLoading, setQasLoading] = useState(false);
  const [filter, setFilter] = useState<QAFilter>("all");
  const [sort, setSort] = useState<QASort>("recent");
  const [deletingQaId, setDeletingQaId] = useState<string | null>(null);

  const [busy, setBusy] = useState(false);
  const [agents, setAgents] = useState<AgentDisplay[]>(freshAgents);
  const [live, setLive] = useState<LiveExchange | null>(null);
  const [liveRating, setLiveRating] = useState<QARating | null>(null);
  const [answerInput, setAnswerInput] = useState("");
  const [dismissedPrompt, setDismissedPrompt] = useState(false);

  // Audio reader preferences (persisted in Paramètres).
  const [voice, setVoice] = useState<string>("auto");
  const [speed, setSpeed] = useState<number>(1);

  const player = useTtsPlayer();
  const abortRef = useRef<AbortController | null>(null);
  const streamRef = useRef<HTMLDivElement | null>(null);
  const detailRef = useRef<DocumentDetailDTO | null>(null);
  const liveRef = useRef<LiveExchange | null>(null);

  const recorder = useRecorder((text) =>
    setAnswerInput((prev) => (prev.trim().length > 0 ? `${prev.trim()} ${text}` : text))
  );

  useEffect(() => {
    detailRef.current = detail;
  }, [detail]);

  // Mirror of the live exchange for use inside the SSE handler.
  useEffect(() => {
    liveRef.current = live;
  }, [live]);

  // Toast dictation errors.
  useEffect(() => {
    if (recorder.error) toast.error(recorder.error);
  }, [recorder.error]);

  // Auto-select the most recent course when entering the tab with nothing
  // selected (documents arrive sorted by createdAt desc → documents[0] is
  // the newest). Never overrides an existing selection.
  useEffect(() => {
    if (!selectedDocumentId && documents.length > 0) {
      onSelectDocument(documents[0].id);
    }
  }, [documents, selectedDocumentId, onSelectDocument]);

  // Load persisted TTS preferences once.
  useEffect(() => {
    const prefs = getTtsPrefs();
    setVoice(prefs.voice ?? "auto");
    setSpeed(prefs.speed ?? 1);
  }, []);

  // Non-critical: folder list for the grouped selector.
  useEffect(() => {
    void (async () => {
      try {
        setFolders(await fetchFolders());
      } catch {
        // Folders are optional — ignore silently.
      }
    })();
  }, []);

  // ---------- Data loading ----------

  const loadDetail = useCallback(async (id: string) => {
    setDetailLoading(true);
    try {
      setDetail(await fetchDocumentDetail(id));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Impossible de charger le cours");
    } finally {
      setDetailLoading(false);
    }
  }, []);

  const loadQas = useCallback(
    async (id: string) => {
      setQasLoading(true);
      try {
        setQas(await fetchQAs(id, { filter, sort }));
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Impossible de charger la fiche de révision");
      } finally {
        setQasLoading(false);
      }
    },
    [filter, sort]
  );

  // Document switch — hard reset of the workspace (stops audio too).
  useEffect(() => {
    player.stop();
    setLive(null);
    setLiveRating(null);
    setDismissedPrompt(false);
    setAgents(freshAgents());
    setBusy(false);
    abortRef.current?.abort();
    abortRef.current = null;
    setDetail(null);
    setQas([]);
    setAnswerInput("");
    if (docId) {
      void loadDetail(docId);
      void loadQas(docId);
    }
  }, [docId]);

  // Refetch when the filter / sort changes (same document).
  useEffect(() => {
    if (docId) void loadQas(docId);
  }, [filter, sort]);

  // Auto-scroll the Q&A stream while busy.
  useEffect(() => {
    if (busy && streamRef.current) {
      streamRef.current.scrollTop = streamRef.current.scrollHeight;
    }
  }, [live?.coach, live?.feedback, busy]);

  // ---------- SSE state machine ----------

  const patchAgent = useCallback((id: string, patch: Partial<AgentDisplay>) => {
    setAgents((prev) => prev.map((a) => (a.id === id ? { ...a, ...patch } : a)));
  }, []);

  const handleEvent = useCallback(
    (event: RevisionEvent) => {
      switch (event.type) {
        case "revision.start":
          break;
        case "agent.start":
          patchAgent(event.id, { status: "running", logs: [], summary: undefined, content: undefined });
          break;
        case "agent.log":
          setAgents((prev) =>
            prev.map((a) => (a.id === event.id ? { ...a, logs: [...a.logs, event.message] } : a))
          );
          break;
        case "agent.done": {
          patchAgent(event.id, { status: "done", summary: event.summary, content: event.content });
          // Optional auto-read: when the coach finishes an open question, speak it aloud.
          if (event.id === "coach" && getTtsPrefs().autoread && detailRef.current) {
            const current = liveRef.current;
            if (current && current.mode === "question" && current.userText === null && current.coach.trim().length > 0) {
              player.play(stripMd(current.coach), { language: detailRef.current.language });
            }
          }
          break;
        }
        case "agent.error":
          patchAgent(event.id, { status: "error", summary: event.message });
          toast.error(event.message);
          break;
        case "message.token":
          setLive((prev) => {
            const base: LiveExchange =
              prev ?? { mode: "question", coach: "", userText: null, feedback: "", evaluation: null, qaId: null };
            // Once the user's answer is in, tokens are evaluator feedback.
            if (base.mode === "question" && base.userText !== null) {
              return { ...base, feedback: base.feedback + event.token };
            }
            return { ...base, coach: base.coach + event.token };
          });
          break;
        case "evaluation":
          setLive((prev) => {
            if (!prev) return prev;
            return {
              ...prev,
              evaluation: {
                verdict: event.verdict,
                feedback: event.feedback,
                modelAnswer: event.modelAnswer,
                score: event.score,
              },
              feedback: prev.feedback.trim().length > 0 ? prev.feedback : event.feedback,
            };
          });
          break;
        case "qa.saved": {
          const qa = event.qa;
          const isQuestionOnly = !qa.answer || qa.answer.trim().length === 0;
          if (isQuestionOnly) {
            setLive((prev) => {
              const base: LiveExchange =
                prev ?? { mode: "question", coach: "", userText: null, feedback: "", evaluation: null, qaId: null };
              return {
                ...base,
                qaId: qa.id,
                coach: base.coach.trim().length > 0 ? base.coach : qa.question,
              };
            });
            // Auto-read preference: the coach question is spoken aloud.
            if (getTtsPrefs().autoread && detailRef.current) {
              player.play(stripMd(qa.question), { language: detailRef.current.language });
            }
          } else {
            setLive((prev) => (prev ? { ...prev, qaId: prev.qaId ?? qa.id } : prev));
            setQas((prev) => {
              const idx = prev.findIndex((q) => q.id === qa.id);
              if (idx === -1) return [qa, ...prev];
              const copy = [...prev];
              copy[idx] = qa;
              return copy;
            });
          }
          onDocumentsChanged();
          break;
        }
        case "memory.saved":
          onMemoryChanged?.();
          break;
        case "revision.done": {
          setBusy(false);
          setAgents((prev) =>
            prev.map((a) => (a.status === "running" ? { ...a, status: "done" as const } : a))
          );
          // Completed exchange (answered or free question) → collapses into the fiche.
          setLive((prev) => (prev && (prev.mode === "ask" || prev.userText !== null) ? null : prev));
          if (docId) {
            void loadQas(docId);
            void loadDetail(docId);
          }
          break;
        }
        case "revision.error":
          toast.error(event.message);
          setBusy(false);
          setAgents((prev) =>
            prev.map((a) => (a.status === "running" ? { ...a, status: "error" as const } : a))
          );
          break;
      }
    },
    [patchAgent, onDocumentsChanged, onMemoryChanged, docId, loadQas, loadDetail]
  );

  const runRevision = useCallback(
    async (body: RevisionRequestBody) => {
      if (!docId || busy) return;
      setBusy(true);
      setAgents(freshAgents());
      const controller = new AbortController();
      abortRef.current = controller;
      try {
        await postSse<RevisionEvent>("/api/revision", body, handleEvent, controller.signal);
      } catch (err) {
        if (isAbortError(err)) {
          toast.info("Flux interrompu");
          setAgents((prev) =>
            prev.map((a) => (a.status === "running" ? { ...a, status: "idle" as const } : a))
          );
        } else {
          toast.error(err instanceof Error ? err.message : "Erreur pendant la révision");
          setAgents((prev) =>
            prev.map((a) => (a.status === "running" ? { ...a, status: "error" as const } : a))
          );
        }
      } finally {
        abortRef.current = null;
        setBusy(false);
      }
    },
    [docId, busy, handleEvent]
  );

  // ---------- Actions ----------

  const nextQuestion = useCallback(() => {
    if (!docId || busy) return;
    setLive(null);
    setLiveRating(null);
    void runRevision({
      action: "question",
      documentId: docId,
      avoidIds: qas.slice(0, 10).map((q) => q.id),
    });
  }, [docId, busy, qas, runRevision]);

  const startFromGreet = () => {
    setDismissedPrompt(true);
    onGreetConsumed?.();
    nextQuestion();
  };

  const submitAnswer = () => {
    const text = answerInput.trim();
    if (!docId || busy || !live || live.mode !== "question" || live.userText !== null) return;
    if (text.length === 0 || live.coach.trim().length === 0) return;
    setLive({ ...live, userText: text, feedback: "", evaluation: null });
    setLiveRating(null);
    setAnswerInput("");
    void runRevision({
      action: "answer",
      documentId: docId,
      qaId: live.qaId ?? undefined,
      question: live.coach,
      userAnswer: text,
    });
  };

  const askCoach = () => {
    const q = answerInput.trim();
    if (!docId || busy || q.length === 0) return;
    setLive({ mode: "ask", coach: "", userText: q, feedback: "", evaluation: null, qaId: null });
    setLiveRating(null);
    setAnswerInput("");
    void runRevision({ action: "ask", documentId: docId, question: q });
  };

  const stopStream = () => {
    abortRef.current?.abort();
  };

  const rateStoredQa = async (id: string, rating: QARating) => {
    try {
      const updated = await patchQA(id, { rating });
      setQas((prev) => prev.map((q) => (q.id === id ? updated : q)));
      toast.success("Auto-évaluation enregistrée — l'assistant s'en souviendra");
      onDocumentsChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Évaluation impossible");
    }
  };

  const rateLiveQa = async (rating: QARating) => {
    if (!live?.qaId) return;
    setLiveRating(rating);
    try {
      await patchQA(live.qaId, { rating });
      toast.success("Auto-évaluation enregistrée — l'assistant s'en souviendra");
      onDocumentsChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Évaluation impossible");
      setLiveRating(null);
    }
  };

  const toggleHidden = async (qa: RevisionQADTO) => {
    try {
      const updated = await patchQA(qa.id, { hidden: !qa.hidden });
      setQas((prev) => prev.map((q) => (q.id === qa.id ? updated : q)));
      if (docId) void loadDetail(docId);
      onDocumentsChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Action impossible");
    }
  };

  const removeQa = async (id: string) => {
    setDeletingQaId(id);
    try {
      await deleteQA(id);
      setQas((prev) => prev.filter((q) => q.id !== id));
      toast.success("Question supprimée de la fiche");
      if (docId) void loadDetail(docId);
      onDocumentsChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Suppression impossible");
    } finally {
      setDeletingQaId(null);
    }
  };

  const handleClearShown = async () => {
    if (!docId) return;
    try {
      await clearQAs({ documentId: docId, mode: "shown" });
      toast.success("Réponses effacées de l'écran (conservées dans la fiche)");
      await loadQas(docId);
      void loadDetail(docId);
      onDocumentsChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Action impossible");
    }
  };

  const handleShowAll = async () => {
    if (!docId) return;
    try {
      // The backend has no bulk "unhide": re-show hidden entries one by one.
      const hidden = await fetchQAs(docId, { filter: "hidden" });
      await Promise.all(hidden.map((qa) => patchQA(qa.id, { hidden: false })));
      toast.success("Toutes les réponses sont affichées à nouveau");
      await loadQas(docId);
      void loadDetail(docId);
      onDocumentsChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Action impossible");
    }
  };

  const exportMarkdown = () => {
    if (!detail) return;
    const visible = qas.filter((q) => !q.hidden);
    if (visible.length === 0) {
      toast.info("Aucune réponse visible à exporter");
      return;
    }
    const lines: string[] = [
      `# Fiche de révision — ${detail.title}`,
      "",
      `_Matière : ${detail.subject} · ${visible.length} question(s) · exportée le ${new Date().toLocaleDateString("fr-FR")}_`,
      "",
    ];
    visible.forEach((qa, i) => {
      const verdict = VERDICT_META[qa.verdict];
      lines.push(`## ${i + 1}. ${qa.question}`, "");
      lines.push(`**Ma réponse :** ${qa.answer && qa.answer.trim().length > 0 ? qa.answer : "—"}`, "");
      lines.push(`**Verdict :** ${verdict.icon} ${verdict.label}`);
      if (qa.rating) lines.push(`**Auto-évaluation :** ${RATING_META[qa.rating].label}`);
      if (qa.feedback) lines.push("", `**Feedback du coach :** ${qa.feedback}`);
      if (qa.modelAnswer) lines.push("", `**Réponse attendue :** ${qa.modelAnswer}`);
      lines.push("", "---", "");
    });
    const blob = new Blob([lines.join("\n")], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = window.document.createElement("a");
    a.href = url;
    a.download = `${detail.title.replace(/[^\p{L}\p{N}]+/gu, "-").toLowerCase()}-fiche-revision.md`;
    window.document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    toast.success("Fiche de révision exportée en .md");
  };

  // ---------- Derived ----------

  const qaCount = detail?.qaCount ?? currentDoc?.qaCount ?? 0;
  const qaToReview = detail?.qaToReview ?? currentDoc?.qaToReview ?? 0;
  const language: DocLanguage = detail?.language ?? currentDoc?.language ?? "fr";
  const coachRunning = agents.find((a) => a.id === "coach")?.status === "running";
  const evaluatorRunning = agents.find((a) => a.id === "evaluator")?.status === "running";
  const agentsVisible = agents.some((a) => a.status !== "idle");

  const showGreeting =
    Boolean(detail) &&
    !busy &&
    !live &&
    !dismissedPrompt &&
    (greetDocumentId === docId || qas.length === 0);

  const showEmptyState = !detailLoading && !showGreeting && !live && !busy && qas.length === 0 && !qasLoading;

  const grouped = useMemo(() => {
    if (folders.length === 0) return null;
    const groups = folders
      .map((f) => ({ folder: f, docs: documents.filter((d) => d.folderId === f.id) }))
      .filter((g) => g.docs.length > 0);
    const without = documents.filter((d) => !d.folderId || !folders.some((f) => f.id === d.folderId));
    return { groups, without };
  }, [folders, documents]);

  const renderDocItem = (doc: DocumentDTO) => (
    <SelectItem key={doc.id} value={doc.id}>
      {doc.title} ({doc.subject})
    </SelectItem>
  );

  // ---------- Render ----------

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold md:text-3xl">Révision</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Le coach pose des questions sur ton cours, évalue tes réponses et retient tes points faibles.
        </p>
      </div>

      {documents.length === 0 ? (
        <Card className="gap-0 py-0">
          <CardContent className="flex flex-col items-center gap-3 p-10 text-center">
            <EmptyCoursesArt />
            <p className="text-sm text-muted-foreground">
              Aucun cours à réviser pour l&apos;instant — importe d&apos;abord un document.
            </p>
            {onOpenCourses && (
              <Button
                onClick={onOpenCourses}
                className="mt-2 h-11 bg-emerald-600 text-white hover:bg-emerald-700"
              >
                Aller à mes cours
              </Button>
            )}
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-6 lg:grid-cols-5">
          {/* ============ LEFT — Mon cours ============ */}
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.25 }}
            className="space-y-4 lg:col-span-2"
          >
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">📚 Mon cours</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <Select value={docId ?? ""} onValueChange={(v) => onSelectDocument(v)}>
                  <SelectTrigger className="h-11 w-full" aria-label="Choisir le cours à réviser">
                    <SelectValue placeholder="Choisis un cours à réviser" />
                  </SelectTrigger>
                  <SelectContent className="max-h-72">
                    {grouped ? (
                      <>
                        {grouped.groups.map((g) => (
                          <SelectGroup key={g.folder.id}>
                            <SelectLabel>{g.folder.name}</SelectLabel>
                            {g.docs.map(renderDocItem)}
                          </SelectGroup>
                        ))}
                        {grouped.without.length > 0 && (
                          <SelectGroup>
                            <SelectLabel>Sans dossier</SelectLabel>
                            {grouped.without.map(renderDocItem)}
                          </SelectGroup>
                        )}
                      </>
                    ) : (
                      documents.map(renderDocItem)
                    )}
                  </SelectContent>
                </Select>

                {detailLoading && (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                    Chargement du cours…
                  </div>
                )}

                {detail && !detailLoading && (
                  <>
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge
                        variant="outline"
                        className={cn(
                          "text-[10px] font-semibold uppercase",
                          language === "fr"
                            ? "border-emerald-300 bg-emerald-50 text-emerald-700"
                            : "border-amber-300 bg-amber-50 text-amber-700"
                        )}
                      >
                        {language === "fr" ? "FR" : "EN"}
                      </Badge>
                      <Badge variant="secondary">{detail.subject}</Badge>
                      <Badge variant="outline" className="text-[10px]">
                        {detail.chunks} segments
                      </Badge>
                    </div>

                    <div className="space-y-1.5">
                      <div className="flex items-center justify-between text-xs">
                        <span className="text-muted-foreground">Maîtrise</span>
                        <span className="font-semibold">
                          {detail.qaCount === 0
                            ? "Pas encore évalué"
                            : `Maîtrise : ${detail.mastery} %`}
                        </span>
                      </div>
                      <Progress
                        value={detail.qaCount === 0 ? 0 : detail.mastery}
                        aria-label="Maîtrise du cours"
                      />
                    </div>
                  </>
                )}
              </CardContent>
            </Card>

            {/* Audio reader — preparation state while the document loads */}
            {(detailLoading || detail) && (
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="flex items-center gap-2 text-base">
                    <Headphones className="size-4 text-emerald-600" aria-hidden="true" />
                    Lecture audio
                  </CardTitle>
                  <CardDescription>
                    Écoute avant, pendant ou après les questions — à ton rythme.
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                  {detailLoading && !detail ? (
                    <div
                      className="flex items-center gap-3 rounded-lg border border-dashed bg-muted/30 px-4 py-6"
                      role="status"
                      aria-live="polite"
                    >
                      <Loader2
                        className="size-5 shrink-0 animate-spin text-emerald-600"
                        aria-hidden="true"
                      />
                      <div className="min-w-0">
                        <p className="text-sm font-medium">
                          Préparation du document pour la lecture…
                        </p>
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          Le texte du cours est assemblé pour la synthèse vocale.
                        </p>
                      </div>
                    </div>
                  ) : detail ? (
                    <>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      type="button"
                      onClick={() => {
                        if (player.status === "idle" || player.status === "paused") {
                          if (player.status === "idle") {
                            player.play(detail.textContent, {
                              voice: voice === "auto" ? undefined : voice,
                              speed,
                              language,
                            });
                          } else {
                            player.resume();
                          }
                        } else {
                          player.pause();
                        }
                      }}
                      disabled={detail.textContent.trim().length === 0}
                      aria-label={
                        player.status === "playing"
                          ? "Mettre la lecture en pause"
                          : "Lancer la lecture audio du cours"
                      }
                      className="h-12 gap-2 bg-emerald-600 px-5 text-white hover:bg-emerald-700"
                    >
                      {player.status === "loading" ? (
                        <Loader2 className="size-5 animate-spin" aria-hidden="true" />
                      ) : player.status === "playing" ? (
                        <Pause className="size-5" aria-hidden="true" />
                      ) : (
                        <Play className="size-5" aria-hidden="true" />
                      )}
                      <span className="hidden sm:inline">
                        {player.status === "playing"
                          ? "Pause"
                          : player.status === "paused"
                            ? "Reprendre"
                            : player.status === "loading"
                              ? "Préparation…"
                              : "Écouter"}
                      </span>
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      onClick={() => player.stop()}
                      disabled={player.status === "idle"}
                      aria-label="Arrêter la lecture audio"
                      className="size-11"
                    >
                      <Square className="size-4" aria-hidden="true" />
                    </Button>
                    {player.status === "playing" && <EqBars />}
                    <Badge
                      variant="outline"
                      className="text-[10px] font-semibold uppercase"
                      aria-label={`Langue détectée : ${language === "fr" ? "français" : "anglais"}`}
                    >
                      {language === "fr" ? "FR" : "EN"}
                    </Badge>
                  </div>

                  <div className="grid grid-cols-2 gap-2">
                    <Select
                      value={voice}
                      onValueChange={(v) => {
                        setVoice(v);
                        player.setOptions({ voice: v === "auto" ? undefined : v });
                      }}
                    >
                      <SelectTrigger className="h-10" aria-label="Choisir la voix">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="auto">Voix auto ({language === "fr" ? "FR" : "EN"})</SelectItem>
                        {TTS_VOICES.map((v) => (
                          <SelectItem key={v.id} value={v.id}>
                            {v.label} — {v.description}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Select
                      value={String(speed)}
                      onValueChange={(v) => {
                        const s = Number(v);
                        setSpeed(s);
                        player.setOptions({ speed: s });
                      }}
                    >
                      <SelectTrigger className="h-10" aria-label="Choisir la vitesse de lecture">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {SPEED_OPTIONS.map((s) => (
                          <SelectItem key={s} value={s}>
                            {s}×
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  {player.total > 0 && (
                    <div className="space-y-1.5">
                      <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                        <span>
                          Segment {player.currentIndex + 1} / {player.total}
                        </span>
                        {player.status === "paused" && <span>en pause</span>}
                      </div>
                      <Progress
                        value={((player.currentIndex + 1) / player.total) * 100}
                        className="h-1.5"
                        aria-label="Progression de la lecture"
                      />
                      <p className="line-clamp-2 rounded-md bg-muted/50 px-2 py-1 text-xs italic text-muted-foreground">
                        {player.currentText}
                      </p>
                    </div>
                  )}

                  {player.error && (
                    <Alert variant="destructive" role="alert">
                      <AlertTriangle className="size-4" />
                      <AlertTitle>Lecture audio impossible</AlertTitle>
                      <AlertDescription className="flex flex-wrap items-center gap-x-3 gap-y-2">
                        <span>{player.error}</span>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() =>
                            detail &&
                            player.play(detail.textContent, {
                              voice: voice === "auto" ? undefined : voice,
                              speed,
                              language,
                            })
                          }
                          className="h-9 gap-1.5 border-red-200 bg-white text-red-700 hover:bg-red-50"
                        >
                          <RotateCcw className="size-3.5" aria-hidden="true" />
                          Réessayer
                        </Button>
                      </AlertDescription>
                    </Alert>
                  )}

                  {detail.textContent.trim().length === 0 && (
                    <Alert className="border-amber-200 bg-amber-50">
                      <AlertTriangle className="size-4 text-amber-600" />
                      <AlertTitle className="text-amber-900">
                        Ce cours n&apos;a pas de texte lisible.
                      </AlertTitle>
                      <AlertDescription className="text-amber-800">
                        <span>
                          Réimporte-le ou modifie son texte depuis l&apos;onglet Cours.
                        </span>
                        {onOpenCourses && (
                          <Button
                            type="button"
                            variant="link"
                            onClick={onOpenCourses}
                            className="h-auto p-0 text-emerald-700 underline underline-offset-2 hover:text-emerald-800"
                          >
                            Ouvrir les cours
                          </Button>
                        )}
                      </AlertDescription>
                    </Alert>
                  )}
                    </>
                  ) : null}
                </CardContent>
              </Card>
            )}
          </motion.div>

          {/* ============ RIGHT — Révision guidée ============ */}
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.25, delay: 0.05 }}
            className="space-y-4 lg:col-span-3"
          >
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">🎯 Révision guidée</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                {/* Toolbar */}
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="secondary" aria-label={`${qaCount} questions révisées`}>
                    {qaCount} question{qaCount > 1 ? "s" : ""}
                  </Badge>
                  {qaToReview > 0 && (
                    <Badge className="border-transparent bg-rose-100 text-rose-800" aria-label={`${qaToReview} à revoir`}>
                      {qaToReview} à revoir
                    </Badge>
                  )}

                  <Select value={sort} onValueChange={(v) => setSort(v as QASort)}>
                    <SelectTrigger className="h-9 w-[170px] text-xs" aria-label="Trier les questions">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="recent">Plus récentes</SelectItem>
                      <SelectItem value="oldest">Plus anciennes</SelectItem>
                      <SelectItem value="verdict">À revoir d&apos;abord</SelectItem>
                    </SelectContent>
                  </Select>

                  <Button
                    variant="outline"
                    size="sm"
                    className="h-9 gap-1.5 text-xs"
                    onClick={() => void handleClearShown()}
                    disabled={!docId || qaCount === 0}
                    aria-label="Effacer les réponses affichées"
                  >
                    <EyeOff className="size-3.5" aria-hidden="true" />
                    Effacer les réponses
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-9 gap-1.5 text-xs"
                    onClick={() => void handleShowAll()}
                    disabled={!docId || qaCount === 0}
                    aria-label="Tout afficher à nouveau"
                  >
                    <Eye className="size-3.5" aria-hidden="true" />
                    Tout afficher
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-9 gap-1.5 text-xs"
                    onClick={exportMarkdown}
                    disabled={!detail || qas.filter((q) => !q.hidden).length === 0}
                    aria-label="Exporter la fiche de révision en markdown"
                  >
                    <Download className="size-3.5" aria-hidden="true" />
                    Exporter .md
                  </Button>
                  {busy && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-9 gap-1.5 border-red-200 text-xs text-red-600 hover:bg-red-50 hover:text-red-700"
                      onClick={stopStream}
                      aria-label="Arrêter le flux de révision"
                    >
                      <Square className="size-3.5" aria-hidden="true" />
                      Stop
                    </Button>
                  )}
                </div>

                {/* Filter chips */}
                <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Filtrer les questions">
                  {FILTER_CHIPS.map((chip) => {
                    const active = filter === chip.id;
                    return (
                      <button
                        key={chip.id}
                        type="button"
                        onClick={() => setFilter(chip.id)}
                        aria-pressed={active}
                        className={cn(
                          "min-h-8 rounded-full border px-3 text-xs font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring",
                          active
                            ? "border-emerald-600 bg-emerald-600 text-white"
                            : "border-border bg-transparent text-muted-foreground hover:bg-muted hover:text-foreground"
                        )}
                      >
                        {chip.label}
                      </button>
                    );
                  })}
                </div>

                {/* Q&A stream */}
                <div ref={streamRef} className="scroll-thin max-h-[560px] space-y-3 overflow-y-auto pr-1">
                  {showGreeting && detail && (
                    <motion.div
                      initial={{ opacity: 0, y: 8 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ duration: 0.25 }}
                      className="rounded-xl border border-emerald-200 bg-emerald-50 p-4"
                    >
                      <div className="flex items-start gap-2.5">
                        <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-emerald-600 text-white" aria-hidden="true">
                          <Sparkles className="size-4" />
                        </span>
                        <div className="min-w-0">
                          <p className="text-sm font-semibold text-emerald-900">Assistant</p>
                          <p className="mt-0.5 text-sm text-emerald-900/90">
                            J&apos;ai lu « {detail.title} » en entier. On commence la révision ?
                          </p>
                          <div className="mt-3 flex flex-wrap gap-2">
                            <Button
                              onClick={startFromGreet}
                              className="h-10 bg-emerald-600 text-white hover:bg-emerald-700"
                            >
                              Oui, commence !
                            </Button>
                            <Button
                              variant="outline"
                              onClick={() => {
                                setDismissedPrompt(true);
                                onGreetConsumed?.();
                              }}
                              className="h-10 border-emerald-300 bg-white text-emerald-800 hover:bg-emerald-100"
                            >
                              Plus tard
                            </Button>
                          </div>
                        </div>
                      </div>
                    </motion.div>
                  )}

                  {/* Live exchange */}
                  {live && (
                    <div className="space-y-3">
                      {live.mode === "ask" && live.userText && (
                        <div className="flex justify-end">
                          <div className="max-w-[85%] rounded-2xl rounded-br-sm bg-emerald-600 px-3.5 py-2.5 text-sm text-white">
                            <p className="whitespace-pre-wrap">{live.userText}</p>
                            <p className="mt-1 text-[10px] text-emerald-100">ta question, à l&apos;instant</p>
                          </div>
                        </div>
                      )}

                      {/* Coach bubble */}
                      {(live.coach.length > 0 || coachRunning) && (
                        <div className="flex items-start gap-2">
                          <span
                            className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-emerald-100 text-sm"
                            aria-hidden="true"
                          >
                            🎯
                          </span>
                          <div className="min-w-0 flex-1 rounded-2xl rounded-tl-sm border bg-muted/40 px-3.5 py-2.5">
                            <div className="flex items-center justify-between gap-2">
                              <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                                Coach
                              </p>
                              {live.coach.trim().length > 0 && (
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="size-7 text-muted-foreground hover:text-emerald-700"
                                  onClick={() =>
                                    player.play(stripMd(live.coach), {
                                      voice: voice === "auto" ? undefined : voice,
                                      speed,
                                      language,
                                    })
                                  }
                                  aria-label="Écouter la question du coach"
                                >
                                  <Volume2 className="size-3.5" aria-hidden="true" />
                                </Button>
                              )}
                            </div>
                            <MarkdownView content={live.coach} />
                            {coachRunning && (
                              <span className="animate-pulse font-bold text-emerald-600" aria-hidden="true">
                                ▍
                              </span>
                            )}
                          </div>
                        </div>
                      )}

                      {/* User answer bubble */}
                      {live.mode === "question" && live.userText && (
                        <div className="flex justify-end">
                          <div className="max-w-[85%] rounded-2xl rounded-br-sm bg-emerald-600 px-3.5 py-2.5 text-sm text-white">
                            <p className="whitespace-pre-wrap">{live.userText}</p>
                            <p className="mt-1 text-[10px] text-emerald-100">ta réponse, à l&apos;instant</p>
                          </div>
                        </div>
                      )}

                      {/* Feedback / evaluation */}
                      {(live.feedback.length > 0 || live.evaluation) && (
                        <div className="ml-10 rounded-xl border border-emerald-200 bg-emerald-50/60 p-3">
                          {live.evaluation && (
                            <div className="mb-2 flex flex-wrap items-center gap-2">
                              <Badge variant="outline" className={cn("text-[10px]", VERDICT_META[live.evaluation.verdict].className)}>
                                {VERDICT_META[live.evaluation.verdict].icon}{" "}
                                {VERDICT_META[live.evaluation.verdict].label}
                              </Badge>
                              <span className="text-xs text-muted-foreground">
                                Score : {live.evaluation.score}/100
                              </span>
                            </div>
                          )}
                          <MarkdownView content={live.feedback} />
                          {evaluatorRunning && (
                            <span className="animate-pulse font-bold text-emerald-600" aria-hidden="true">
                              ▍
                            </span>
                          )}
                          {live.evaluation?.modelAnswer ? (
                            <Collapsible>
                              <CollapsibleTrigger className="mt-2 inline-flex min-h-8 items-center gap-1 text-[11px] font-medium text-emerald-700 outline-none focus-visible:ring-2 focus-visible:ring-ring">
                                Réponse attendue
                                <ChevronDown className="size-3" aria-hidden="true" />
                              </CollapsibleTrigger>
                              <CollapsibleContent>
                                <div className="mt-1 rounded-lg border bg-background p-2">
                                  <div className="text-xs text-muted-foreground">
                                    <MarkdownView content={live.evaluation.modelAnswer} />
                                  </div>
                                </div>
                              </CollapsibleContent>
                            </Collapsible>
                          ) : null}
                          {live.qaId && (
                            <div className="mt-3 border-t border-emerald-200 pt-2.5">
                              <RatingButtons value={liveRating} onRate={(r) => void rateLiveQa(r)} size="xs" />
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  )}

                  {/* Stored Q&A fiche */}
                  {qasLoading ? (
                    <div className="flex items-center gap-2 px-1 py-4 text-sm text-muted-foreground">
                      <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                      Chargement de la fiche…
                    </div>
                  ) : (
                    qas.map((qa) => (
                      <QaCard
                        key={qa.id}
                        qa={qa}
                        deleting={deletingQaId === qa.id}
                        language={language}
                        onRate={(r) => void rateStoredQa(qa.id, r)}
                        onToggleHidden={() => void toggleHidden(qa)}
                        onDelete={() => void removeQa(qa.id)}
                      />
                    ))
                  )}

                  {showEmptyState && (
                    <div className="rounded-xl border border-dashed p-8 text-center">
                      <span className="text-3xl" aria-hidden="true">
                        🎯
                      </span>
                      <p className="mt-2 text-sm text-muted-foreground">
                        Aucune question pour l&apos;instant. Lance le coach !
                      </p>
                      <Button
                        onClick={nextQuestion}
                        disabled={busy || !docId}
                        className="mt-3 h-10 bg-emerald-600 text-white hover:bg-emerald-700"
                      >
                        <Sparkles className="size-4" aria-hidden="true" />
                        Lancer la révision
                      </Button>
                    </div>
                  )}
                </div>

                {/* Agent status strip */}
                {agentsVisible && <AgentStatusList agents={agents} />}

                {/* Answer input */}
                <div className="space-y-2 border-t pt-3">
                  <Textarea
                    rows={2}
                    value={answerInput}
                    onChange={(e) => setAnswerInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                        e.preventDefault();
                        submitAnswer();
                      }
                    }}
                    placeholder="Écris ta réponse… ou dicte-la au micro"
                    disabled={busy}
                    aria-label="Ta réponse"
                    className="min-h-16 resize-none"
                  />
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      onClick={() => (recorder.recording ? recorder.stop() : void recorder.start())}
                      disabled={recorder.loading || busy}
                      aria-label={
                        recorder.recording ? "Arrêter la dictée vocale" : "Dicter ta réponse au micro"
                      }
                      className={cn(
                        "size-11 shrink-0",
                        recorder.recording &&
                          "animate-pulse border-red-300 bg-red-600 text-white hover:bg-red-700 hover:text-white"
                      )}
                    >
                      {recorder.loading ? (
                        <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                      ) : recorder.recording ? (
                        <Square className="size-4" aria-hidden="true" />
                      ) : (
                        <Mic className="size-4" aria-hidden="true" />
                      )}
                    </Button>

                    <Button
                      type="button"
                      onClick={submitAnswer}
                      disabled={busy || answerInput.trim().length === 0 || !live || live.mode !== "question" || live.userText !== null}
                      aria-label="Envoyer ta réponse au coach"
                      className="h-11 min-w-11 gap-2 bg-emerald-600 px-4 text-white hover:bg-emerald-700"
                    >
                      {busy ? (
                        <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                      ) : (
                        <SendHorizonal className="size-4" aria-hidden="true" />
                      )}
                      Envoyer
                    </Button>

                    <Button
                      type="button"
                      variant="outline"
                      onClick={askCoach}
                      disabled={busy || answerInput.trim().length === 0 || !docId}
                      aria-label="Demander au coach"
                      className="h-11 gap-2"
                    >
                      <HelpCircle className="size-4" aria-hidden="true" />
                      Demander au coach
                    </Button>

                    <Button
                      type="button"
                      variant="outline"
                      onClick={nextQuestion}
                      disabled={busy || !docId}
                      aria-label="Poser la question suivante"
                      className="h-11 gap-2"
                    >
                      <SkipForward className="size-4" aria-hidden="true" />
                      Question suivante
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          </motion.div>
        </div>
      )}
    </div>
  );
}

function EmptyCoursesArt() {
  return (
    <span className="flex size-12 items-center justify-center rounded-2xl bg-emerald-100 text-2xl" aria-hidden="true">
      📚
    </span>
  );
}
