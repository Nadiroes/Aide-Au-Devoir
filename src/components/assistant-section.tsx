"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Archive,
  BookMarked,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  History,
  Loader2,
  Search,
  Send,
  Square,
  Trash2,
  Volume2,
} from "lucide-react";
import { motion } from "framer-motion";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { AgentStatusList, type AgentDisplay } from "@/components/agent-status";
import { MarkdownView } from "@/components/markdown-view";
import { MemoryCard } from "@/components/memory-card";
import { isAbortError, postSse } from "@/lib/sse-client";
import { clearChatHistory, fetchChatHistory, fetchProviders, ttsToBlob } from "@/lib/api-client";
import { CHAT_AGENT_ORDER } from "@/lib/types";
import type { ChatEvent, ChatMessageDTO, ChatMode, ProviderId, QcmHit, RetrievalHit } from "@/lib/types";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

function freshAgents(): AgentDisplay[] {
  return CHAT_AGENT_ORDER.map((a) => ({
    id: a.id,
    label: a.label,
    status: "idle" as const,
    logs: [],
  }));
}

const PROVIDER_LABELS: Record<ProviderId, string> = {
  zai: "Z.ai (intégré)",
  mistral: "Mistral",
  agnes: "Agnes",
};

function stripMarkdown(md: string): string {
  return md
    .replace(/[#*`>_~[\]()]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Extracts the correct option index from a stored answer like "B. …". */
function correctOptionIndex(answer: string | null | undefined, options: string[]): number {
  if (!answer || options.length === 0) return -1;
  const letter = answer.match(/^\s*(?:option\s+)?([A-Ha-h])\s*[).:—-]?\s/);
  if (letter) {
    const idx = letter[1].toUpperCase().charCodeAt(0) - 65;
    if (idx >= 0 && idx < options.length) return idx;
  }
  const trimmed = answer.trim();
  const direct = options.findIndex((o) => o.toLowerCase() === trimmed.toLowerCase());
  if (direct !== -1) return direct;
  return options.findIndex((o) =>
    trimmed.toLowerCase().includes(o.toLowerCase().replace(/^\s*[A-Ha-h]\s*[).:]\s*/, ""))
  );
}

/** QCM bank card — the correct option is highlighted in green. */
function QcmBankCard({ hit }: { hit: QcmHit }) {
  const correctIdx = correctOptionIndex(hit.answer, hit.options);
  return (
    <div className="rounded-lg border border-emerald-200 bg-emerald-50/40 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge className="border-transparent bg-emerald-600 text-[10px] text-white">
          <BookMarked className="mr-1 size-3" aria-hidden="true" />
          Banque de QCM
        </Badge>
        <span className="text-xs text-muted-foreground">« {hit.examTitle} » · question {hit.idx + 1}</span>
        <span className="ml-auto text-[10px] tabular-nums text-muted-foreground">
          correspondance {Math.round(hit.score * 100)}%
        </span>
      </div>
      <p className="mt-2 text-sm font-medium">{hit.prompt}</p>
      {hit.options.length > 0 && (
        <div className="mt-2 space-y-1.5">
          {hit.options.map((opt, i) => {
            const isCorrect = i === correctIdx;
            return (
              <div
                key={i}
                className={cn(
                  "flex items-start gap-2 rounded-lg border px-3 py-1.5 text-sm",
                  isCorrect
                    ? "border-emerald-400 bg-emerald-100 font-semibold text-emerald-900"
                    : "border-stone-200 bg-white text-muted-foreground"
                )}
              >
                <span className="shrink-0 font-bold">
                  {opt.match(/^\s*([A-Ha-h])/)?.[1]?.toUpperCase() ?? String.fromCharCode(65 + i)}.
                </span>
                <span className="min-w-0 flex-1">{opt.replace(/^\s*[A-Ha-h]\s*[).:]\s*/, "")}</span>
                {isCorrect && <CheckCircle2 className="size-4 shrink-0 text-emerald-600" aria-hidden="true" />}
              </div>
            );
          })}
        </div>
      )}
      {hit.answer && (
        <div className="mt-2 rounded-md bg-white/80 p-2 text-sm">
          <MarkdownView content={hit.answer} />
        </div>
      )}
      {hit.refs.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {hit.refs.map((ref) => (
            <Badge key={ref} variant="outline" className="border-amber-300 bg-amber-50 text-[10px] text-amber-900">
              📖 {ref}
            </Badge>
          ))}
        </div>
      )}
    </div>
  );
}

