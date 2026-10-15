// Client-side SSE helper: POST a body, stream `data: {json}\n\n` events.

export type SseBody = Record<string, unknown> | FormData;

/** Returns true when the error comes from an AbortSignal (Stop button). */
export function isAbortError(err: unknown): boolean {
  return (
    (err instanceof DOMException && err.name === "AbortError") ||
    (err instanceof Error && err.name === "AbortError")
  );
}

/**
 * POST to `url` and consume the SSE response, calling `onEvent` for each
 * parsed `data:` payload. Supports FormData (upload) or JSON bodies and an
 * AbortSignal. Throws with the server-provided `message`/`error` field when
 * the response is not ok.
 */
export async function postSse<T>(
  url: string,
  body: SseBody,
  onEvent: (event: T) => void,
  signal?: AbortSignal
): Promise<void> {
  const res = await fetch(url, {
    method: "POST",
    headers: body instanceof FormData ? undefined : { "Content-Type": "application/json" },
    body: body instanceof FormData ? body : JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    const contentType = res.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      const data = (await res.json().catch(() => null)) as { message?: string; error?: string } | null;
      throw new Error(data?.message ?? data?.error ?? `Erreur ${res.status}`);
    }
    throw new Error(`Erreur ${res.status}`);
  }

  const reader = res.body?.getReader();
  if (!reader) throw new Error("Flux de réponse indisponible");

  const decoder = new TextDecoder();
  let buffer = "";

  const flush = (withSentinel: boolean) => {
    if (withSentinel) buffer += "\n\n";
    let idx = buffer.indexOf("\n\n");
    while (idx !== -1) {
      const rawEvent = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      for (const line of rawEvent.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const payload = trimmed.slice(5).trim();
        if (!payload) continue;
        try {
          onEvent(JSON.parse(payload) as T);
        } catch {
          // Ignore malformed lines instead of killing the stream.
        }
      }
      idx = buffer.indexOf("\n\n");
    }
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
    flush(false);
  }
  // Stream ended: process any trailing event that lacks the final "\n\n".
  buffer += decoder.decode();
  flush(true);
}
