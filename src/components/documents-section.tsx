"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  BookOpen,
  CheckCircle2,
  FileUp,
  Loader2,
  Trash2,
  Upload,
} from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Progress } from "@/components/ui/progress";
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
import { isAbortError, postSse } from "@/lib/sse-client";
import { deleteDocument, fetchDocuments } from "@/lib/api-client";
import { INGEST_AGENT_ORDER } from "@/lib/types";
import type { DocumentDTO, IngestEvent } from "@/lib/types";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

const ACCEPTED = ".pdf,.docx,.txt,.md,.png,.jpg,.jpeg,.webp";
const FORMATS_HINT = "PDF, DOCX, TXT, MD, PNG, JPG, WEBP";

function freshAgents(): AgentDisplay[] {
  return INGEST_AGENT_ORDER.map((a) => ({
    id: a.id,
    label: a.label,
    status: "idle" as const,
    logs: [],
  }));
}

export function DocumentsSection() {
  const [title, setTitle] = useState("");
  const [subject, setSubject] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [agents, setAgents] = useState<AgentDisplay[]>(freshAgents);
  const [success, setSuccess] = useState<string | null>(null);

  const [documents, setDocuments] = useState<DocumentDTO[]>([]);
  const [loadingDocs, setLoadingDocs] = useState(true);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const inputRef = useRef<HTMLInputElement | null>(null);

  const loadDocuments = useCallback(async () => {
    try {
      setDocuments(await fetchDocuments());
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Impossible de charger les cours");
    } finally {
      setLoadingDocs(false);
    }
  }, []);

  useEffect(() => {
    void loadDocuments();
  }, [loadDocuments]);

  // Indeterminate-feeling progress while uploading.
  useEffect(() => {
    if (!uploading) return;
    const t = window.setInterval(() => {
      setProgress((p) => (p < 88 ? p + Math.max(1, Math.round(Math.random() * 5)) : p));
    }, 450);
    return () => window.clearInterval(t);
  }, [uploading]);

  const patchAgent = useCallback((id: string, patch: Partial<AgentDisplay>) => {
    setAgents((prev) => prev.map((a) => (a.id === id ? { ...a, ...patch } : a)));
  }, []);

  const handleEvent = useCallback(
    (event: IngestEvent, docTitle: string) => {
      switch (event.type) {
        case "ingest.start":
          setProgress(10);
          break;
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
          setProgress((p) => Math.min(95, p + 25));
          break;
        case "agent.error":
          patchAgent(event.id, { status: "error", summary: event.message });
          break;
        case "ingest.done":
          setProgress(100);
          toast.success(`« ${docTitle} » importé — ${event.document.chunks} segments indexés`);
          setSuccess("Prêt à répondre à vos questions");
          window.setTimeout(() => setSuccess(null), 6000);
          setTitle("");
          setSubject("");
          setFile(null);
          if (inputRef.current) inputRef.current.value = "";
          void loadDocuments();
          break;
        case "ingest.error":
          toast.error(event.message);
          setAgents((prev) =>
            prev.map((a) => (a.status === "running" ? { ...a, status: "error" as const } : a))
          );
          break;
      }
    },
    [patchAgent, loadDocuments]
  );

  const handleImport = async () => {
    if (!file || !title.trim() || uploading) return;
    setUploading(true);
    setSuccess(null);
    setAgents(freshAgents());
    setProgress(5);

    const fd = new FormData();
    fd.append("file", file);
    fd.append("title", title.trim());
    fd.append("subject", subject.trim());
    const docTitle = title.trim();

    try {
      await postSse<IngestEvent>("/api/documents", fd, (event) => handleEvent(event, docTitle));
    } catch (err) {
      if (isAbortError(err)) {
        toast.info("Import interrompu");
      } else {
        toast.error(err instanceof Error ? err.message : "Erreur pendant l'import");
      }
      setAgents((prev) =>
        prev.map((a) => (a.status === "running" ? { ...a, status: "error" as const } : a))
      );
    } finally {
      setUploading(false);
      setProgress(0);
    }
  };

  const handleDelete = async (id: string) => {
    setDeletingId(id);
    try {
      await deleteDocument(id);
      toast.success("Cours supprimé");
      void loadDocuments();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Suppression impossible");
    } finally {
      setDeletingId(null);
    }
  };

  const showAgents = uploading || agents.some((a) => a.status !== "idle");
  const canImport = Boolean(file) && title.trim().length > 0 && !uploading;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold md:text-3xl">Mes cours</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Importez vos documents : les agents les lisent, les découpent et les indexent.
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-5">
        {/* Upload column */}
        <div className="space-y-6 lg:col-span-2">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Importer un cours</CardTitle>
              <CardDescription>Le contenu est extrait puis indexé pour l&apos;assistant.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="doc-title">Titre</Label>
                <Input
                  id="doc-title"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="Ex : Maths — Chapitre 3 : dérivées"
                  disabled={uploading}
                  className="h-11"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="doc-subject">Matière</Label>
                <Input
                  id="doc-subject"
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                  placeholder="Ex : Mathématiques"
                  disabled={uploading}
                  className="h-11"
                />
              </div>

              <div className="space-y-2">
                <Label>Fichier</Label>
                <div
                  role="button"
                  tabIndex={0}
                  aria-label="Choisir un fichier à importer"
                  onClick={() => inputRef.current?.click()}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      inputRef.current?.click();
                    }
                  }}
                  onDragOver={(e) => {
                    e.preventDefault();
                    setDragOver(true);
                  }}
                  onDragLeave={() => setDragOver(false)}
                  onDrop={(e) => {
                    e.preventDefault();
                    setDragOver(false);
                    const f = e.dataTransfer.files?.[0];
                    if (f) setFile(f);
                  }}
                  className={cn(
                    "cursor-pointer rounded-lg border-2 border-dashed p-8 text-center transition-colors outline-none hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring",
                    dragOver && "border-emerald-500 bg-emerald-50"
                  )}
                >
                  <FileUp className="mx-auto size-8 text-muted-foreground" aria-hidden="true" />
                  <p className="mt-2 text-sm font-medium">
                    {file ? file.name : "Glissez un fichier ici ou cliquez pour parcourir"}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">{FORMATS_HINT}</p>
                </div>
                <input
                  ref={inputRef}
                  type="file"
                  accept={ACCEPTED}
                  className="hidden"
                  onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                />
              </div>

              <Button
                onClick={() => void handleImport()}
                disabled={!canImport}
                className="h-11 w-full bg-emerald-600 text-white hover:bg-emerald-700"
              >
                {uploading ? (
                  <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                ) : (
                  <Upload className="size-4" aria-hidden="true" />
                )}
                {uploading ? "Import en cours…" : "Importer"}
              </Button>

              {success && (
                <Alert className="border-emerald-200 bg-emerald-50 text-emerald-900">
                  <CheckCircle2 className="size-4 text-emerald-600" />
                  <AlertTitle>Import réussi</AlertTitle>
                  <AlertDescription>✅ {success}</AlertDescription>
                </Alert>
              )}

              {showAgents && (
                <div className="space-y-3 border-t pt-4">
                  <Progress value={progress} aria-label="Progression de l'import" />
                  <AgentStatusList agents={agents} />
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Documents list column */}
        <div className="space-y-4 lg:col-span-3">
          <h2 className="text-lg font-semibold">Mes cours ({documents.length})</h2>

          {loadingDocs ? (
            <Card className="gap-0 py-0">
              <CardContent className="flex items-center gap-3 p-6 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                Chargement des cours…
              </CardContent>
            </Card>
          ) : documents.length === 0 ? (
            <Card className="gap-0 py-0">
              <CardContent className="flex flex-col items-center gap-2 p-8 text-center">
                <BookOpen className="size-10 text-muted-foreground" aria-hidden="true" />
                <p className="text-sm text-muted-foreground">
                  Aucun cours pour l&apos;instant — importez votre premier document.
                </p>
              </CardContent>
            </Card>
          ) : (
            <div className="scroll-thin max-h-[480px] space-y-3 overflow-y-auto pr-1">
              {documents.map((doc) => (
                <Card key={doc.id} className="gap-0 py-0">
                  <CardContent className="p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="max-w-full truncate font-medium">{doc.title}</p>
                          <Badge variant="secondary">{doc.subject}</Badge>
                          <Badge variant="outline" className="uppercase">
                            {doc.kind}
                          </Badge>
                        </div>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {doc.chunks} segments · {doc.chars.toLocaleString("fr-FR")} caractères ·{" "}
                          {new Date(doc.createdAt).toLocaleDateString("fr-FR")}
                        </p>
                        {doc.note ? (
                          <p className="mt-1 text-xs text-muted-foreground">{doc.note}</p>
                        ) : null}
                      </div>

                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-10 shrink-0 text-red-500 hover:bg-red-50 hover:text-red-600"
                            disabled={deletingId === doc.id}
                            aria-label={`Supprimer ${doc.title}`}
                          >
                            {deletingId === doc.id ? (
                              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                            ) : (
                              <Trash2 className="size-4" aria-hidden="true" />
                            )}
                          </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>Supprimer ce cours ?</AlertDialogTitle>
                            <AlertDialogDescription>
                              « {doc.title} » et ses {doc.chunks} segments indexés seront définitivement
                              supprimés. L&apos;assistant ne pourra plus y répondre.
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>Annuler</AlertDialogCancel>
                            <AlertDialogAction
                              className="bg-red-600 text-white hover:bg-red-700"
                              onClick={() => void handleDelete(doc.id)}
                            >
                              Supprimer
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
