"use client";

// useRecorder — voice dictation via MediaRecorder + POST /api/asr.
// start() captures the microphone, stop() transcribes the blob through the
// backend ASR route and hands the text to onResult. cancel() drops the
// recording without transcribing. 60 s max, tracks always cleaned up.

import { useCallback, useEffect, useRef, useState } from "react";

const MAX_DURATION_MS = 60_000;

export function useRecorder(onResult: (text: string) => void) {
  const [recording, setRecording] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<number | null>(null);
  const cancelledRef = useRef(false);
  const onResultRef = useRef(onResult);

  useEffect(() => {
    onResultRef.current = onResult;
  }, [onResult]);

  const releaseStream = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    recorderRef.current = null;
    chunksRef.current = [];
  }, []);

  const transcribe = useCallback(async (blob: Blob) => {
    setLoading(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.append("audio", blob, "reponse.webm");
      const res = await fetch("/api/asr", { method: "POST", body: fd });
      if (!res.ok) {
        let message = `Erreur ${res.status}`;
        if (res.headers.get("content-type")?.includes("application/json")) {
          const data = (await res.json().catch(() => null)) as { message?: string; error?: string } | null;
          message = data?.message ?? data?.error ?? message;
        }
        throw new Error(message);
      }
      const data = (await res.json()) as { text?: string };
      const text = (data.text ?? "").trim();
      if (text.length > 0) onResultRef.current(text);
      else setError("La transcription est vide — réessaie.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Dictée vocale indisponible");
    } finally {
      setLoading(false);
    }
  }, []);

  const start = useCallback(async () => {
    if (recording || loading) return;
    setError(null);
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      setError("Micro indisponible — autorise l'accès au microphone.");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      cancelledRef.current = false;
      chunksRef.current = [];

      const mimeType = MediaRecorder.isTypeSupported("audio/webm") ? "audio/webm" : undefined;
      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      recorderRef.current = recorder;
      recorder.ondataavailable = (event: BlobEvent) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };
      recorder.onstop = () => {
        const type = recorder.mimeType || "audio/webm";
        const blob = new Blob(chunksRef.current, { type });
        releaseStream();
        setRecording(false);
        if (cancelledRef.current) return;
        if (blob.size > 0) void transcribe(blob);
      };
      recorder.start();
      setRecording(true);
      // Hard stop after 60 s.
      timerRef.current = window.setTimeout(() => {
        if (recorderRef.current && recorderRef.current.state === "recording") {
          recorderRef.current.stop();
        }
      }, MAX_DURATION_MS);
    } catch (err) {
      releaseStream();
      setRecording(false);
      const name = err instanceof DOMException ? err.name : "";
      if (name === "NotAllowedError" || name === "SecurityError" || name === "NotFoundError") {
        setError("Micro indisponible — autorise l'accès au microphone.");
      } else {
        setError("Impossible de démarrer l'enregistrement.");
      }
    }
  }, [recording, loading, releaseStream, transcribe]);

  const stop = useCallback(() => {
    const recorder = recorderRef.current;
    if (recorder && recorder.state === "recording") recorder.stop();
    else releaseStream();
  }, [releaseStream]);

  const cancel = useCallback(() => {
    cancelledRef.current = true;
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== "inactive") {
      recorder.onstop = null; // don't transcribe
      try {
        recorder.stop();
      } catch {
        // already stopped
      }
    }
    releaseStream();
    setRecording(false);
    setLoading(false);
  }, [releaseStream]);

  // Cleanup on unmount — never leave the microphone open.
  useEffect(() => {
    return () => {
      cancelledRef.current = true;
      const recorder = recorderRef.current;
      if (recorder && recorder.state !== "inactive") {
        recorder.onstop = null;
        try {
          recorder.stop();
        } catch {
          // ignore
        }
      }
      streamRef.current?.getTracks().forEach((track) => track.stop());
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    };
  }, []);

  return { recording, loading, error, start, stop, cancel };
}
