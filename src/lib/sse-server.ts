// Server-side SSE helper: wraps an async handler into a text/event-stream Response.
// Every event is serialized as `data: {json}\n\n` (client parses the `type` field).

import type { ChatEvent, IngestEvent } from "@/lib/types";

export type SseEmit = (event: ChatEvent | IngestEvent | { type: string } & Record<string, unknown>) => void;

export function sseResponse(
  handler: (emit: SseEmit, signal: AbortSignal) => Promise<void>,
  signal: AbortSignal
): Response {
  const encoder = new TextEncoder();
  let closed = false;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit: SseEmit = (event) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        } catch {
          // stream already closed
        }
      };
      try {
        await handler(emit, signal);
      } catch (err) {
        emit({
          type: "pipeline.error",
          message: err instanceof Error ? err.message : "Erreur interne du serveur",
        });
      } finally {
        closed = true;
        try {
          controller.close();
        } catch {
          // already closed
        }
      }
    },
    cancel() {
      closed = true;
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
