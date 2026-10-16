"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  AudioLines,
  BookOpen,
  BookOpenCheck,
  CheckCircle2,
  Eye,
  FileText,
  FileUp,
  Folder,
  FolderPlus,
  FolderSymlink,
  Headphones,
  Image as ImageIcon,
  Loader2,
  MoreHorizontal,
  PenLine,
  Pencil,
  Search,
  Trash2,
  Upload,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Progress } from "@/components/ui/progress";
import { Textarea } from "@/components/ui/textarea";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { AgentStatusList, type AgentDisplay } from "@/components/agent-status";
import { isAbortError, postSse } from "@/lib/sse-client";
import {
  createFolder,
  deleteDocument,
  deleteFolder,
  fetchDocumentDetail,
  fetchDocumentPdf,
  fetchFolders,
  updateDocument,
  updateFolder,
} from "@/lib/api-client";
import { INGEST_AGENT_ORDER } from "@/lib/types";
import type { DocumentDTO, DocumentDetailDTO, FolderDTO, IngestEvent } from "@/lib/types";
import { ReviewDialog } from "@/components/review-dialog";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

const ACCEPTED =
  ".pdf,.docx,.txt,.md,.epub,.png,.jpg,.jpeg,.webp,.mp3,.wav,.m4a,.ogg,.webm,.aac,.flac";
const FORMATS_HINT = "PDF, DOCX, TXT, EPUB, MP3/WAV (transcrit), PNG/JPG (OCR) — 80 Mo max";
const FOLDER_COLORS = ["#10b981", "#f59e0b", "#f43f5e", "#14b8a6", "#a855f7", "#78716c"];
/** Image kinds that go through OCR and may need a manual correction pass. */
const SCAN_KINDS = new Set(["png", "jpg", "jpeg", "webp"]);

/** Per-kind badge metadata for the document cards. */
const KIND_META: Record<string, { icon: LucideIcon; label: string; className?: string }> = {
  pdf: { icon: FileText, label: "PDF" },
  docx: { icon: FileText, label: "DOCX" },
  txt: { icon: FileText, label: "TXT" },
  md: { icon: FileText, label: "MD" },
  epub: { icon: BookOpen, label: "EPUB" },
  audio: { icon: AudioLines, label: "Audio", className: "border-amber-300 bg-amber-50 text-amber-700" },
  png: { icon: ImageIcon, label: "PNG" },
  jpg: { icon: ImageIcon, label: "JPG" },
  jpeg: { icon: ImageIcon, label: "JPEG" },
  webp: { icon: ImageIcon, label: "WEBP" },
};

function KindBadge({ kind }: { kind: string }) {
  const meta = KIND_META[kind] ?? { icon: FileText, label: kind.toUpperCase() };
  const Icon = meta.icon;
  return (
    <Badge variant="outline" className={cn("gap-1 text-[10px] font-semibold uppercase", meta.className)}>
      <Icon className="size-3" aria-hidden="true" />
      {meta.label}
    </Badge>
  );
}

function freshAgents(): AgentDisplay[] {
  return INGEST_AGENT_ORDER.map((a) => ({
    id: a.id,
    label: a.label,
    status: "idle" as const,
    logs: [],
  }));
}

export interface DocumentsSectionProps {
  documents: DocumentDTO[];
  loading?: boolean;
  onDocumentsChanged: () => void;
  onRevise?: (documentId: string) => void;
  onImported?: (doc: DocumentDTO) => void;
}

