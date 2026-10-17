"use client";

// Examens — import d'examens (QCM / questions-réponses), association aux cours,
// résolution par les agents (avec références bibliques en contexte théologique),
// questions manuelles au fil de l'exercice et chat avec les agents.
//
// Flow: Importer → 📋 Examinateur structure les questions (SSE) → les agents
// demandent à quels cours l'examen est lié → une fois validé, résolution →
// l'élève peut ajouter des questions / poser des questions pendant l'épreuve.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  BookOpen,
  ChevronDown,
  ChevronUp,
  ClipboardList,
  FileQuestion,
  GraduationCap,
  Headphones,
  Library,
  Link2,
  Loader2,
  Play,
  Plus,
  RefreshCw,
  Send,
  Square,
  Trash2,
  Upload,
  Volume2,
} from "lucide-react";
import { motion } from "framer-motion";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Separator } from "@/components/ui/separator";
import { Progress } from "@/components/ui/progress";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Checkbox } from "@/components/ui/checkbox";
import { MarkdownView } from "@/components/markdown-view";
import { AgentStatusList, type AgentDisplay } from "@/components/agent-status";
import { useTtsPlayer } from "@/hooks/use-tts-player";
import { getTtsPrefs } from "@/components/settings-section";
import { isAbortError, postSse } from "@/lib/sse-client";
import {
  addExamQuestion,
  createExam,
  createExamFile,
  deleteExam,
  fetchExamDetail,
  fetchExams,
  linkExam,
} from "@/lib/api-client";
import { EXAM_AGENT_ORDER } from "@/lib/types";
import type {
  DocumentDTO,
  ExamDTO,
  ExamDetailDTO,
  ExamEvent,
  ExamQuestionDTO,
  ProviderId,
} from "@/lib/types";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

function freshAgents(): AgentDisplay[] {
  return EXAM_AGENT_ORDER.map((a) => ({
    id: a.id,
    label: a.label,
    status: "idle" as const,
    logs: [],
  }));
}

const KIND_LABELS: Record<string, string> = {
  qcm: "QCM",
  qa: "Questions / Réponses",
  mixte: "Mixte",
};

/** Extracts the correct option index from a stored answer like "B. La justification…". */
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
  const contained = options.findIndex(
    (o) => trimmed.toLowerCase().includes(o.toLowerCase().replace(/^\s*[A-Ha-h]\s*[).:]\s*/, ""))
  );
  return contained;
}

// ---------- Import dialog ----------

