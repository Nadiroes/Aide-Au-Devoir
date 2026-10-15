"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronUp,
  Loader2,
  Send,
  Square,
} from "lucide-react";
import { motion } from "framer-motion";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
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
import { isAbortError, postSse } from "@/lib/sse-client";
import { fetchChatHistory, fetchProviders } from "@/lib/api-client";
import { CHAT_AGENT_ORDER } from "@/lib/types";
import type { ChatEvent, ChatMessageDTO, ChatMode, ProviderId, RetrievalHit } from "@/lib/types";
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
            {msg.sources?.length ?? 0} passage(s) source ·{" "}
            {new Date(msg.createdAt).toLocaleString("fr-FR")}
          </p>
        </div>
      )}
    </div>
  );
}

export function AssistantSection() {
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

  const abortRef = useRef<AbortController | null>(null);
  const answerRef = useRef<HTMLDivElement | null>(null);

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
        const list = await fetchProviders();
        setProviders(list.filter((p) => p.configured && p.serverReady).map((p) => p.id));
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
        case "answer.token":
          setAnswer((prev) => prev + event.token);
          break;
        case "tutor.token":
          setTutor((prev) => prev + event.token);
          break;
        case "pipeline.done":
          setAnswer(event.answer);
          setTutor(event.tutor);
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
                  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                    e.preventDefault();
                    void send();
                  }
                }}
                placeholder="Ex : Explique la dérivée d'une fonction composée avec un exemple du cours."
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
                  <CardTitle className="text-base">Réponse</CardTitle>
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

          {/* History card */}
          <Collapsible open={historyOpen} onOpenChange={setHistoryOpen}>
            <Card className="gap-0 py-0">
              <CardContent className="p-4 md:p-5">
                <CollapsibleTrigger asChild>
                  <Button variant="ghost" className="h-10 w-full justify-between px-3">
                    <span className="font-medium">Historique ({history.length})</span>
                    {historyOpen ? (
                      <ChevronUp className="size-4" aria-hidden="true" />
                    ) : (
                      <ChevronDown className="size-4" aria-hidden="true" />
                    )}
                  </Button>
                </CollapsibleTrigger>
                <CollapsibleContent>
                  {history.length === 0 ? (
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

