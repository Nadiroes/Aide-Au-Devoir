// Self-learning agent memory (AgentMemory) — persistent profile of the student.
// Memory failures must NEVER break the revision pipeline: every helper is
// defensive (try/catch + graceful fallbacks).

import { db } from "@/lib/db";
import type { MemoryKind } from "@/lib/types";
import type { AgentMemory } from "@prisma/client";

const MEMORY_KINDS: MemoryKind[] = ["weakness", "strength", "preference", "style", "context"];

/** Row (optionally with the document relation) → AgentMemoryDTO. */
export function memoryToDTO(
  row: AgentMemory & { document?: { title: string } | null }
): import("@/lib/types").AgentMemoryDTO {
  return {
    id: row.id,
    kind: (MEMORY_KINDS.includes(row.kind as MemoryKind) ? row.kind : "context") as MemoryKind,
    content: row.content,
    weight: row.weight,
    hits: row.hits,
    documentId: row.documentId,
    documentTitle: row.document?.title ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Scope shared by all per-document memory queries (global + doc-specific rows). */
function memoryScope(documentId?: string | null) {
  return documentId ? { OR: [{ documentId: null }, { documentId }] } : undefined;
}

/** Top memory lines formatted for LLM system prompts. "" when empty. */
export async function buildMemoryContext(documentId?: string | null): Promise<string> {
  try {
    const rows = await db.agentMemory.findMany({
      where: memoryScope(documentId),
      orderBy: [{ weight: "desc" }, { updatedAt: "desc" }],
      take: 12,
    });
    if (!rows.length) return "";
    return rows.map((r) => `- [${r.kind}] ${r.content} (weight ${r.weight})`).join("\n");
  } catch {
    return "";
  }
}

export type MemoryOp =
  | { op: "add"; kind: MemoryKind; content: string }
  | { op: "reinforce"; id: string }
  | { op: "weaken"; id: string };

/**
 * Applies learner-agent operations. Returns the number of rows touched.
 * "add" dedupes: identical content (case-insensitive) reinforces the existing
 * row instead of creating a duplicate.
 */
export async function applyMemoryOps(ops: MemoryOp[], documentId: string | null): Promise<number> {
  let touched = 0;
  try {
    for (const op of ops) {
      try {
        if (op.op === "add") {
          const content = String(op.content ?? "").trim().slice(0, 400);
          if (!content) continue;
          const kind: MemoryKind = MEMORY_KINDS.includes(op.kind) ? op.kind : "context";

          // Case-insensitive dedupe (SQLite/Prisma has no mode:"insensitive").
          const existing = await db.agentMemory.findMany({
            select: { id: true, content: true, weight: true },
            take: 500,
          });
          const dup = existing.find((r) => r.content.trim().toLowerCase() === content.toLowerCase());

          if (dup) {
            await db.agentMemory.update({
              where: { id: dup.id },
              data: { weight: Math.min(5, dup.weight + 0.5), hits: { increment: 1 } },
            });
          } else {
            await db.agentMemory.create({
              data: { kind, content, documentId, weight: 1, hits: 0 },
            });
          }
          touched += 1;
        } else if (op.op === "reinforce") {
          const row = await db.agentMemory.findUnique({ where: { id: op.id } });
          if (row) {
            await db.agentMemory.update({
              where: { id: row.id },
              data: { weight: Math.min(5, row.weight + 0.5), hits: { increment: 1 } },
            });
            touched += 1;
          }
        } else if (op.op === "weaken") {
          const row = await db.agentMemory.findUnique({ where: { id: op.id } });
          if (row) {
            await db.agentMemory.update({
              where: { id: row.id },
              data: { weight: Math.max(0.2, row.weight - 0.3) },
            });
            touched += 1;
          }
        }
      } catch {
        // One bad operation must not block the others.
      }
    }
  } catch {
    // Memory must never break the pipeline.
  }
  return touched;
}