export function DocumentsSection({
  documents,
  loading = false,
  onDocumentsChanged,
  onRevise,
  onImported,
}: DocumentsSectionProps) {
  // ----- Upload flow (unchanged) -----
  const [title, setTitle] = useState("");
  const [subject, setSubject] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [agents, setAgents] = useState<AgentDisplay[]>(freshAgents);
  const [success, setSuccess] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // ----- Folders -----
  const [folders, setFolders] = useState<FolderDTO[]>([]);
  const [activeFolder, setActiveFolder] = useState<string>("all");
  const [newFolderName, setNewFolderName] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [renamingFolder, setRenamingFolder] = useState<{ id: string; name: string } | null>(null);
  const [savingFolder, setSavingFolder] = useState(false);
  const [folderToDelete, setFolderToDelete] = useState<FolderDTO | null>(null);
  const [deletingFolder, setDeletingFolder] = useState(false);

  // ----- Search + doc dialogs -----
  const [search, setSearch] = useState("");
  const [docToRename, setDocToRename] = useState<{ id: string; title: string } | null>(null);
  const [savingRename, setSavingRename] = useState(false);
  const [docToEdit, setDocToEdit] = useState<{ id: string; title: string; text: string } | null>(null);
  const [loadingEditText, setLoadingEditText] = useState(false);
  const [savingText, setSavingText] = useState(false);
  const [docToDelete, setDocToDelete] = useState<DocumentDTO | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  // ----- OCR review (scanned documents with status "à vérifier") -----
  const [reviewDoc, setReviewDoc] = useState<DocumentDTO | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);

  const openReviewDialog = (doc: DocumentDTO) => {
    setReviewDoc(doc);
    setReviewOpen(true);
  };

  /** After a correction save: refresh the list, then land on Révision with the greeting. */
  const handleReviewSaved = (updated: DocumentDetailDTO) => {
    onDocumentsChanged();
    onImported?.(updated);
  };

  /** Opens the generated PDF in a new tab (blob URL — popup-blocker safe). */
  const openDocumentPdf = async (doc: DocumentDTO) => {
    const win = window.open("", "_blank"); // open within the user gesture
    if (!win) {
      toast.error("Le navigateur a bloqué l'ouverture du PDF — autorise les pop-ups.");
      return;
    }
    try {
      const blob = await fetchDocumentPdf(doc.id);
      const url = URL.createObjectURL(blob);
      win.location.href = url;
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (err) {
      win.close();
      toast.error(err instanceof Error ? err.message : "PDF non encore généré — corrige d'abord le texte.");
    }
  };

  const loadFolders = useCallback(async () => {
    try {
      setFolders(await fetchFolders());
    } catch (err) {
      console.error(err);
    }
  }, []);

  useEffect(() => {
    void loadFolders();
  }, [loadFolders]);

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
        case "ingest.done": {
          setProgress(100);
          // Scanned documents (OCR) land with status "à vérifier": keep the user
          // here to correct the extracted text first — the redirect to Révision
          // happens after the correction is saved (handleReviewSaved).
          const needsReview = event.document.status === "à vérifier";
          toast.success(`« ${docTitle} » importé — ${event.document.chunks} segments indexés`);
          setSuccess(
            needsReview
              ? "Texte extrait par OCR — vérifie-le dans la fenêtre ouverte, puis enregistre."
              : "Prêt à réviser — direction l'onglet Révision"
          );
          window.setTimeout(() => setSuccess(null), 6000);
          setTitle("");
          setSubject("");
          setFile(null);
          if (inputRef.current) inputRef.current.value = "";
          onDocumentsChanged();
          void loadFolders();
          if (needsReview) {
            setReviewDoc(event.document);
            setReviewOpen(true);
          } else {
            onImported?.(event.document);
          }
          break;
        }
        case "ingest.error":
          toast.error(event.message);
          setAgents((prev) =>
            prev.map((a) => (a.status === "running" ? { ...a, status: "error" as const } : a))
          );
          break;
      }
    },
    [patchAgent, onDocumentsChanged, onImported, loadFolders]
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

  // ----- Folder actions -----

  const handleCreateFolder = async (color: string) => {
    const name = newFolderName.trim();
    if (!name || creatingFolder) return;
    setCreatingFolder(true);
    try {
      await createFolder({ name, color });
      toast.success(`Dossier « ${name} » créé`);
      setNewFolderName("");
      setCreateOpen(false);
      await loadFolders();
      onDocumentsChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Création du dossier impossible");
    } finally {
      setCreatingFolder(false);
    }
  };

  const handleRenameFolder = async () => {
    if (!renamingFolder) return;
    const name = renamingFolder.name.trim();
    if (!name) return;
    setSavingFolder(true);
    try {
      await updateFolder(renamingFolder.id, { name });
      toast.success("Dossier renommé");
      setRenamingFolder(null);
      await loadFolders();
      onDocumentsChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Renommage impossible");
    } finally {
      setSavingFolder(false);
    }
  };

  const handleDeleteFolder = async () => {
    if (!folderToDelete) return;
    setDeletingFolder(true);
    try {
      await deleteFolder(folderToDelete.id);
      toast.success(`Dossier « ${folderToDelete.name} » supprimé — les cours sont conservés`);
      if (activeFolder === folderToDelete.id) setActiveFolder("all");
      setFolderToDelete(null);
      await loadFolders();
      onDocumentsChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Suppression impossible");
    } finally {
      setDeletingFolder(false);
    }
  };

  // ----- Document actions -----

  const handleDeleteDoc = async (id: string) => {
    setDeletingId(id);
    try {
      await deleteDocument(id);
      toast.success("Cours supprimé");
      setDocToDelete(null);
      onDocumentsChanged();
      void loadFolders();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Suppression impossible");
    } finally {
      setDeletingId(null);
    }
  };

  const handleRenameDoc = async () => {
    if (!docToRename) return;
    const newTitle = docToRename.title.trim();
    if (!newTitle) return;
    setSavingRename(true);
    try {
      await updateDocument(docToRename.id, { title: newTitle });
      toast.success("Titre modifié");
      setDocToRename(null);
      onDocumentsChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Renommage impossible");
    } finally {
      setSavingRename(false);
    }
  };

  const openEditDialog = async (doc: DocumentDTO) => {
    setDocToEdit({ id: doc.id, title: doc.title, text: "" });
    setLoadingEditText(true);
    try {
      const detail = await fetchDocumentDetail(doc.id);
      setDocToEdit({ id: doc.id, title: doc.title, text: detail.textContent });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Impossible de charger le texte");
      setDocToEdit(null);
    } finally {
      setLoadingEditText(false);
    }
  };

  const handleSaveText = async () => {
    if (!docToEdit || savingText) return;
    setSavingText(true);
    try {
      await updateDocument(docToEdit.id, { textContent: docToEdit.text });
      toast.success("Document mis à jour — index recalculé");
      setDocToEdit(null);
      onDocumentsChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Mise à jour impossible");
    } finally {
      setSavingText(false);
    }
  };

  const handleMoveDoc = async (doc: DocumentDTO, folderId: string | null) => {
    try {
      await updateDocument(doc.id, { folderId });
      toast.success(
        folderId
          ? `« ${doc.title} » déplacé dans « ${folders.find((f) => f.id === folderId)?.name ?? "dossier"} »`
          : `« ${doc.title} » retiré du dossier`
      );
      onDocumentsChanged();
      void loadFolders();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Déplacement impossible");
    }
  };

  // ----- Derived -----

  const q = search.trim().toLowerCase();
  const visibleDocs = documents.filter(
    (doc) =>
      (activeFolder === "all" || doc.folderId === activeFolder) &&
      (q.length === 0 || doc.title.toLowerCase().includes(q) || doc.subject.toLowerCase().includes(q))
  );

  const showAgents = uploading || agents.some((a) => a.status !== "idle");
  const canImport = Boolean(file) && title.trim().length > 0 && !uploading;
  const activeFolderObj = folders.find((f) => f.id === activeFolder) ?? null;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold md:text-3xl">Mes cours</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Importez vos documents : les agents les lisent, les découpent et les indexent. Regroupez-les
          en dossiers thématiques.
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
          {/* Folders bar */}
          <div className="rounded-xl border bg-muted/30 p-3">
            <div className="mb-2 flex min-w-0 flex-wrap items-center gap-2">
              <Folder className="size-4 shrink-0 text-emerald-600" aria-hidden="true" />
              <p className="text-sm font-semibold">Dossiers</p>
              {activeFolderObj && (
                <span className="min-w-0 truncate text-xs text-muted-foreground">
                  — filtré sur « {activeFolderObj.name} »
                </span>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              <button
                type="button"
                onClick={() => setActiveFolder("all")}
                aria-pressed={activeFolder === "all"}
                className={cn(
                  "min-h-8 rounded-full border px-3 text-xs font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  activeFolder === "all"
                    ? "border-emerald-600 bg-emerald-600 text-white"
                    : "border-border bg-transparent text-muted-foreground hover:bg-muted hover:text-foreground"
                )}
              >
                Tous
              </button>

              {folders.map((folder) => {
                const active = activeFolder === folder.id;
                return (
                  <div
                    key={folder.id}
                    className={cn(
                      "inline-flex items-center overflow-hidden rounded-full border transition-colors",
                      active ? "border-emerald-600 bg-emerald-600 text-white" : "border-border bg-transparent"
                    )}
                  >
                    <button
                      type="button"
                      onClick={() => setActiveFolder(folder.id)}
                      aria-pressed={active}
                      className="flex min-h-8 items-center gap-1.5 px-3 text-xs font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <span
                        className="size-2.5 shrink-0 rounded-full border border-black/10"
                        style={{ backgroundColor: folder.color }}
                        aria-hidden="true"
                      />
                      {folder.name}
                      <span
                        className={cn(
                          "rounded-full px-1.5 text-[10px] tabular-nums",
                          active ? "bg-white/20" : "bg-muted text-muted-foreground"
                        )}
                      >
                        {folder.documentCount}
                      </span>
                    </button>
                    {active && (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <button
                            type="button"
                            aria-label={`Gérer le dossier ${folder.name}`}
                            className="flex h-8 items-center border-l border-white/20 px-1.5 outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          >
                            <Pencil className="size-3" aria-hidden="true" />
                          </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="start">
                          <DropdownMenuItem onSelect={() => setRenamingFolder({ id: folder.id, name: folder.name })}>
                            <Pencil aria-hidden="true" />
                            Renommer
                          </DropdownMenuItem>
                          <DropdownMenuItem variant="destructive" onSelect={() => setFolderToDelete(folder)}>
                            <Trash2 aria-hidden="true" />
                            Supprimer
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
                  </div>
                );
              })}

              {/* Inline create */}
              <div className="ml-1 flex items-center gap-1.5">
                <Input
                  value={newFolderName}
                  onChange={(e) => setNewFolderName(e.target.value)}
                  placeholder="Nouveau dossier…"
                  aria-label="Nom du nouveau dossier"
                  className="h-8 w-40 text-xs"
                />
                <Popover open={createOpen} onOpenChange={setCreateOpen}>
                  <PopoverTrigger asChild>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-8 gap-1.5 text-xs"
                      disabled={newFolderName.trim().length === 0 || creatingFolder}
                    >
                      {creatingFolder ? (
                        <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                      ) : (
                        <FolderPlus className="size-3.5" aria-hidden="true" />
                      )}
                      Nouveau dossier
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-auto p-3" align="start">
                    <p className="mb-2 text-xs font-medium">Choisis une couleur</p>
                    <div className="flex items-center gap-2">
                      {FOLDER_COLORS.map((color) => (
                        <button
                          key={color}
                          type="button"
                          aria-label={`Créer le dossier avec la couleur ${color}`}
                          onClick={() => void handleCreateFolder(color)}
                          disabled={creatingFolder}
                          className="size-7 rounded-full border border-black/10 outline-none transition-transform hover:scale-110 focus-visible:ring-2 focus-visible:ring-ring"
                          style={{ backgroundColor: color }}
                        />
                      ))}
                    </div>
                  </PopoverContent>
                </Popover>
              </div>
            </div>
          </div>

          {/* Search + heading */}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-lg font-semibold">
              Mes cours{" "}
              <span className="text-sm font-normal text-muted-foreground">({visibleDocs.length})</span>
            </h2>
            <div className="relative">
              <Search
                className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
                aria-hidden="true"
              />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Rechercher un cours…"
                aria-label="Rechercher un cours par titre ou matière"
                className="h-10 w-full pl-9 sm:w-64"
              />
            </div>
          </div>

          {loading ? (
            <Card className="gap-0 py-0">
              <CardContent className="flex items-center gap-3 p-6 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                Chargement des cours…
              </CardContent>
            </Card>
          ) : visibleDocs.length === 0 ? (
            <Card className="gap-0 py-0">
              <CardContent className="flex flex-col items-center gap-2 p-8 text-center">
                <BookOpenCheck className="size-10 text-muted-foreground" aria-hidden="true" />
                <p className="text-sm text-muted-foreground">
                  {documents.length === 0
                    ? "Aucun cours pour l'instant — importez votre premier document."
                    : "Aucun cours ne correspond à ce filtre."}
                </p>
              </CardContent>
            </Card>
          ) : (
            <div className="scroll-thin max-h-[520px] space-y-3 overflow-y-auto pr-1">
              {visibleDocs.map((doc) => (
                <Card key={doc.id} className="gap-0 py-0">
                  <CardContent className="p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="max-w-full truncate font-medium">{doc.title}</p>
                          <Badge
                            variant="secondary"
                            className="max-w-full whitespace-normal break-words"
                          >
                            {doc.subject}
                          </Badge>
                          <Badge
                            variant="outline"
                            className={cn(
                              "text-[10px] font-semibold uppercase",
                              doc.language === "en"
                                ? "border-amber-300 bg-amber-50 text-amber-700"
                                : "border-emerald-300 bg-emerald-50 text-emerald-700"
                            )}
                          >
                            {doc.language === "en" ? "EN" : "FR"}
                          </Badge>
                          <KindBadge kind={doc.kind} />
                          {doc.status === "à vérifier" && (
                            <Badge
                              asChild
                              variant="outline"
                              className="cursor-pointer gap-1 border-amber-300 bg-amber-50 text-[10px] font-semibold uppercase text-amber-700 hover:bg-amber-100"
                            >
                              <button
                                type="button"
                                onClick={() => openReviewDialog(doc)}
                                aria-label={`Corriger le texte extrait de ${doc.title}`}
                              >
                                <PenLine className="size-3" aria-hidden="true" />
                                À vérifier
                              </button>
                            </Badge>
                          )}
                          {doc.folderName && (
                            <Badge variant="outline" className="gap-1 text-[10px]">
                              <span
                                className="size-2 rounded-full border border-black/10"
                                style={{ backgroundColor: doc.folderColor ?? "#78716c" }}
                                aria-hidden="true"
                              />
                              {doc.folderName}
                            </Badge>
                          )}
                        </div>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {doc.chunks} segments · {doc.chars.toLocaleString("fr-FR")} caractères ·{" "}
                          {doc.qaCount} question{doc.qaCount > 1 ? "s" : ""} ·{" "}
                          {new Date(doc.createdAt).toLocaleDateString("fr-FR")}
                        </p>
                        {doc.note ? (
                          <p className="mt-1 text-xs text-muted-foreground">{doc.note}</p>
                        ) : null}
                      </div>

                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-10 shrink-0 text-muted-foreground hover:text-foreground"
                            aria-label={`Actions pour ${doc.title}`}
                          >
                            <MoreHorizontal className="size-4" aria-hidden="true" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-56">
                          {onRevise && (
                            <DropdownMenuItem
                              onSelect={() => onRevise(doc.id)}
                              className="text-emerald-700 data-[variant=default]:text-emerald-700"
                            >
                              <BookOpenCheck aria-hidden="true" />
                              Réviser
                            </DropdownMenuItem>
                          )}
                          {onRevise && (
                            <DropdownMenuItem onSelect={() => onRevise(doc.id)}>
                              <Headphones aria-hidden="true" />
                              Écouter
                            </DropdownMenuItem>
                          )}
                          {(doc.status === "à vérifier" || SCAN_KINDS.has(doc.kind)) && (
                            <DropdownMenuItem onSelect={() => openReviewDialog(doc)}>
                              <PenLine aria-hidden="true" />
                              Corriger le texte (OCR)
                            </DropdownMenuItem>
                          )}
                          {doc.kind === "pdf" && (
                            <DropdownMenuItem onSelect={() => void openDocumentPdf(doc)}>
                              <FileText aria-hidden="true" />
                              Ouvrir le PDF
                            </DropdownMenuItem>
                          )}
                          <DropdownMenuSeparator />
                          <DropdownMenuItem onSelect={() => setDocToRename({ id: doc.id, title: doc.title })}>
                            <Pencil aria-hidden="true" />
                            Renommer
                          </DropdownMenuItem>
                          <DropdownMenuItem onSelect={() => void openEditDialog(doc)}>
                            <FileUp aria-hidden="true" />
                            Modifier le texte
                          </DropdownMenuItem>
                          <DropdownMenuSub>
                            <DropdownMenuSubTrigger>
                              <FolderSymlink aria-hidden="true" />
                              Déplacer vers…
                            </DropdownMenuSubTrigger>
                            <DropdownMenuSubContent className="max-h-64 overflow-y-auto">
                              {folders.map((folder) => (
                                <DropdownMenuItem
                                  key={folder.id}
                                  disabled={doc.folderId === folder.id}
                                  onSelect={() => void handleMoveDoc(doc, folder.id)}
                                >
                                  <span
                                    className="size-2.5 rounded-full border border-black/10"
                                    style={{ backgroundColor: folder.color }}
                                    aria-hidden="true"
                                  />
                                  {folder.name}
                                </DropdownMenuItem>
                              ))}
                              <DropdownMenuSeparator />
                              <DropdownMenuItem
                                disabled={!doc.folderId}
                                onSelect={() => void handleMoveDoc(doc, null)}
                              >
                                Aucun dossier
                              </DropdownMenuItem>
                            </DropdownMenuSubContent>
                          </DropdownMenuSub>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem variant="destructive" onSelect={() => setDocToDelete(doc)}>
                            <Trash2 aria-hidden="true" />
                            Supprimer
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* ----- Dialogs ----- */}

      {/* Rename folder */}
      <Dialog open={Boolean(renamingFolder)} onOpenChange={(open) => !open && setRenamingFolder(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Renommer le dossier</DialogTitle>
            <DialogDescription>Les cours du dossier sont conservés.</DialogDescription>
          </DialogHeader>
          <Input
            value={renamingFolder?.name ?? ""}
            onChange={(e) =>
              setRenamingFolder((prev) => (prev ? { ...prev, name: e.target.value } : prev))
            }
            onKeyDown={(e) => {
              if (e.key === "Enter") void handleRenameFolder();
            }}
            aria-label="Nouveau nom du dossier"
            className="h-11"
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenamingFolder(null)}>
              Annuler
            </Button>
            <Button
              onClick={() => void handleRenameFolder()}
              disabled={savingFolder || !renamingFolder?.name.trim()}
              className="bg-emerald-600 text-white hover:bg-emerald-700"
            >
              {savingFolder && <Loader2 className="size-4 animate-spin" aria-hidden="true" />}
              Enregistrer
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete folder (docs kept) */}
      <AlertDialog
        open={Boolean(folderToDelete)}
        onOpenChange={(open) => !open && setFolderToDelete(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Supprimer le dossier « {folderToDelete?.name} » ?</AlertDialogTitle>
            <AlertDialogDescription>
              Les {folderToDelete?.documentCount ?? 0} cours de ce dossier sont conservés et
              redeviennent « sans dossier ». Seul le dossier est supprimé.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Annuler</AlertDialogCancel>
            <AlertDialogAction
              className="bg-red-600 text-white hover:bg-red-700"
              onClick={() => void handleDeleteFolder()}
            >
              Supprimer le dossier
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Rename document */}
      <Dialog open={Boolean(docToRename)} onOpenChange={(open) => !open && setDocToRename(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Renommer le cours</DialogTitle>
            <DialogDescription>Le titre apparaît dans les listes et la révision.</DialogDescription>
          </DialogHeader>
          <Input
            value={docToRename?.title ?? ""}
            onChange={(e) => setDocToRename((prev) => (prev ? { ...prev, title: e.target.value } : prev))}
            onKeyDown={(e) => {
              if (e.key === "Enter") void handleRenameDoc();
            }}
            aria-label="Nouveau titre du cours"
            className="h-11"
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setDocToRename(null)}>
              Annuler
            </Button>
            <Button
              onClick={() => void handleRenameDoc()}
              disabled={savingRename || !docToRename?.title.trim()}
              className="bg-emerald-600 text-white hover:bg-emerald-700"
            >
              {savingRename && <Loader2 className="size-4 animate-spin" aria-hidden="true" />}
              Enregistrer
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit text content */}
      <Dialog
        open={Boolean(docToEdit)}
        onOpenChange={(open) => !open && !savingText && setDocToEdit(null)}
      >
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Modifier « {docToEdit?.title} »</DialogTitle>
            <DialogDescription>
              Le texte est réindexé après enregistrement — l&apos;assistant répondra avec la nouvelle
              version.
            </DialogDescription>
          </DialogHeader>
          {loadingEditText ? (
            <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              Chargement du texte…
            </div>
          ) : (
            <Textarea
              rows={10}
              value={docToEdit?.text ?? ""}
              onChange={(e) => setDocToEdit((prev) => (prev ? { ...prev, text: e.target.value } : prev))}
              aria-label="Contenu du document"
              className="scroll-thin max-h-[50vh] min-h-48 resize-none font-mono text-xs"
            />
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setDocToEdit(null)} disabled={savingText}>
              Annuler
            </Button>
            <Button
              onClick={() => void handleSaveText()}
              disabled={savingText || loadingEditText}
              className="bg-emerald-600 text-white hover:bg-emerald-700"
            >
              {savingText && <Loader2 className="size-4 animate-spin" aria-hidden="true" />}
              Enregistrer
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete document (existing confirm) */}
      <AlertDialog open={Boolean(docToDelete)} onOpenChange={(open) => !open && setDocToDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Supprimer ce cours ?</AlertDialogTitle>
            <AlertDialogDescription>
              « {docToDelete?.title} » et ses {docToDelete?.chunks ?? 0} segments indexés seront
              définitivement supprimés. L&apos;assistant ne pourra plus y répondre.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Annuler</AlertDialogCancel>
            <AlertDialogAction
              className="bg-red-600 text-white hover:bg-red-700"
              onClick={() => docToDelete && void handleDeleteDoc(docToDelete.id)}
            >
              Supprimer
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* OCR correction / save-as-PDF (scanned documents) */}
      <ReviewDialog
        doc={reviewDoc}
        open={reviewOpen}
        onOpenChange={setReviewOpen}
        onSaved={handleReviewSaved}
      />
    </div>
  );
}
