"use client";

// 🧠 Mémoire de l'assistant — what the self-learning agents remember about
// the student (weaknesses, strengths, preferences…). Refetches when the
// parent bumps `version` (memory.saved SSE events).

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { ChevronDown, ChevronUp, Loader2, Trash2 } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
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
import { deleteMemory, fetchMemory } from "@/lib/api-client";
import { MEMORY_KIND_LABELS } from "@/lib/types";
import type { AgentMemoryDTO } from "@/lib/types";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

// "Open by default on large screens": subscribe to the lg media query via
// useSyncExternalStore (SSR-safe, no setState-in-effect). A user toggle
// (null -> boolean) takes precedence over the viewport default.
const lgQuery =
  typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia("(min-width: 1024px)")
    : null;

function subscribeLg(onChange: () => void) {
  lgQuery?.addEventListener("change", onChange);
  return () => lgQuery?.removeEventListener("change", onChange);
}

function getLgSnapshot(): boolean {
  return lgQuery?.matches ?? false;
}

function getLgServerSnapshot(): boolean {
  return false;
}

export function MemoryCard({ version = 0 }: { version?: number }) {
  const lgOpen = useSyncExternalStore(subscribeLg, getLgSnapshot, getLgServerSnapshot);
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const open = userOpen ?? lgOpen;
  const setOpen = useCallback((value: boolean) => setUserOpen(value), []);
  const [memories, setMemories] = useState<AgentMemoryDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [clearing, setClearing] = useState(false);

  const load = useCallback(async () => {
    try {
      setMemories(await fetchMemory());
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, version]);

  const removeOne = async (id: string) => {
    setDeletingId(id);
    try {
      await deleteMemory(id);
      setMemories((prev) => prev.filter((m) => m.id !== id));
      toast.success("Souvenir oublié");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Suppression impossible");
    } finally {
      setDeletingId(null);
    }
  };

  const removeAll = async () => {
    setClearing(true);
    try {
      await deleteMemory();
      setMemories([]);
      toast.success("Mémoire de l'assistant effacée");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Suppression impossible");
    } finally {
      setClearing(false);
    }
  };

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <Card className="gap-0 py-0">
        <CardContent className="p-4">
          <CollapsibleTrigger asChild>
            <Button variant="ghost" className="h-10 w-full justify-between px-2">
              <span className="font-medium">
                🧠 Mémoire de l&apos;assistant
                <span className="ml-1.5 text-xs text-muted-foreground">({memories.length})</span>
              </span>
              {open ? (
                <ChevronUp className="size-4" aria-hidden="true" />
              ) : (
                <ChevronDown className="size-4" aria-hidden="true" />
              )}
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            {loading ? (
              <div className="flex items-center gap-2 px-2 py-4 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                Chargement de la mémoire…
              </div>
            ) : memories.length === 0 ? (
              <p className="px-2 pb-2 pt-3 text-sm text-muted-foreground">
                L&apos;assistant n&apos;a encore rien appris — révise un cours et il
                s&apos;adaptera à toi.
              </p>
            ) : (
              <div className="scroll-thin mt-2 max-h-72 space-y-2 overflow-y-auto pr-1">
                {memories.map((m) => {
                  const meta = MEMORY_KIND_LABELS[m.kind];
                  return (
                    <div key={m.id} className="flex items-start justify-between gap-2 rounded-lg border p-2.5">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <Badge variant="outline" className={cn("text-[10px]", meta.color)}>
                            {meta.icon} {meta.label}
                          </Badge>
                          <span className="text-[10px] tabular-nums text-muted-foreground">
                            ×{m.weight.toFixed(1)}
                          </span>
                          {m.documentTitle ? (
                            <span className="truncate text-[10px] text-muted-foreground">
                              · {m.documentTitle}
                            </span>
                          ) : null}
                        </div>
                        <p className="mt-1 text-sm">{m.content}</p>
                      </div>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-8 shrink-0 text-red-500 hover:bg-red-50 hover:text-red-600"
                        onClick={() => void removeOne(m.id)}
                        disabled={deletingId === m.id}
                        aria-label="Oublier ce souvenir"
                      >
                        {deletingId === m.id ? (
                          <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                        ) : (
                          <Trash2 className="size-4" aria-hidden="true" />
                        )}
                      </Button>
                    </div>
                  );
                })}
              </div>
            )}

            {memories.length > 0 && (
              <div className="mt-3 border-t pt-3">
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button variant="outline" className="h-9 w-full text-xs" disabled={clearing}>
                      {clearing ? (
                        <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                      ) : (
                        <Trash2 className="size-3.5" aria-hidden="true" />
                      )}
                      Tout effacer
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Effacer toute la mémoire ?</AlertDialogTitle>
                      <AlertDialogDescription>
                        L&apos;assistant oubliera tout ce qu&apos;il a appris sur toi (points
                        faibles, préférences, style…). Il repartira de zéro à la prochaine révision.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Annuler</AlertDialogCancel>
                      <AlertDialogAction
                        className="bg-red-600 text-white hover:bg-red-700"
                        onClick={() => void removeAll()}
                      >
                        Tout effacer
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </div>
            )}
          </CollapsibleContent>
        </CardContent>
      </Card>
    </Collapsible>
  );
}