function HistoryItem({ msg }: { msg: ChatMessageDTO }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-lg border p-3">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full min-h-11 items-start justify-between gap-2 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="min-w-0">
          <span className="line-clamp-2 block text-sm font-medium">{msg.question}</span>
          {!open && (
            <span className="mt-1 line-clamp-2 block text-xs text-muted-foreground">
              {stripMarkdown(msg.answer)}
            </span>
          )}
        </span>
        {open ? (
          <ChevronUp className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        ) : (
          <ChevronDown className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        )}
      </button>

      {open && (
        <div className="mt-2 space-y-3">
          {msg.qcmSources && msg.qcmSources.length > 0 && (
            <div className="space-y-2">
              {msg.qcmSources.map((hit) => (
                <QcmBankCard key={hit.questionId} hit={hit} />
              ))}
            </div>
          )}
          <MarkdownView content={msg.answer} />
          {msg.tutor ? (
            <>
              <Separator />
              <div>
                <p className="mb-1 text-xs font-semibold">👨‍🏫 Fiche élève</p>
                <div className="text-xs text-muted-foreground">
                  <MarkdownView content={msg.tutor} />
                </div>
              </div>
            </>
          ) : null}
          <p className="text-xs text-muted-foreground">
            <Badge variant="secondary" className="mr-2 text-[10px]">
              {msg.category}
            </Badge>
            {msg.sources?.length ?? 0} passage(s) source ·{" "}
            {new Date(msg.createdAt).toLocaleString("fr-FR")}
          </p>
        </div>
      )}
    </div>
  );
}

