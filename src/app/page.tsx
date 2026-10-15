"use client";

import { useState } from "react";
import { AppHeader } from "@/components/app-header";
import type { TabId } from "@/components/app-header";
import { AppFooter } from "@/components/app-footer";
import { DashboardSection } from "@/components/dashboard-section";
import { DocumentsSection } from "@/components/documents-section";
import { AssistantSection } from "@/components/assistant-section";
import { SettingsSection } from "@/components/settings-section";

export default function Page() {
  const [tab, setTab] = useState<TabId>("accueil");

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <AppHeader tab={tab} onNavigate={setTab} />
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 md:py-8">
        {tab === "accueil" && <DashboardSection onNavigate={setTab} />}
        {tab === "cours" && <DocumentsSection />}
        {tab === "assistant" && <AssistantSection />}
        {tab === "parametres" && <SettingsSection />}
      </main>
      <AppFooter />
    </div>
  );
}