function ImportDialog({
  open,
  onOpenChange,
  onImported,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onImported: (exam: ExamDTO) => void;
}) {
  const [mode, setMode] = useState<"texte" | "fichier">("texte");
  const [rawText, setRawText] = useState("");
  const [title, setTitle] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);

  const reset = () => {
    setRawText("");
    setTitle("");
    setFile(null);
    setMode("texte");
  };

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const exam =
        mode === "fichier"
          ? await createExamFile(file as File, { title: title || undefined })
          : await createExam({ rawText, title: title || undefined });
      toast.success("Examen importé — les agents lisent l'énoncé…");
      reset();
      onOpenChange(false);
      onImported(exam);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Import impossible");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileQuestion className="size-5 text-emerald-600" aria-hidden="true" />
            Importer un examen
          </DialogTitle>
          <DialogDescription>
            QCM, questions-réponses, exercices… Collez le texte ou importez un fichier (PDF, DOCX,
            TXT, image, audio, EPUB). Les agents structurent ensuite les questions.
          </DialogDescription>
        </DialogHeader>

        <div className="flex gap-1.5 rounded-lg bg-muted p-1">
          {(
            [
              { id: "texte", label: "Coller le texte" },
              { id: "fichier", label: "Importer un fichier" },
            ] as const
          ).map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setMode(t.id)}
              className={cn(
                "flex-1 rounded-md px-3 py-2 text-sm font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                mode === t.id ? "bg-background shadow-sm" : "text-muted-foreground hover:text-foreground"
              )}
              aria-pressed={mode === t.id}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="exam-title">Titre (optionnel)</Label>
            <Input
              id="exam-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Ex : Examen de théologie — session 2025"
              maxLength={120}
            />
          </div>

          {mode === "texte" ? (
            <div className="space-y-1.5">
              <Label htmlFor="exam-text">Texte de l&apos;examen</Label>
              <Textarea
                id="exam-text"
                rows={8}
                value={rawText}
                onChange={(e) => setRawText(e.target.value)}
                placeholder={
                  "1. Quel apôtre a renié Jésus trois fois ?\nA. Pierre\nB. Jean\nC. Paul\nD. Thomas\n\n2. Définissez la justification par la foi…"
                }
                className="resize-none font-mono text-xs"
              />
            </div>
          ) : (
            <div className="space-y-1.5">
              <Label htmlFor="exam-file">Fichier</Label>
              <Input
                id="exam-file"
                type="file"
                accept=".pdf,.docx,.txt,.md,.png,.jpg,.jpeg,.webp,.epub,.mp3,.wav,.m4a,.ogg,.webm"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                className="h-11"
              />
              <p className="text-xs text-muted-foreground">
                Les images scannées sont lues par OCR, les fichiers audio transcrits automatiquement.
              </p>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Annuler
          </Button>
          <Button
            onClick={() => void submit()}
            disabled={busy || (mode === "texte" ? rawText.trim().length < 20 : !file)}
            className="gap-2 bg-emerald-600 text-white hover:bg-emerald-700"
          >
            {busy ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : <Upload className="size-4" aria-hidden="true" />}
            {busy ? "Import…" : "Importer"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------- Association dialog (les agents demandent les cours liés) ----------

function LinkDialog({
  open,
  onOpenChange,
  exam,
  documents,
  onLinked,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  exam: ExamDTO;
  documents: DocumentDTO[];
  onLinked: (documentIds: string[]) => void;
}) {
  // Initialized from the exam's current links (the dialog is remounted via its
  // key when the exam changes or when it is re-opened).
  const [selected, setSelected] = useState<Set<string>>(() => new Set(exam.documentIds));

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Link2 className="size-5 text-emerald-600" aria-hidden="true" />
            Les agents ont une question…
          </DialogTitle>
          <DialogDescription>
            « Cet examen a-t-il un lien avec un ou plusieurs cours importés ? » Les agents
            utiliseront ces cours pour justifier leurs réponses.
          </DialogDescription>
        </DialogHeader>

        <div className="scroll-thin max-h-72 space-y-1.5 overflow-y-auto rounded-lg border p-2">
          {documents.length === 0 ? (
            <p className="p-3 text-sm text-muted-foreground">
              Aucun cours importé pour l&apos;instant — l&apos;examen sera traité sans liaison. Vous
              pourrez importer vos cours dans l&apos;onglet Cours.
            </p>
          ) : (
            documents.map((doc) => (
              <label
                key={doc.id}
                className="flex min-h-11 cursor-pointer items-center gap-3 rounded-md px-2 py-1.5 hover:bg-muted/60"
              >
                <Checkbox
                  checked={selected.has(doc.id)}
                  onCheckedChange={() => toggle(doc.id)}
                  aria-label={`Lier le cours ${doc.title}`}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{doc.title}</span>
                  <span className="block text-xs text-muted-foreground">{doc.subject}</span>
                </span>
              </label>
            ))
          )}
        </div>

        <DialogFooter className="flex-col gap-2 sm:flex-row">
          <Button
            variant="outline"
            onClick={() => {
              onOpenChange(false);
              onLinked([]);
            }}
          >
            Sans lien particulier
          </Button>
          <Button
            className="bg-emerald-600 text-white hover:bg-emerald-700"
            disabled={selected.size === 0}
            onClick={() => {
              onOpenChange(false);
              onLinked([...selected]);
            }}
          >
            <Link2 className="size-4" aria-hidden="true" />
            Valider et connecter ({selected.size})
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------- Manual question dialog ----------

function AddQuestionDialog({
  open,
  onOpenChange,
  onAdded,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onAdded: (payload: { prompt: string; options?: string[]; type?: "qcm" | "qa" }) => void;
}) {
  const [prompt, setPrompt] = useState("");
  const [isQcm, setIsQcm] = useState(false);
  const [options, setOptions] = useState(["", "", "", ""]);

  const reset = () => {
    setPrompt("");
    setIsQcm(false);
    setOptions(["", "", "", ""]);
  };

  const letters = ["A", "B", "C", "D", "E", "F", "G", "H"];
  const validOptions = options.map((o) => o.trim()).filter(Boolean);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Plus className="size-5 text-emerald-600" aria-hidden="true" />
            Nouvelle question au fil de l&apos;exercice
          </DialogTitle>
          <DialogDescription>
            Posez une question du devoir ou introduisez un QCM manuellement : les agents y
            répondront.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="manual-q">Énoncé</Label>
            <Textarea
              id="manual-q"
              rows={3}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="Ex : Expliquez la différence entre justification et sanctification."
              className="resize-none"
            />
          </div>

          <label className="flex min-h-11 cursor-pointer items-center gap-3 rounded-lg border p-3">
            <Checkbox
              checked={isQcm}
              onCheckedChange={(v) => setIsQcm(v === true)}
              aria-label="Question à choix multiples"
            />
            <span className="text-sm font-medium">C&apos;est un QCM (avec des options A, B, C…)</span>
          </label>

          {isQcm && (
            <div className="space-y-2">
              {options.map((opt, i) => (
                <div key={i} className="flex items-center gap-2">
                  <span className="w-6 text-center text-sm font-bold text-emerald-700">{letters[i]}.</span>
                  <Input
                    value={opt}
                    onChange={(e) =>
                      setOptions((prev) => prev.map((o, j) => (j === i ? e.target.value : o)))
                    }
                    placeholder={i < 2 ? `Option ${letters[i]} (obligatoire)` : `Option ${letters[i]}`}
                    aria-label={`Option ${letters[i]}`}
                  />
                </div>
              ))}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => {
              reset();
              onOpenChange(false);
            }}
          >
            Annuler
          </Button>
          <Button
            className="bg-emerald-600 text-white hover:bg-emerald-700"
            disabled={prompt.trim().length < 6 || (isQcm && validOptions.length < 2)}
            onClick={() => {
              onAdded({
                prompt: prompt.trim(),
                type: isQcm ? "qcm" : "qa",
                options: isQcm
                  ? validOptions.map((o, i) => `${letters[i]}. ${o.replace(/^\s*[A-Ha-h]\s*[).:]\s*/, "")}`)
                  : undefined,
              });
              reset();
            }}
          >
            Ajouter
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------- Question card ----------

function QuestionCard({
  question,
  busy,
  onSolve,
  onListen,
}: {
  question: ExamQuestionDTO;
  busy: boolean;
  onSolve: (q: ExamQuestionDTO) => void;
  onListen: (q: ExamQuestionDTO) => void;
}) {
  const [open, setOpen] = useState(true);
  const correctIdx = correctOptionIndex(question.answer, question.options);

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2, delay: Math.min(question.idx * 0.03, 0.3) }}
    >
      <Card className={cn("gap-0 py-0", !question.answered && "border-dashed")}>
        <CardContent className="p-4 md:p-5">
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
            className="flex w-full min-h-11 items-start justify-between gap-3 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span className="min-w-0">
              <span className="flex flex-wrap items-center gap-2">
                <Badge variant="outline" className="shrink-0 tabular-nums">
                  Q{question.idx + 1}
                </Badge>
                {question.type === "qcm" ? (
                  <Badge variant="secondary" className="shrink-0">
                    QCM
                  </Badge>
                ) : (
                  <Badge variant="secondary" className="shrink-0">
                    Ouverte
                  </Badge>
                )}
                {question.answered ? (
                  <Badge className="border-transparent bg-emerald-100 text-emerald-800">
                    Répondue
                  </Badge>
                ) : (
                  <Badge variant="outline" className="border-amber-300 bg-amber-50 text-amber-800">
                    En attente
                  </Badge>
                )}
              </span>
              <span className="mt-2 block text-sm font-medium">{question.prompt}</span>
            </span>
            {open ? (
              <ChevronUp className="mt-1 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            ) : (
              <ChevronDown className="mt-1 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            )}
          </button>

          {open && (
            <div className="mt-3 space-y-3">
              {question.type === "qcm" && question.options.length > 0 && (
                <div className="space-y-1.5">
                  {question.options.map((opt, i) => {
                    const isCorrect = i === correctIdx;
                    return (
                      <div
                        key={i}
                        className={cn(
                          "flex items-start gap-2 rounded-lg border px-3 py-2 text-sm",
                          isCorrect
                            ? "border-emerald-300 bg-emerald-50 font-medium text-emerald-900"
                            : "bg-muted/30 text-muted-foreground"
                        )}
                      >
                        <span className="shrink-0 font-bold">{opt.match(/^\s*([A-Ha-h])/)?.[1]?.toUpperCase() ?? String.fromCharCode(65 + i)}.</span>
                        <span className="min-w-0 flex-1">{opt.replace(/^\s*[A-Ha-h]\s*[).:]\s*/, "")}</span>
                        {isCorrect && (
                          <Badge className="shrink-0 border-transparent bg-emerald-600 text-white">
                            ✓ Bonne réponse
                          </Badge>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}

              {question.answered ? (
                <div className="rounded-lg border border-emerald-200 bg-emerald-50/60 p-3">
                  <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-emerald-700">
                    ✍️ Réponse des agents
                  </p>
                  <div className="text-sm">
                    <MarkdownView content={question.answer ?? ""} />
                  </div>
                  {question.rationale && (
                    <div className="mt-2 rounded-md bg-background/70 p-2 text-xs text-muted-foreground">
                      <MarkdownView content={question.rationale} />
                    </div>
                  )}
                </div>
              ) : (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-10 gap-2"
                  disabled={busy}
                  onClick={() => onSolve(question)}
                >
                  {busy ? (
                    <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                  ) : (
                    <RefreshCw className="size-4" aria-hidden="true" />
                  )}
                  {busy ? "Agents au travail…" : "Faire répondre les agents"}
                </Button>
              )}

              {question.refs.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {question.refs.map((ref) => (
                    <Badge
                      key={ref}
                      variant="outline"
                      className="border-amber-300 bg-amber-50 text-[11px] font-medium text-amber-900"
                      title="Référence citée par le vérificateur"
                    >
                      📖 {ref}
                    </Badge>
                  ))}
                </div>
              )}

              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-9 gap-1.5 text-xs text-muted-foreground"
                  onClick={() => onListen(question)}
                >
                  <Volume2 className="size-3.5" aria-hidden="true" />
                  Écouter la question
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </motion.div>
  );
}

// ---------- Main section ----------

export function ExamsSection({
  documents,
  onOpenCourses,
}: {
  documents: DocumentDTO[];
  onOpenCourses: () => void;
}) {
  const [exams, setExams] = useState<ExamDTO[]>([]);
  const [listLoading, setListLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ExamDetailDTO | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const [importOpen, setImportOpen] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false);
  const [addQuestionOpen, setAddQuestionOpen] = useState(false);

  const [agents, setAgents] = useState<AgentDisplay[]>(freshAgents);
  const [phase, setPhase] = useState<"parse" | "solve" | "chat" | null>(null);
  const [solvedCount, setSolvedCount] = useState(0);
  const [solveTotal, setSolveTotal] = useState(0);

  const [chatInput, setChatInput] = useState("");
  const [chatStreaming, setChatStreaming] = useState("");

  const abortRef = useRef<AbortController | null>(null);
  const chatEndRef = useRef<HTMLDivElement | null>(null);
  const player = useTtsPlayer();
  // Stable callback reference (the `player` object itself is rebuilt each render).
  const stopPlayer = player.stop;

  const loadList = useCallback(async () => {
    try {
      const list = await fetchExams();
      setExams(list);
      return list;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Impossible de charger les examens");
      return [];
    } finally {
      setListLoading(false);
    }
  }, []);

  const loadDetail = useCallback(async (id: string) => {
    setDetailLoading(true);
    try {
      setDetail(await fetchExamDetail(id));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Impossible de charger l'examen");
    } finally {
      setDetailLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadList();
  }, [loadList]);

  useEffect(() => {
    stopPlayer();
    setDetail(null);
    setAgents(freshAgents());
    setPhase(null);
    setChatStreaming("");
    setChatInput("");
    if (selectedId) void loadDetail(selectedId);
  }, [selectedId, loadDetail, stopPlayer]);

  useEffect(() => {
    if (chatEndRef.current) chatEndRef.current.scrollTop = chatEndRef.current.scrollHeight;
  }, [chatStreaming, detail?.messages.length]);

  const patchAgent = useCallback((id: string, patch: Partial<AgentDisplay>) => {
    setAgents((prev) => prev.map((a) => (a.id === id ? { ...a, ...patch } : a)));
  }, []);

  // ---------- SSE: parse ----------

  const runParse = useCallback(
    async (examId: string) => {
      setPhase("parse");
      setAgents(freshAgents());
      const controller = new AbortController();
      abortRef.current = controller;
      try {
        await postSse<ExamEvent>(
          `/api/exams/${encodeURIComponent(examId)}/parse`,
          {},
          (event) => {
            switch (event.type) {
              case "agent.start":
                patchAgent(event.id, { status: "running", logs: [], summary: undefined });
                break;
              case "agent.log":
                setAgents((prev) =>
                  prev.map((a) => (a.id === event.id ? { ...a, logs: [...a.logs, event.message] } : a))
                );
                break;
              case "agent.done":
                patchAgent(event.id, { status: "done", summary: event.summary });
                break;
              case "agent.error":
                patchAgent(event.id, { status: "error", summary: event.message });
                break;
              case "exam.parsed":
                toast.success(`${event.questions.length} question(s) structurée(s)`);
                break;
              case "exam.error":
                toast.error(event.message);
                break;
            }
          },
          controller.signal
        );
        await loadDetail(examId);
        await loadList();
        setLinkOpen(true); // the agents ask: which courses does this exam relate to?
      } catch (err) {
        if (!isAbortError(err)) toast.error(err instanceof Error ? err.message : "Analyse impossible");
      } finally {
        setPhase(null);
        abortRef.current = null;
      }
    },
    [loadDetail, loadList, patchAgent]
  );

  // ---------- SSE: solve ----------

  const runSolve = useCallback(
    async (examId: string, questionId?: string) => {
      setPhase("solve");
      setAgents(freshAgents());
      setSolvedCount(0);
      setSolveTotal(questionId ? 1 : (detail?.questions.filter((q) => !q.answered).length ?? 0));
      const controller = new AbortController();
      abortRef.current = controller;
      try {
        await postSse<ExamEvent>(
          `/api/exams/${encodeURIComponent(examId)}/solve`,
          questionId ? { questionId } : {},
          (event) => {
            switch (event.type) {
              case "agent.start":
                patchAgent(event.id, { status: "running", logs: [], summary: undefined });
                break;
              case "agent.log":
                setAgents((prev) =>
                  prev.map((a) => (a.id === event.id ? { ...a, logs: [...a.logs, event.message] } : a))
                );
                break;
              case "agent.done":
                patchAgent(event.id, { status: "done", summary: event.summary });
                break;
              case "agent.error":
                patchAgent(event.id, { status: "error", summary: event.message });
                toast.error(event.message);
                break;
              case "question.answered":
                setSolvedCount((c) => c + 1);
                setDetail((prev) =>
                  prev
                    ? {
                        ...prev,
                        questions: prev.questions.map((q) =>
                          q.id === event.question.id ? event.question : q
                        ),
                      }
                    : prev
                );
                break;
              case "exam.error":
                toast.error(event.message);
                break;
            }
          },
          controller.signal
        );
        await loadList();
      } catch (err) {
        if (!isAbortError(err)) toast.error(err instanceof Error ? err.message : "Résolution impossible");
      } finally {
        setPhase(null);
        abortRef.current = null;
      }
    },
    [detail?.questions, loadList, patchAgent]
  );

  // ---------- SSE: chat ----------

  const sendChat = useCallback(async () => {
    const content = chatInput.trim();
    if (!content || !detail || phase) return;
    setChatInput("");
    setChatStreaming("");
    setPhase("chat");
    setAgents(freshAgents());

    const optimisticId = `tmp-${Date.now()}`;
    setDetail((prev) =>
      prev
        ? {
            ...prev,
            messages: [
              ...prev.messages,
              {
                id: optimisticId,
                role: "user" as const,
                content,
                refs: [],
                createdAt: new Date().toISOString(),
              },
            ],
          }
        : prev
    );

    const controller = new AbortController();
    abortRef.current = controller;
    try {
      await postSse<ExamEvent>(
        `/api/exams/${encodeURIComponent(detail.id)}/chat`,
        { content },
        (event) => {
          switch (event.type) {
            case "agent.start":
              patchAgent(event.id, { status: "running", logs: [], summary: undefined });
              break;
            case "agent.log":
              setAgents((prev) =>
                prev.map((a) => (a.id === event.id ? { ...a, logs: [...a.logs, event.message] } : a))
              );
              break;
            case "agent.done":
              patchAgent(event.id, { status: "done", summary: event.summary });
              break;
            case "chat.token":
              setChatStreaming((prev) => prev + event.token);
              break;
            case "chat.saved":
              if (event.message.role === "agent") {
                setChatStreaming("");
              }
              setDetail((prev) => {
                if (!prev) return prev;
                const exists = prev.messages.some((m) => m.id === event.message.id);
                return {
                  ...prev,
                  messages: exists
                    ? prev.messages.map((m) => (m.id === event.message.id ? event.message : m))
                    : [
                        ...prev.messages.filter((m) => !m.id.startsWith("tmp-") || m.role !== "user"),
                        event.message,
                      ],
                };
              });
              break;
            case "exam.error":
              toast.error(event.message);
              break;
          }
        },
        controller.signal
      );
    } catch (err) {
      if (!isAbortError(err)) toast.error(err instanceof Error ? err.message : "Envoi impossible");
      else toast.info("Génération interrompue");
    } finally {
      setChatStreaming("");
      setPhase(null);
      abortRef.current = null;
    }
  }, [chatInput, detail, phase, patchAgent]);

  // ---------- Handlers ----------

  const handleImported = useCallback(
    (exam: ExamDTO) => {
      setSelectedId(exam.id);
      void runParse(exam.id);
    },
    [runParse]
  );

  const handleLinked = useCallback(
    async (documentIds: string[]) => {
      if (!detail) return;
      try {
        const updated = await linkExam(detail.id, documentIds);
        setDetail((prev) => (prev ? { ...prev, ...updated } : prev));
        if (documentIds.length) {
          toast.success(
            `Examen connecté à ${documentIds.length} cours — les agents lisent le questionnaire…`
          );
        } else {
          toast.info("Examen sans liaison — les agents répondent avec leurs connaissances.");
        }
        void loadList();
        void runSolve(detail.id);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Association impossible");
      }
    },
    [detail, loadList, runSolve]
  );

  const handleAddQuestion = useCallback(
    async (payload: { prompt: string; options?: string[]; type?: "qcm" | "qa" }) => {
      if (!detail) return;
      setAddQuestionOpen(false);
      try {
        const q = await addExamQuestion(detail.id, payload);
        setDetail((prev) => (prev ? { ...prev, questions: [...prev.questions, q] } : prev));
        void runSolve(detail.id, q.id);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Ajout impossible");
      }
    },
    [detail, runSolve]
  );

  const handleDeleteExam = useCallback(
    async (id: string) => {
      try {
        await deleteExam(id);
        toast.success("Examen supprimé");
        if (selectedId === id) setSelectedId(null);
        void loadList();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Suppression impossible");
      }
    },
    [loadList, selectedId]
  );

  const handleListenQuestion = useCallback(
    (q: ExamQuestionDTO) => {
      const text = `${q.prompt}. ${q.answer ? `Réponse : ${q.answer}` : ""}`;
      const prefs = getTtsPrefs();
      player.play(text, { language: "fr", engine: prefs.engine, speed: prefs.speed, voice: prefs.voice });
    },
    [player]
  );

  const pendingCount = detail?.questions.filter((q) => !q.answered).length ?? 0;
  const answeredCount = detail?.questions.filter((q) => q.answered).length ?? 0;
  const busy = phase !== null;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold md:text-3xl">Examens</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Importez un examen ou un QCM : les agents le lisent, le relient à vos cours, répondent
            aux questions et gardent les réponses en banque pour l&apos;Assistant.
          </p>
        </div>
        <Button
          onClick={() => setImportOpen(true)}
          className="h-11 gap-2 bg-emerald-600 text-white hover:bg-emerald-700"
        >
          <Plus className="size-4" aria-hidden="true" />
          Importer un examen
        </Button>
      </div>

      <div className="grid gap-6 lg:grid-cols-[320px_1fr]">
        {/* Left: exam list */}
        <div className="min-w-0 space-y-4">
          <Card className="gap-0 py-0">
            <CardHeader className="border-b py-3">
              <CardTitle className="flex items-center gap-2 text-sm font-semibold">
                <ClipboardList className="size-4 text-emerald-600" aria-hidden="true" />
                Mes examens ({exams.length})
              </CardTitle>
            </CardHeader>
            <CardContent className="p-2">
              {listLoading ? (
                <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
                  <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                  Chargement…
                </div>
              ) : exams.length === 0 ? (
                <p className="p-4 text-sm text-muted-foreground">
                  Aucun examen pour l&apos;instant. Importez un QCM ou une série de questions pour
                  commencer.
                </p>
              ) : (
                <div className="scroll-thin max-h-[560px] space-y-1.5 overflow-y-auto p-1">
                  {exams.map((exam) => (
                    <button
                      key={exam.id}
                      type="button"
                      onClick={() => setSelectedId(exam.id)}
                      aria-current={selectedId === exam.id ? "true" : undefined}
                      className={cn(
                        "group w-full rounded-lg border p-3 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring hover:bg-muted/50",
                        selectedId === exam.id && "border-emerald-300 bg-emerald-50/60"
                      )}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <span className="line-clamp-2 min-w-0 flex-1 text-sm font-medium">
                          {exam.title}
                        </span>
                        <span
                          role="button"
                          tabIndex={0}
                          aria-label={`Supprimer l'examen ${exam.title}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            if (window.confirm(`Supprimer « ${exam.title} » et ses réponses ?`)) {
                              void handleDeleteExam(exam.id);
                            }
                          }}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              e.stopPropagation();
                              if (window.confirm(`Supprimer « ${exam.title} » et ses réponses ?`)) {
                                void handleDeleteExam(exam.id);
                              }
                            }
                          }}
                          className="shrink-0 rounded-md p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-red-50 hover:text-red-600 focus-visible:opacity-100 group-hover:opacity-100"
                        >
                          <Trash2 className="size-3.5" aria-hidden="true" />
                        </span>
                      </div>
                      <div className="mt-2 flex flex-wrap items-center gap-1.5">
                        <Badge variant="secondary" className="text-[10px]">
                          {KIND_LABELS[exam.kind] ?? exam.kind}
                        </Badge>
                        {exam.theology && (
                          <Badge
                            variant="outline"
                            className="border-amber-300 bg-amber-50 text-[10px] text-amber-900"
                          >
                            ⛪ Réf. bibliques
                          </Badge>
                        )}
                        {exam.linkStatus === "linked" ? (
                          <Badge className="border-transparent bg-emerald-100 text-[10px] text-emerald-800">
                            <BookOpen className="mr-1 size-3" aria-hidden="true" />
                            {exam.documentIds.length} cours
                          </Badge>
                        ) : exam.linkStatus === "sans" ? (
                          <Badge variant="outline" className="text-[10px]">
                            Sans lien
                          </Badge>
                        ) : (
                          <Badge variant="outline" className="border-amber-300 bg-amber-50 text-[10px] text-amber-800">
                            À connecter
                          </Badge>
                        )}
                        <span className="ml-auto text-[11px] tabular-nums text-muted-foreground">
                          {exam.answeredCount}/{exam.questionCount}
                        </span>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          <Alert className="border-emerald-200 bg-emerald-50/60">
            <Library className="size-4 text-emerald-600" aria-hidden="true" />
            <AlertTitle className="text-emerald-900">Banque de QCM</AlertTitle>
            <AlertDescription className="text-emerald-800">
              Chaque question résolue alimente une banque consultée par l&apos;Assistant : si vous
              reposez la même question (ou une question proche), la réponse validée remonte avec la
              bonne option en vert.
            </AlertDescription>
          </Alert>
        </div>

        {/* Right: detail */}
        <div className="min-w-0 space-y-4">
          {!selectedId ? (
            <Card>
              <CardContent className="flex flex-col items-center gap-3 py-16 text-center">
                <span className="flex size-14 items-center justify-center rounded-2xl bg-emerald-50 text-emerald-600">
                  <GraduationCap className="size-7" aria-hidden="true" />
                </span>
                <div>
                  <p className="font-medium">Sélectionnez un examen</p>
                  <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
                    Importez un examen (QCM, questions-réponses…) : les agents demandent à quels
                    cours il se rapporte, puis répondent à toutes les questions, références
                    bibliques à l&apos;appui en théologie.
                  </p>
                </div>
                <Button
                  variant="outline"
                  className="h-10 gap-2"
                  onClick={onOpenCourses}
                >
                  <BookOpen className="size-4" aria-hidden="true" />
                  Voir mes cours
                </Button>
              </CardContent>
            </Card>
          ) : detailLoading || !detail ? (
            <Card>
              <CardContent className="flex items-center gap-3 py-14 text-sm text-muted-foreground">
                <Loader2 className="size-5 animate-spin text-emerald-600" aria-hidden="true" />
                Chargement de l&apos;examen…
              </CardContent>
            </Card>
          ) : (
            <>
              {/* Exam header */}
              <Card className="gap-0 py-0">
                <CardContent className="p-4 md:p-5">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h2 className="text-lg font-bold leading-snug">{detail.title}</h2>
                      <div className="mt-2 flex flex-wrap items-center gap-1.5">
                        <Badge variant="secondary">{KIND_LABELS[detail.kind] ?? detail.kind}</Badge>
                        <Badge variant="outline">{detail.subject}</Badge>
                        {detail.theology && (
                          <Badge
                            variant="outline"
                            className="border-amber-300 bg-amber-50 text-amber-900"
                          >
                            ⛪ Contexte théologique — réf. bibliques systématiques
                          </Badge>
                        )}
                        {detail.documentTitles.map((d) => (
                          <Badge
                            key={d.id}
                            variant="outline"
                            className="border-emerald-300 bg-emerald-50 text-emerald-800"
                          >
                            <BookOpen className="mr-1 size-3" aria-hidden="true" />
                            {d.title}
                          </Badge>
                        ))}
                      </div>
                    </div>
                    <div className="flex shrink-0 flex-wrap gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-10 gap-1.5"
                        onClick={() => setLinkOpen(true)}
                      >
                        <Link2 className="size-4" aria-hidden="true" />
                        Cours liés
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-10 gap-1.5"
                        onClick={() => setAddQuestionOpen(true)}
                      >
                        <Plus className="size-4" aria-hidden="true" />
                        Question
                      </Button>
                      {pendingCount > 0 && (
                        <Button
                          size="sm"
                          className="h-10 gap-1.5 bg-emerald-600 text-white hover:bg-emerald-700"
                          disabled={busy}
                          onClick={() => void runSolve(detail.id)}
                        >
                          {phase === "solve" ? (
                            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                          ) : (
                            <Play className="size-4" aria-hidden="true" />
                          )}
                          {phase === "solve" ? "Résolution…" : `Résoudre (${pendingCount})`}
                        </Button>
                      )}
                    </div>
                  </div>

                  {detail.questions.length > 0 && (
                    <div className="mt-4 space-y-1.5">
                      <div className="flex items-center justify-between text-xs text-muted-foreground">
                        <span>
                          {answeredCount}/{detail.questions.length} question(s) répondue(s)
                        </span>
                        {phase === "solve" && solveTotal > 0 && (
                          <span className="tabular-nums">
                            {solvedCount}/{solveTotal} en cours
                          </span>
                        )}
                      </div>
                      <Progress
                        value={(answeredCount / Math.max(detail.questions.length, 1)) * 100}
                        className="h-2"
                        aria-label="Progression de résolution"
                      />
                    </div>
                  )}

                  {detail.theology && (
                    <p className="mt-3 text-xs text-muted-foreground">
                      ⛪ Les agents insèrent les références bibliques (Livre Chapitre:Versets) même
                      quand l&apos;examen ne les demande pas, pour que vous puissiez vérifier la
                      cohérence de chaque réponse.
                    </p>
                  )}
                </CardContent>
              </Card>

              {/* Agents status while busy */}
              {busy && (
                <Card className="gap-0 py-0">
                  <CardContent className="p-4">
                    <AgentStatusList agents={agents} />
                    {phase === "solve" && solveTotal > 0 && (
                      <div className="mt-3 flex items-center gap-2">
                        <Progress
                          value={(solvedCount / Math.max(solveTotal, 1)) * 100}
                          className="h-1.5"
                        />
                        <Button
                          variant="outline"
                          size="icon"
                          className="size-8 shrink-0"
                          onClick={() => abortRef.current?.abort()}
                          aria-label="Arrêter"
                        >
                          <Square className="size-3.5" aria-hidden="true" />
                        </Button>
                      </div>
                    )}
                  </CardContent>
                </Card>
              )}

              {/* Questions */}
              <div className="space-y-3">
                {detail.questions.length === 0 ? (
                  <Card>
                    <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
                      <FileQuestion className="size-8 text-muted-foreground" aria-hidden="true" />
                      <p className="text-sm text-muted-foreground">
                        Aucune question structurée pour l&apos;instant.
                      </p>
                      <Button
                        variant="outline"
                        className="h-10 gap-2"
                        disabled={busy}
                        onClick={() => void runParse(detail.id)}
                      >
                        {phase === "parse" ? (
                          <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                        ) : (
                          <RefreshCw className="size-4" aria-hidden="true" />
                        )}
                        {phase === "parse" ? "Lecture en cours…" : "Relancer la lecture par les agents"}
                      </Button>
                    </CardContent>
                  </Card>
                ) : (
                  detail.questions.map((q) => (
                    <QuestionCard
                      key={q.id}
                      question={q}
                      busy={busy}
                      onSolve={(question) => void runSolve(detail.id, question.id)}
                      onListen={handleListenQuestion}
                    />
                  ))
                )}
              </div>

              {/* Chat au fil de l'exercice */}
              <Card className="gap-0 py-0">
                <CardHeader className="border-b py-3">
                  <CardTitle className="flex items-center gap-2 text-sm font-semibold">
                    <Headphones className="size-4 text-emerald-600" aria-hidden="true" />
                    Au fil de l&apos;exercice — posez vos questions
                  </CardTitle>
                  <CardDescription className="text-xs">
                    Demandez une explication, introduisez un QCM manuellement, ou demandez une
                    référence biblique. Les agents connaissent l&apos;examen et vos cours liés.
                  </CardDescription>
                </CardHeader>
                <CardContent className="p-4">
                  <div
                    ref={chatEndRef}
                    className="scroll-thin max-h-80 space-y-3 overflow-y-auto pr-1"
                    aria-live="polite"
                  >
                    {detail.messages.length === 0 && !chatStreaming && (
                      <p className="py-6 text-center text-sm text-muted-foreground">
                        Exemple : « Pourquoi la réponse C est-elle correcte ? » ou collez un QCM
                        pour obtenir la réponse.
                      </p>
                    )}
                    {detail.messages.map((m) =>
                      m.role === "user" ? (
                        <div key={m.id} className="flex justify-end">
                          <div className="max-w-[85%] rounded-2xl rounded-br-md bg-emerald-600 px-4 py-2.5 text-sm text-white">
                            {m.content}
                          </div>
                        </div>
                      ) : (
                        <div key={m.id} className="flex justify-start">
                          <div className="max-w-[92%] rounded-2xl rounded-bl-md border bg-background px-4 py-3">
                            <div className="text-sm">
                              <MarkdownView content={m.content} />
                            </div>
                            {m.refs.length > 0 && (
                              <div className="mt-2 flex flex-wrap gap-1.5">
                                {m.refs.map((ref) => (
                                  <Badge
                                    key={ref}
                                    variant="outline"
                                    className="border-amber-300 bg-amber-50 text-[10px] text-amber-900"
                                  >
                                    📖 {ref}
                                  </Badge>
                                ))}
                              </div>
                            )}
                          </div>
                        </div>
                      )
                    )}
                    {chatStreaming && (
                      <div className="flex justify-start">
                        <div className="max-w-[92%] rounded-2xl rounded-bl-md border bg-background px-4 py-3">
                          <div className="text-sm">
                            <MarkdownView content={chatStreaming} />
                          </div>
                          <span className="animate-pulse font-bold text-emerald-600" aria-hidden="true">
                            ▍
                          </span>
                        </div>
                      </div>
                    )}
                  </div>

                  <Separator className="my-3" />

                  <div className="flex items-end gap-2">
                    <Textarea
                      rows={2}
                      value={chatInput}
                      onChange={(e) => setChatInput(e.target.value)}
                      onKeyDown={(e) => {
                        // Tab = envoyer (au même titre que le bouton), Maj+Tab = indentation.
                        if (e.key === "Tab" && !e.shiftKey && chatInput.trim().length > 0) {
                          e.preventDefault();
                          void sendChat();
                        } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                          e.preventDefault();
                          void sendChat();
                        }
                      }}
                      placeholder="Posez une question sur l'examen… (Tab ou Ctrl+Entrée pour envoyer)"
                      disabled={busy && phase !== "chat"}
                      className="min-h-[52px] resize-none"
                      aria-label="Votre question aux agents"
                    />
                    {phase === "chat" ? (
                      <Button
                        variant="outline"
                        size="icon"
                        className="size-11 shrink-0"
                        onClick={() => abortRef.current?.abort()}
                        aria-label="Arrêter la génération"
                      >
                        <Square className="size-4" aria-hidden="true" />
                      </Button>
                    ) : (
                      <Button
                        className="size-11 shrink-0 bg-emerald-600 text-white hover:bg-emerald-700"
                        onClick={() => void sendChat()}
                        disabled={busy || chatInput.trim().length === 0}
                        aria-label="Envoyer"
                      >
                        <Send className="size-4" aria-hidden="true" />
                      </Button>
                    )}
                  </div>
                  <p className="mt-1.5 text-[11px] text-muted-foreground">
                    Astuce : appuyez sur <kbd className="rounded border bg-muted px-1">Tab</kbd> ou{" "}
                    <kbd className="rounded border bg-muted px-1">Ctrl+Entrée</kbd> pour envoyer.
                  </p>
                </CardContent>
              </Card>
            </>
          )}
        </div>
      </div>

      <ImportDialog open={importOpen} onOpenChange={setImportOpen} onImported={handleImported} />
      {detail && (
        <>
          <LinkDialog
            key={`${detail.id}-${linkOpen}`}
            open={linkOpen}
            onOpenChange={setLinkOpen}
            exam={detail}
            documents={documents}
            onLinked={(ids) => void handleLinked(ids)}
          />
          <AddQuestionDialog
            open={addQuestionOpen}
            onOpenChange={setAddQuestionOpen}
            onAdded={(payload) => void handleAddQuestion(payload)}
          />
        </>
      )}
    </div>
  );
}