export function AssistantSection({ memoryVersion = 0 }: { memoryVersion?: number }) {
  const [question, setQuestion] = useState("");
  const [mode, setMode] = useState<ChatMode>("cours");
  const [provider, setProvider] = useState<ProviderId>("zai");
  const [providers, setProviders] = useState<ProviderId[]>([]);

  const [busy, setBusy] = useState(false);
  const [agents, setAgents] = useState<AgentDisplay[]>(freshAgents);
  const [answer, setAnswer] = useState("");
  const [tutor, setTutor] = useState("");
  const [hits, setHits] = useState<RetrievalHit[]>([]);

  const [history, setHistory] = useState<ChatMessageDTO[]>([]);
  const [historyOpen, setHistoryOpen] = useState(true);
  // Rubric view of the history: plain list or grouped by category with search.
  const [historyView, setHistoryView] = useState<"liste" | "reponses">("liste");
  const [answerSearch, setAnswerSearch] = useState("");
  const [qcmHits, setQcmHits] = useState<QcmHit[]>([]);
  const [clearing, setClearing] = useState(false);

  const [loadingAudio, setLoadingAudio] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const answerRef = useRef<HTMLDivElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioUrlRef = useRef<string | null>(null);

  // Listen to the (latest) streamed answer — TTS, French.
  const listenToAnswer = useCallback(async () => {
    const text = stripMarkdown(answer);
    if (loadingAudio || text.length === 0) return;
    setLoadingAudio(true);
    let url: string | null = null;
    try {
      const blob = await ttsToBlob({ text: text.slice(0, 4000), language: "fr" });
      url = URL.createObjectURL(blob);
      audioUrlRef.current = url;
      const audio = new Audio(url);
      audioRef.current = audio;
      audio.onended = () => {
        if (audioUrlRef.current) {
          URL.revokeObjectURL(audioUrlRef.current);
          audioUrlRef.current = null;
        }
      };
      await audio.play();
    } catch (err) {
      if (url) URL.revokeObjectURL(url);
      if (audioUrlRef.current === url) audioUrlRef.current = null;
      toast.error(err instanceof Error ? err.message : "Synthèse vocale indisponible");
    } finally {
      setLoadingAudio(false);
    }
  }, [answer, loadingAudio]);

  useEffect(() => {
    return () => {
      audioRef.current?.pause();
      if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current);
    };
  }, []);

  const loadHistory = useCallback(async () => {
    try {
      setHistory(await fetchChatHistory());
    } catch (err) {
      console.error(err);
    }
  }, []);

  useEffect(() => {
    void loadHistory();
    void (async () => {
      try {
        const data = await fetchProviders();
        setProviders(data.providers.filter((p) => p.configured && p.serverReady).map((p) => p.id));
      } catch (err) {
        console.error(err);
        setProviders(["zai"]);
      }
    })();
  }, [loadHistory]);

  // Keep the selected provider valid.
  useEffect(() => {
    if (providers.length === 0) return;
    if (!providers.includes(provider)) {
      setProvider(providers.includes("zai") ? "zai" : providers[0]);
    }
  }, [providers, provider]);

  // Auto-scroll the streaming answer.
  useEffect(() => {
    if (busy && answerRef.current) {
      answerRef.current.scrollTop = answerRef.current.scrollHeight;
    }
  }, [answer, tutor, busy]);

  const patchAgent = useCallback((id: string, patch: Partial<AgentDisplay>) => {
    setAgents((prev) => prev.map((a) => (a.id === id ? { ...a, ...patch } : a)));
  }, []);

  const handleEvent = useCallback(
    (event: ChatEvent) => {
      switch (event.type) {
        case "pipeline.start":
          setAgents(freshAgents());
          break;
        case "agent.start":
          patchAgent(event.id, { status: "running", logs: [], summary: undefined, content: undefined });
          break;
        case "agent.log":
          setAgents((prev) =>
            prev.map((a) => (a.id === event.id ? { ...a, logs: [...a.logs, event.message] } : a))
          );
          break;
        case "agent.done":
          patchAgent(event.id, { status: "done", summary: event.summary, content: event.content });
          break;
        case "agent.error":
          patchAgent(event.id, { status: "error", summary: event.message });
          toast.error(event.message);
          break;
        case "retrieval.hit":
          setHits((prev) => [...prev, event.hit]);
          break;
        case "qcm.hit":
          setQcmHits((prev) =>
            prev.some((h) => h.questionId === event.hit.questionId) ? prev : [...prev, event.hit]
          );
          break;
        case "answer.token":
          setAnswer((prev) => prev + event.token);
          break;
        case "tutor.token":
          setTutor((prev) => prev + event.token);
          break;
        case "pipeline.done":
          setAnswer(event.answer);
          setTutor(event.tutor);
          if (event.qcm) setQcmHits(event.qcm);
          toast.success("Réponse prête");
          void loadHistory();
          break;
        case "pipeline.error":
          toast.error(event.message);
          setAgents((prev) =>
            prev.map((a) => (a.status === "running" ? { ...a, status: "error" as const } : a))
          );
          break;
      }
    },
    [patchAgent, loadHistory]
  );

  const send = async () => {
    const q = question.trim();
    if (!q || busy) return;
    setBusy(true);
    setAgents(freshAgents());
    setAnswer("");
    setTutor("");
    setHits([]);
    setQcmHits([]);
    setHistoryOpen(false);

    const controller = new AbortController();
    abortRef.current = controller;
    try {
      await postSse<ChatEvent>(
        "/api/chat",
        { question: q, provider, mode },
        handleEvent,
        controller.signal
      );
    } catch (err) {
      if (isAbortError(err)) {
        toast.info("Génération interrompue");
        setAgents((prev) =>
          prev.map((a) => (a.status === "running" ? { ...a, status: "idle" as const } : a))
        );
      } else {
        toast.error(err instanceof Error ? err.message : "Erreur pendant la génération");
        setAgents((prev) =>
          prev.map((a) => (a.status === "running" ? { ...a, status: "error" as const } : a))
        );
      }
    } finally {
      abortRef.current = null;
      setBusy(false);
    }
  };

  const stop = () => {
    abortRef.current?.abort();
  };

  /** Clears the whole assistant history. */
  const runClearHistory = async () => {
    setClearing(true);
    try {
      const count = await clearChatHistory();
      toast.success(`${count} échange(s) supprimé(s) de l'historique`);
      setHistory([]);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Suppression impossible");
    } finally {
      setClearing(false);
    }
  };

  // Réponses grouped by rubric + search filter.
  const groupedAnswers = useMemo(() => {
    const q = answerSearch.trim().toLowerCase();
    const filtered = history.filter(
      (m) =>
        !q ||
        m.question.toLowerCase().includes(q) ||
        m.answer.toLowerCase().includes(q) ||
        m.category.toLowerCase().includes(q)
    );
    const groups = new Map<string, ChatMessageDTO[]>();
    for (const m of filtered) {
      const list = groups.get(m.category) ?? [];
      list.push(m);
      groups.set(m.category, list);
    }
    return [...groups.entries()].sort((a, b) => b[1].length - a[1].length);
  }, [history, answerSearch]);

  const solverRunning = agents.find((a) => a.id === "solver")?.status === "running";
  const hasOutput =
    answer.length > 0 || tutor.length > 0 || hits.length > 0 || agents.some((a) => a.status !== "idle");

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold md:text-3xl">Assistant</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Posez votre question : Planificateur, Chercheur, Solveur et Tuteur travaillent ensemble.
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
        {/* Left column */}
        <div className="min-w-0 space-y-6">
          {/* Question card */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Posez votre question</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <Textarea
                rows={3}
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                onKeyDown={(e) => {
                  // Tab = envoyer (comme le bouton), Maj+Tab garde le comportement normal.
                  if (e.key === "Tab" && !e.shiftKey && question.trim().length > 0) {
                    e.preventDefault();
                    void send();
                  } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                    e.preventDefault();
                    void send();
                  }
                }}
                placeholder="Ex : Explique la dérivée d'une fonction composée avec un exemple du cours. (Tab ou Ctrl+Entrée pour envoyer)"
                disabled={busy}
                className="min-h-[88px] resize-none"
                aria-label="Votre question"
              />
              <div className="flex flex-col gap-2 lg:flex-row lg:items-center">
                <Select value={mode} onValueChange={(v) => setMode(v as ChatMode)}>
                  <SelectTrigger className="h-10 w-full lg:w-[210px]" aria-label="Mode de réponse">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="cours">Avec mes cours (RAG)</SelectItem>
                    <SelectItem value="libre">Question libre (actualité, général)</SelectItem>
                  </SelectContent>
                </Select>

                <Select value={provider} onValueChange={(v) => setProvider(v as ProviderId)}>
                  <SelectTrigger className="h-10 w-full lg:w-[210px]" aria-label="Fournisseur IA">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(Object.keys(PROVIDER_LABELS) as ProviderId[]).map((id) => {
                      const available = providers.includes(id);
                      return (
                        <SelectItem key={id} value={id} disabled={!available}>
                          {PROVIDER_LABELS[id]}
                          {available ? "" : " (non configurée)"}
                        </SelectItem>
                      );
                    })}
                  </SelectContent>
                </Select>

                <div className="flex flex-1 gap-2">
                  <Button
                    onClick={() => void send()}
                    disabled={busy || question.trim().length === 0}
                    className="h-10 flex-1 bg-emerald-600 text-white hover:bg-emerald-700"
                  >
                    {busy ? (
                      <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                    ) : (
                      <Send className="size-4" aria-hidden="true" />
                    )}
                    {busy ? "Génération…" : "Envoyer"}
                  </Button>
                  {busy && (
                    <Button
                      variant="outline"
                      size="icon"
                      onClick={stop}
                      className="size-10 shrink-0"
                      aria-label="Arrêter la génération"
                    >
                      <Square className="size-4" aria-hidden="true" />
                    </Button>
                  )}
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Answer card */}
          {hasOutput && (
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.25 }}
            >
              <Card>
                <CardHeader className="pb-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <CardTitle className="text-base">Réponse</CardTitle>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-9 gap-1.5 text-xs"
                      onClick={() => void listenToAnswer()}
                      disabled={loadingAudio || answer.trim().length === 0}
                      aria-label="Écouter la réponse"
                    >
                      {loadingAudio ? (
                        <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                      ) : (
                        <Volume2 className="size-3.5" aria-hidden="true" />
                      )}
                      Écouter la réponse
                    </Button>
                  </div>
                </CardHeader>
                <CardContent>
                  <div ref={answerRef} className="scroll-thin max-h-[480px] overflow-y-auto pr-1">
                    {answer.length > 0 ? (
                      <MarkdownView content={answer} />
                    ) : !busy ? (
                      <p className="text-sm text-muted-foreground">
                        Aucune réponse générée — réessayez.
                      </p>
                    ) : null}
                    {solverRunning && (
                      <span className="animate-pulse font-bold text-emerald-600" aria-hidden="true">
                        ▍
                      </span>
                    )}

                    {qcmHits.length > 0 && (
                      <>
                        <Separator className="my-4" />
                        <p className="mb-2 text-sm font-semibold">
                          📚 Réponses retrouvées dans la banque de QCM ({qcmHits.length})
                        </p>
                        <div className="space-y-2">
                          {qcmHits.map((hit) => (
                            <QcmBankCard key={hit.questionId} hit={hit} />
                          ))}
                        </div>
                      </>
                    )}

                    {tutor.length > 0 && (
                      <>
                        <Separator className="my-4" />
                        <p className="mb-2 text-sm font-semibold">👨‍🏫 Fiche élève</p>
                        <div className="scroll-thin max-h-[420px] overflow-y-auto rounded-lg bg-muted/50 p-3 text-sm text-muted-foreground">
                          <MarkdownView content={tutor} />
                        </div>
                      </>
                    )}
                  </div>
                </CardContent>
              </Card>
            </motion.div>
          )}

          {/* History / Réponses card */}
          <Collapsible open={historyOpen} onOpenChange={setHistoryOpen}>
            <Card className="gap-0 py-0">
              <CardContent className="p-4 md:p-5">
                <div className="flex flex-wrap items-center gap-2">
                  <CollapsibleTrigger asChild>
                    <Button variant="ghost" className="h-10 min-w-0 flex-1 justify-between px-3">
                      <span className="flex items-center gap-2 font-medium">
                        {historyView === "liste" ? (
                          <>
                            <History className="size-4" aria-hidden="true" />
                            Historique ({history.length})
                          </>
                        ) : (
                          <>
                            <Archive className="size-4" aria-hidden="true" />
                            Réponses par catégorie ({history.length})
                          </>
                        )}
                      </span>
                      {historyOpen ? (
                        <ChevronUp className="size-4" aria-hidden="true" />
                      ) : (
                        <ChevronDown className="size-4" aria-hidden="true" />
                      )}
                    </Button>
                  </CollapsibleTrigger>
                  <div className="flex shrink-0 items-center gap-1 rounded-lg bg-muted p-1">
                    <button
                      type="button"
                      onClick={() => setHistoryView("liste")}
                      aria-pressed={historyView === "liste"}
                      className={cn(
                        "rounded-md px-2.5 py-1.5 text-xs font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        historyView === "liste" ? "bg-background shadow-sm" : "text-muted-foreground"
                      )}
                    >
                      Historique
                    </button>
                    <button
                      type="button"
                      onClick={() => setHistoryView("reponses")}
                      aria-pressed={historyView === "reponses"}
                      className={cn(
                        "rounded-md px-2.5 py-1.5 text-xs font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        historyView === "reponses" ? "bg-background shadow-sm" : "text-muted-foreground"
                      )}
                    >
                      Réponses
                    </button>
                  </div>
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-10 shrink-0 text-muted-foreground hover:bg-red-50 hover:text-red-600"
                        disabled={clearing || history.length === 0}
                        aria-label="Effacer tout l'historique"
                      >
                        {clearing ? (
                          <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                        ) : (
                          <Trash2 className="size-4" aria-hidden="true" />
                        )}
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>Effacer tout l&apos;historique ?</AlertDialogTitle>
                        <AlertDialogDescription>
                          Les {history.length} échange(s) de l&apos;Assistant seront supprimés. Les
                          réponses stockées dans la banque de QCM des examens ne sont pas affectées.
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>Annuler</AlertDialogCancel>
                        <AlertDialogAction
                          className="bg-red-600 text-white hover:bg-red-700"
                          onClick={() => void runClearHistory()}
                        >
                          Effacer
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                </div>

                <CollapsibleContent>
                  {historyView === "liste" ? (
                    history.length === 0 ? (
                      <p className="px-3 pb-2 pt-3 text-sm text-muted-foreground">
                        Vos questions précédentes apparaîtront ici.
                      </p>
                    ) : (
                      <div className="scroll-thin max-h-96 space-y-2 overflow-y-auto px-1 pb-1 pt-3">
                        {history
                          .slice()
                          .reverse()
                          .map((msg) => (
                            <HistoryItem key={msg.id} msg={msg} />
                          ))}
                      </div>
                    )
                  ) : (
                    <div className="space-y-3 pt-3">
                      <div className="relative">
                        <Search
                          className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
                          aria-hidden="true"
                        />
                        <Input
                          value={answerSearch}
                          onChange={(e) => setAnswerSearch(e.target.value)}
                          placeholder="Rechercher dans les réponses traitées…"
                          className="h-11 pl-9"
                          aria-label="Rechercher dans les réponses"
                        />
                      </div>
                      {groupedAnswers.length === 0 ? (
                        <p className="px-1 pb-2 text-sm text-muted-foreground">
                          {history.length === 0
                            ? "Aucune réponse enregistrée pour l'instant."
                            : "Aucune réponse ne correspond à cette recherche."}
                        </p>
                      ) : (
                        <div className="scroll-thin max-h-96 space-y-4 overflow-y-auto px-1 pb-1">
                          {groupedAnswers.map(([category, messages]) => (
                            <div key={category}>
                              <p className="mb-1.5 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                                <Badge variant="secondary" className="text-[10px]">
                                  {category}
                                </Badge>
                                {messages.length} réponse(s)
                              </p>
                              <div className="space-y-2">
                                {messages.map((msg) => (
                                  <HistoryItem key={msg.id} msg={msg} />
                                ))}
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </CollapsibleContent>
              </CardContent>
            </Card>
          </Collapsible>
        </div>

        {/* Right column */}
        <div className="space-y-6 self-start lg:sticky lg:top-20">
          <div>
            <h2 className="mb-3 text-lg font-semibold">Agents</h2>
            <AgentStatusList agents={agents} />
          </div>

          <MemoryCard version={memoryVersion} />

          {hits.length > 0 && (
            <Card className="gap-0 py-0">
              <CardContent className="p-4">
                <p className="text-sm font-semibold">📎 Passages retenus</p>
                <div className="scroll-thin mt-3 max-h-80 space-y-2 overflow-y-auto pr-1">
                  {hits.map((hit, i) => (
                    <div key={`${hit.documentId}-${hit.idx}-${i}`} className="rounded-lg border p-2 text-xs">
                      <div className="flex items-center justify-between gap-2">
                        <p className="min-w-0 truncate font-medium">{hit.title}</p>
                        <span className="shrink-0 tabular-nums text-muted-foreground">
                          score {hit.score.toFixed(2)}
                        </span>
                      </div>
                      <Badge variant="secondary" className="mt-1 text-[10px]">
                        {hit.subject}
                      </Badge>
                      <p className={cn("mt-1 line-clamp-3 text-muted-foreground")}>{hit.preview}</p>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}

