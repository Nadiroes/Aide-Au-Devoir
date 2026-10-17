"use client";

import { BookOpen, BookOpenCheck, ClipboardCheck, GraduationCap, Home, MessageSquare, Settings } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export type TabId = "accueil" | "cours" | "revision" | "examens" | "assistant" | "parametres";

const NAV_ITEMS: { id: TabId; label: string; icon: typeof Home }[] = [
  { id: "accueil", label: "Accueil", icon: Home },
  { id: "cours", label: "Cours", icon: BookOpen },
  { id: "revision", label: "Révision", icon: BookOpenCheck },
  { id: "examens", label: "Examens", icon: ClipboardCheck },
  { id: "assistant", label: "Assistant", icon: MessageSquare },
  { id: "parametres", label: "Paramètres", icon: Settings },
];

export function AppHeader({
  tab,
  onNavigate,
}: {
  tab: TabId;
  onNavigate: (tab: TabId) => void;
}) {
  return (
    <header className="sticky top-0 z-40 border-b bg-background">
      <div className="mx-auto flex h-16 w-full max-w-6xl items-center justify-between gap-3 px-4">
        <button
          type="button"
          onClick={() => onNavigate("accueil")}
          aria-label="Aller à l'accueil"
          className="flex min-w-0 shrink-0 items-center gap-2.5 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span className="flex size-9 items-center justify-center rounded-lg bg-emerald-600 text-white">
            <GraduationCap className="size-5" aria-hidden="true" />
          </span>
          <span className="truncate text-base font-bold md:text-lg">Aide au Devoir</span>
        </button>

        <nav aria-label="Navigation principale" className="flex min-w-0 items-center gap-1 overflow-x-auto">
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            const active = tab === item.id;
            return (
              <Button
                key={item.id}
                variant="ghost"
                size="sm"
                onClick={() => onNavigate(item.id)}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "h-10 shrink-0 gap-1.5 px-3",
                  active
                    ? "bg-emerald-600 text-white hover:bg-emerald-700 hover:text-white"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground"
                )}
              >
                <Icon className="size-4" aria-hidden="true" />
                <span className="hidden sm:inline">{item.label}</span>
              </Button>
            );
          })}
        </nav>
      </div>
    </header>
  );
}
