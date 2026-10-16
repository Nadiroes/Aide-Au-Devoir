"use client";

// ReviewDialog — OCR correction window for scanned / photographed documents.
// The raw extracted text is loaded on open (it is not part of DocumentDTO),
// edited by the user, then either converted into a clean PDF
// ("Enregistrer en PDF" — kind becomes "pdf", status "prêt") or saved as
// plain text ("Enregistrer sans PDF"). In both cases the agents read the
// corrected text before the save completes, so revision can start right after.

import { useEffect, useState } from "react";
import { AlertTriangle, FileText, Loader2, Save } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { fetchDocumentDetail, savePdf, updateDocument } from "@/lib/api-client";
import type { DocumentDTO, DocumentDetailDTO } from "@/lib/types";
import { toast } from "sonner";

export interface ReviewDialogProps {
  /** Document being corrected (scanned document, status "à vérifier"). */
  doc: DocumentDTO | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called after a successful save (PDF or plain text) with the updated document. */
  onSaved: (doc: DocumentDetailDTO, asPdf: boolean) => void;
}

export function ReviewDialog({ doc, open, onOpenChange, onSaved }: ReviewDialogProps) {
  const [text, setText] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [savingPdf, setSavingPdf] = useState(false);
  const [savingText, setSavingText] = useState(false);

  const busy = savingPdf || savingText;

  // Load the extracted OCR text each time the dialog opens for a document.
  useEffect(() => {
    if (!open || !doc) return;
    let cancelled = false;
    setLoading(true);
    setText(null);
    void (async () => {
      try {
        const detail = await fetchDocumentDetail(doc.id);
        if (!cancelled) setText(detail.textContent);
      } catch (err) {
        if (!cancelled) {
          toast.error(err instanceof Error ? err.message : "Impossible de charger le texte extrait");
          onOpenChange(false);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, doc, onOpenChange]);

  const handleSavePdf = async () => {
    if (!doc || busy || text === null) return;
    setSavingPdf(true);
    try {
      const updated = await savePdf(doc.id, text);
      toast.success("Document converti en PDF — les agents l'ont lu, la révision peut commencer !");
      onOpenChange(false);
      onSaved(updated, true);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Conversion en PDF impossible");
    } finally {
      setSavingPdf(false);
    }
  };

  const handleSaveText = async () => {
    if (!doc || busy || text === null) return;
    setSavingText(true);
    try {
      const updated = await updateDocument(doc.id, { textContent: text });
      toast.success("Texte corrigé enregistré — les agents l'ont lu, la révision peut commencer !");
      onOpenChange(false);
      onSaved(updated, false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Enregistrement impossible");
    } finally {
      setSavingText(false);
    }
  };

  return (
    <Dialog
      open={open && Boolean(doc)}
      onOpenChange={(next) => {
        if (!next && busy) return; // no accidental close while saving
        onOpenChange(next);
      }}
    >
      <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>✍️ Vérifie le texte extrait</DialogTitle>
          <DialogDescription>
            « {doc?.title ?? "Document"} » — relis ce que la lecture automatique a extrait de ta
            photo / ton scan.
          </DialogDescription>
        </DialogHeader>

        <Alert className="border-amber-200 bg-amber-50 text-amber-900">
          <AlertTriangle className="size-4 text-amber-600" />
          <AlertTitle className="text-amber-900">Lecture par OCR</AlertTitle>
          <AlertDescription className="text-amber-800">
            Ce document a été lu par OCR (photo/scan). Des mots ont pu être mal reconnus — corrige le
            texte ci-dessous, puis enregistre : le document sera converti en PDF propre et les
            agents le liront pour lancer la révision.
          </AlertDescription>
        </Alert>

        {loading ? (
          <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            Chargement du texte extrait…
          </div>
        ) : (
          <Textarea
            rows={14}
            value={text ?? ""}
            onChange={(e) => setText(e.target.value)}
            aria-label="Texte extrait à corriger"
            className="scroll-thin max-h-[50vh] min-h-56 resize-y text-sm"
          />
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            Plus tard
          </Button>
          <Button
            variant="outline"
            onClick={() => void handleSaveText()}
            disabled={busy || loading || text === null}
          >
            {savingText ? (
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            ) : (
              <Save className="size-4" aria-hidden="true" />
            )}
            Enregistrer sans PDF
          </Button>
          <Button
            onClick={() => void handleSavePdf()}
            disabled={busy || loading || text === null}
            className="min-h-11 bg-emerald-600 text-white hover:bg-emerald-700"
          >
            {savingPdf ? (
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            ) : (
              <FileText className="size-4" aria-hidden="true" />
            )}
            Enregistrer en PDF
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
