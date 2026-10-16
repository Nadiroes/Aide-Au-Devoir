"use client";

// useTtsPlayer — sequential audio reader for documents / questions.
// Splits text into sentence segments client-side (same principle as the
// ingestion chunker: split on sentence punctuation, fallback slices <= 850
// chars, order kept), fetches one audio blob per segment from POST /api/tts
// (lazily, so voice/speed changes apply to the NEXT segments) and plays them
// back with a single Audio element.

import { useCallback, useEffect, useRef, useState } from "react";
import type { DocLanguage, TtsRequestBody } from "@/lib/types";

export type TtsStatus = "idle" | "loading" | "playing" | "paused";

export interface TtsPlayOptions {
  voice?: string;
  speed?: number;
  language?: DocLanguage;
}

const MAX_SEGMENT = 850;

function splitSegments(text: string): string[] {
  const clean = text.replace(/\r?\n+/g, " ").replace(/\s+/g, " ").trim();
  if (!clean) return [];
  const sentences = clean.split(/(?<=[.!?…])\s+/).filter((s) => s.trim().length > 0);
  const segments: string[] = [];
  for (const sentence of sentences) {
    if (sentence.length <= MAX_SEGMENT) {
      segments.push(sentence);
      continue;
    }
    // Fallback: slice long "sentences" into <= 850-char pieces (word-aware).
    let remaining = sentence;
    while (remaining.length > MAX_SEGMENT) {
      let cut = remaining.lastIndexOf(" ", MAX_SEGMENT);
      if (cut < MAX_SEGMENT / 2) cut = MAX_SEGMENT; // no space found — hard cut
      segments.push(remaining.slice(0, cut).trim());
      remaining = remaining.slice(cut).trim();
    }
    if (remaining.length > 0) segments.push(remaining);
  }
  return segments;
}

export function useTtsPlayer() {
  const [status, setStatus] = useState<TtsStatus>("idle");
  const [currentIndex, setCurrentIndex] = useState(0);
  const [total, setTotal] = useState(0);
  const [currentText, setCurrentText] = useState("");
  const [error, setError] = useState<string | null>(null);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const sentencesRef = useRef<string[]>([]);
  const urlsRef = useRef<string[]>([]);
  const optionsRef = useRef<TtsPlayOptions>({});
  /** Generation token — bumped on stop/play so stale continuations bail out. */
  const tokenRef = useRef(0);
  const mountedRef = useRef(true);

  const ensureAudio = useCallback(() => {
    if (!audioRef.current) {
      const audio = new Audio();
      audio.preload = "auto";
      audioRef.current = audio;
    }
    return audioRef.current;
  }, []);

  const stop = useCallback(() => {
    tokenRef.current += 1;
    const audio = audioRef.current;
    if (audio) {
      audio.pause();
      audio.removeAttribute("src");
    }
    for (const url of urlsRef.current) URL.revokeObjectURL(url);
    urlsRef.current = [];
    sentencesRef.current = [];
    setStatus("idle");
    setCurrentIndex(0);
    setTotal(0);
    setCurrentText("");
  }, []);

  const playSegment = useCallback(
    async (index: number) => {
      const token = tokenRef.current;
      const sentences = sentencesRef.current;
      if (index >= sentences.length) {
        // Reached the end cleanly.
        if (token !== tokenRef.current) return;
        const audio = audioRef.current;
        if (audio) audio.removeAttribute("src");
        for (const url of urlsRef.current) URL.revokeObjectURL(url);
        urlsRef.current = [];
        setStatus("idle");
        setCurrentIndex(0);
        setCurrentText("");
        return;
      }

      setCurrentIndex(index);
      setCurrentText(sentences[index]);
      setStatus("loading");

      const body: TtsRequestBody = {
        text: sentences[index],
        voice: optionsRef.current.voice,
        speed: optionsRef.current.speed,
        language: optionsRef.current.language,
      };

      let url: string;
      try {
        const res = await fetch("/api/tts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          let message = `Erreur ${res.status}`;
          if (res.headers.get("content-type")?.includes("application/json")) {
            const data = (await res.json().catch(() => null)) as { message?: string; error?: string } | null;
            message = data?.message ?? data?.error ?? message;
          }
          throw new Error(message);
        }
        const blob = await res.blob();
        if (token !== tokenRef.current) return; // stopped while fetching
        url = URL.createObjectURL(blob);
        urlsRef.current.push(url);
      } catch (err) {
        if (token !== tokenRef.current || !mountedRef.current) return;
        setError(err instanceof Error ? err.message : "Synthèse vocale indisponible");
        setStatus("idle");
        return;
      }

      const audio = ensureAudio();
      audio.onended = () => {
        if (token !== tokenRef.current) return;
        void playSegment(index + 1);
      };
      audio.onerror = () => {
        if (token !== tokenRef.current || !mountedRef.current) return;
        setError("Lecture audio impossible");
        setStatus("idle");
      };
      audio.src = url;
      try {
        await audio.play();
        if (token !== tokenRef.current || !mountedRef.current) return;
        setError(null);
        setStatus("playing");
      } catch (err) {
        // pause()/stop() interrupts play() with an AbortError — not a failure.
        if (err instanceof DOMException && err.name === "AbortError") return;
        if (token !== tokenRef.current || !mountedRef.current) return;
        setError("Lecture audio impossible");
        setStatus("idle");
      }
    },
    [ensureAudio]
  );

  const play = useCallback(
    (text: string, opts?: TtsPlayOptions) => {
      optionsRef.current = { ...optionsRef.current, ...opts };
      const segments = splitSegments(text);
      if (segments.length === 0) {
        setError("Aucun texte à lire");
        setStatus("idle");
        return;
      }
      // Reset any ongoing playback, then queue the new segments.
      tokenRef.current += 1;
      const audio = audioRef.current;
      if (audio) audio.pause();
      for (const oldUrl of urlsRef.current) URL.revokeObjectURL(oldUrl);
      urlsRef.current = [];
      setError(null);
      sentencesRef.current = segments;
      setTotal(segments.length);
      void playSegment(0);
    },
    [playSegment]
  );

  const pause = useCallback(() => {
    if (status === "playing" || status === "loading") {
      audioRef.current?.pause();
      setStatus("paused");
    }
  }, [status]);

  const resume = useCallback(() => {
    const audio = audioRef.current;
    if (status !== "paused" || !audio) return;
    void audio
      .play()
      .then(() => setStatus("playing"))
      .catch(() => setStatus("paused"));
  }, [status]);

  const toggle = useCallback(() => {
    if (status === "playing" || status === "loading") pause();
    else if (status === "paused") resume();
  }, [status, pause, resume]);

  /** Update voice/speed/language for the NEXT segments (lazy queue). */
  const setOptions = useCallback((opts: Partial<TtsPlayOptions>) => {
    optionsRef.current = { ...optionsRef.current, ...opts };
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      tokenRef.current += 1;
      const audio = audioRef.current;
      if (audio) {
        audio.pause();
        audio.removeAttribute("src");
      }
      for (const url of urlsRef.current) URL.revokeObjectURL(url);
      urlsRef.current = [];
    };
  }, []);

  return {
    status,
    currentIndex,
    total,
    currentText,
    error,
    play,
    pause,
    resume,
    stop,
    toggle,
    setOptions,
  };
}
