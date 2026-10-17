"use client";

import { useCallback, useEffect, useState } from "react";
import { AppHeader } from "@/components/app-header";
import type { TabId } from "@/components/app-header";
import { AppFooter } from "@/components/app-footer";
import { DashboardSection } from "@/components/dashboard-section";
import { DocumentsSection } from "@/components/documents-section";
import { RevisionSection } from "@/components/revision-section";
import { ExamsSection } from "@/components/exams-section";
import { AssistantSection } from "@/components/assistant-section";
import { SettingsSection } from "@/components/settings-section";
import { fetchDocuments } from "@/lib/api-client";
import type { DocumentDTO } from "@/lib/types";
import { toast } from "sonner";

export default function Page() {
  const [tab, setTab] = useState<TabId>("accueil");

  // Shared document list (Cours + Révision stay in sync).
  const [documents, setDocuments] = useState<DocumentDTO[]>([]);
  const [documentsLoading, setDocumentsLoading] = useState(true);

  // Revision workspace state.
  const [selectedDocumentId, setSelectedDocumentId] = useState<string | null>(null);
  const [greetDocumentId, setGreetDocumentId] = useState<string | null>(null);
  const [memoryVersion, setMemoryVersion] = useState(0);

  const loadDocuments = useCallback(async () => {
    try {
      setDocuments(await fetchDocuments());
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Impossible de charger les cours");
    } finally {
      setDocumentsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadDocuments();
  }, [loadDocuments]);

  // Post-import redirect: select the new doc, arm the greeting, open Révision.
  const handleImported = useCallback((doc: DocumentDTO) => {
    setSelectedDocumentId(doc.id);
    setGreetDocumentId(doc.id);
    setTab("revision");
  }, []);

  const handleRevise = useCallback((documentId: string) => {
    setSelectedDocumentId(documentId);
    setTab("revision");
  }, []);

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <AppHeader tab={tab} onNavigate={setTab} />
      <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 md:py-8">
        {tab === "accueil" && <DashboardSection onNavigate={setTab} />}
        {tab === "cours" && (
          <DocumentsSection
            documents={documents}
            loading={documentsLoading}
            onDocumentsChanged={() => void loadDocuments()}
            onRevise={handleRevise}
            onImported={handleImported}
          />
        )}
        {tab === "revision" && (
          <RevisionSection
            documents={documents}
            onDocumentsChanged={() => void loadDocuments()}
            selectedDocumentId={selectedDocumentId}
            onSelectDocument={setSelectedDocumentId}
            greetDocumentId={greetDocumentId}
            onGreetConsumed={() => setGreetDocumentId(null)}
            onOpenCourses={() => setTab("cours")}
            onMemoryChanged={() => setMemoryVersion((v) => v + 1)}
          />
        )}
        {tab === "examens" && (
          <ExamsSection
            documents={documents}
            onOpenCourses={() => setTab("cours")}
          />
        )}
        {tab === "assistant" && <AssistantSection memoryVersion={memoryVersion} />}
        {tab === "parametres" && <SettingsSection />}
      </main>
      <AppFooter />
    </div>
  );
}
