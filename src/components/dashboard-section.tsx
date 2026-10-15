"use client";

import { useEffect, useState } from "react";
import {
  BookOpen,
  KeyRound,
  Layers,
  MessageSquare,
  Send,
  Upload,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { fetchChatHistory, fetchStats } from "@/lib/api-client";
import type { ChatMessageDTO, StatsDTO } from "@/lib/types";
import type { TabId } from "@/components/app-header";

const STEPS = [
  {
    title: "1. Importez vos cours",
    text: "PDF, DOCX, images OCR — glissez vos documents, ils sont extraits automatiquement.",
  },
  {
    title: "2. Les agents lisent et indexent",
    text: "Lecteur, Découpeur et Indexeur préparent vos cours pour une recherche précise.",
  },
  {
    title: "3. Posez vos questions",
    text: "Des réponses qui citent vos cours, plus une fiche élève pour réviser.",
  },
];

function StatCard({
  icon: Icon,
  label,
  value,
  loading,
}: {
  icon: typeof BookOpen;
  label: string;
  value: number | null;
  loading: boolean;
}) {
  return (
    <Card className="gap-0 py-0">
      <CardContent className="p-4 md:p-5">
        <div className="flex items-center gap-2 text-muted-foreground">
          <span className="flex size-8 items-center justify-center rounded-lg bg-emerald-100 text-emerald-700">
            <Icon className="size-4" aria-hidden="true" />
          </span>
          <p className="text-xs font-medium uppercase tracking-wide">{label}</p>
        </div>
        {loading ? (
          <Skeleton className="mt-3 h-9 w-16" />
        ) : (
          <p className="mt-2 text-3xl font-bold tabular-nums">{value ?? 0}</p>
        )}
      </CardContent>
    </Card>
  );
}

export function DashboardSection({
  onNavigate,
}: {
  onNavigate: (tab: TabId) => void;
}) {
  const [stats, setStats] = useState<StatsDTO | null>(null);
  const [history, setHistory] = useState<ChatMessageDTO[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const [s, h] = await Promise.all([fetchStats(), fetchChatHistory()]);
        if (!active) return;
        setStats(s);
        setHistory(h);
      } catch (err) {
        console.error(err);
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  const recent = history.slice(-3).reverse();

  return (
    <div className="space-y-6">
      {/* Hero */}
      <div>
        <h1 className="text-2xl font-bold md:text-3xl">Bonjour 👋 Prêt à réviser ?</h1>
        <p className="mt-1 text-sm text-muted-foreground md:text-base">
          Importez vos cours, puis posez vos questions : les agents s&apos;occupent du reste.
        </p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard icon={BookOpen} label="Cours importés" value={stats?.documents ?? null} loading={loading} />
        <StatCard icon={Layers} label="Segments indexés" value={stats?.chunks ?? null} loading={loading} />
        <StatCard icon={MessageSquare} label="Questions posées" value={stats?.questions ?? null} loading={loading} />
        <StatCard icon={KeyRound} label="Clés configurées" value={stats?.keysConfigured ?? null} loading={loading} />
      </div>

      {/* Quick actions */}
      <div className="grid gap-3 sm:grid-cols-3">
        <Button
          onClick={() => onNavigate("cours")}
          className="h-11 bg-emerald-600 text-white hover:bg-emerald-700"
        >
          <Upload className="size-4" aria-hidden="true" />
          Importer un cours
        </Button>
        <Button
          onClick={() => onNavigate("assistant")}
          className="h-11 bg-emerald-600 text-white hover:bg-emerald-700"
        >
          <Send className="size-4" aria-hidden="true" />
          Poser une question
        </Button>
        <Button
          onClick={() => onNavigate("parametres")}
          variant="outline"
          className="h-11"
        >
          <KeyRound className="size-4" aria-hidden="true" />
          Configurer les clés
        </Button>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* How it works */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Comment ça marche</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {STEPS.map((step) => (
              <div key={step.title} className="flex gap-3">
                <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-emerald-100 text-xs font-bold text-emerald-700">
                  {step.title.charAt(0)}
                </span>
                <div className="min-w-0">
                  <p className="text-sm font-medium">{step.title}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">{step.text}</p>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>

        {/* Recent questions */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Dernières questions</CardTitle>
          </CardHeader>
          <CardContent>
            {loading ? (
              <div className="space-y-3">
                <Skeleton className="h-14 w-full" />
                <Skeleton className="h-14 w-full" />
              </div>
            ) : recent.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                Aucune question pour l&apos;instant — essayez l&apos;assistant !
              </p>
            ) : (
              <div className="scroll-thin max-h-56 space-y-3 overflow-y-auto pr-1">
                {recent.map((msg) => (
                  <div key={msg.id} className="rounded-lg border p-3">
                    <p className="line-clamp-2 text-sm font-medium">{msg.question}</p>
                    <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{msg.answer}</p>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
