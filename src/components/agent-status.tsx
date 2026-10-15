"use client";

import { AlertCircle, CheckCircle2, Circle, Loader2 } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { AgentStatus } from "@/lib/types";

export interface AgentDisplay {
  id: string;
  label: string;
  status: AgentStatus;
  logs: string[];
  summary?: string;
  content?: string;
}

const STATUS_TEXT: Record<AgentStatus, string> = {
  idle: "en attente",
  running: "en cours…",
  done: "prêt",
  error: "erreur",
};

const BADGE_CLASS: Record<AgentStatus, string> = {
  idle: "border-transparent bg-muted text-muted-foreground",
  running: "border-transparent bg-amber-100 text-amber-800",
  done: "border-transparent bg-emerald-100 text-emerald-800",
  error: "border-transparent bg-red-100 text-red-800",
};

/** Per-agent accent (amber / teal / emerald / rose — no blue/indigo). */
const CHIP_CLASS: Record<string, string> = {
  planner: "bg-amber-100 text-amber-700",
  retriever: "bg-teal-100 text-teal-700",
  solver: "bg-emerald-100 text-emerald-700",
  tutor: "bg-rose-100 text-rose-700",
  reader: "bg-amber-100 text-amber-700",
  chunker: "bg-teal-100 text-teal-700",
  indexer: "bg-emerald-100 text-emerald-700",
};

export function AgentStatusList({ agents }: { agents: AgentDisplay[] }) {
  return (
    <div className="space-y-3" role="list" aria-label="Agents">
      {agents.map((agent) => {
        const running = agent.status === "running";
        const done = agent.status === "done";
        const error = agent.status === "error";
        const Icon = error ? AlertCircle : done ? CheckCircle2 : running ? Loader2 : Circle;
        return (
          <Card key={agent.id} role="listitem" className={cn("gap-0 py-0", error && "border-red-200", done && "border-emerald-200")}>
            <CardContent className="flex gap-3 p-3">
              <span
                aria-hidden="true"
                className={cn(
                  "mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg",
                  CHIP_CLASS[agent.id] ?? "bg-muted text-muted-foreground"
                )}
              >
                <Icon
                  className={cn(
                    "size-4",
                    running && "animate-spin",
                    done && "text-emerald-600",
                    error && "text-red-500"
                  )}
                />
              </span>

              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-2">
                  <p className="truncate text-sm font-medium">{agent.label}</p>
                  <Badge variant="outline" className={cn("shrink-0 text-[10px]", BADGE_CLASS[agent.status])}>
                    {STATUS_TEXT[agent.status]}
                  </Badge>
                </div>

                {(done || error) && agent.summary ? (
                  <p className="mt-1 text-xs text-muted-foreground">{agent.summary}</p>
                ) : null}

                {agent.logs.length > 0 && (
                  <div className="mt-1.5 space-y-0.5">
                    {agent.logs.slice(-3).map((log, i) => (
                      <p key={`${agent.id}-log-${i}`} className="truncate text-xs text-muted-foreground">
                        · {log}
                      </p>
                    ))}
                  </div>
                )}

                {done && agent.content ? (
                  <pre className="scroll-thin mt-2 max-h-40 overflow-y-auto whitespace-pre-wrap rounded-md bg-muted/60 p-2 font-sans text-xs leading-relaxed text-muted-foreground">
                    {agent.content}
                  </pre>
                ) : null}
              </div>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
