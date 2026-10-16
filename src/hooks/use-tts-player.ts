"use client";

// useTtsPlayer — sequential audio reader for documents / questions.
//
// Two engines:
// 1. "system"  — the browser/OS built-in speech voices (Web Speech API).
//                Native French accent (Amélie, Hortense, Google français…),
//                which the server voices lack. Preferred for French text.
// 2. "serveur" — POST /api/tts segments (Z.ai voices, anglophone accent).
//
// "auto" resolves to the system engine when a matching French/English system
// voice exists, and falls back to the server engine otherwise (or when the
// system voice is missing mid-play).
//
// Both paths share the same sentence-segment queue so voice/speed changes
// apply to the NEXT segments and progress tracking stays identical.

import { useCallback, useEffect, useRef, useState } from "react";
import type { DocLanguage, TtsEngine, TtsRequestBody } from "@/lib/types";

export type TtsStatus = "idle" | "loading" | "playing" | "paused";

export interface TtsPlayOptions {
  voice?: string; // server voice id (serveur engine)
  speed?: number; // 0.5..2
  language?: DocLanguage;
  engine?: TtsEngine; // default "auto"
}

export type TtsEngineUsed = "system" | "serveur";

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

// ---------- System voices (Web Speech API) ----------

function speechSupported(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window;
}

/** getVoices() is initially empty on Chrome — wait briefly for voiceschanged. */
async function waitForVoices(timeoutMs = 1500): Promise<SpeechSynthesisVoice[]> {
  if (!speechSupported()) return [];
  const synth = window.speechSynthesis;
  let voices = synth.getVoices();
  if (voices.length) return voices;
  return new Promise((resolve) => {
    const timer = window.setTimeout(() => resolve(synth.getVoices()), timeoutMs);
    synth.addEventListener?.(
      "voiceschanged",
      () => {
        window.clearTimeout(timer);
        resolve(synth.getVoices());
      },
      { once: true }
    );
  });
}

const QUALITY_HINTS = [/google/i, /natural|neural|premium|enhanced/i, /amelie|amélie|hortense|thomas|audrey|marie|denise|henri/i];

/** Ranks system voices: known high-quality French/English voices first. */
function rankVoice(v: SpeechSynthesisVoice): number {
  let score = v.localService ? 1 : 0;
  QUALITY_HINTS.forEach((re, i) => {
    if (re.test(v.name)) score += QUALITY_HINTS.length - i;
  });
  return score;
}

/** Best system voice for the language, or null when the device has none. */
async function pickSystemVoice(
  lang: DocLanguage
): Promise<{ voice: SpeechSynthesisVoice; label: string } | null> {
  const voices = await waitForVoices();
  const target = lang === "en" ? "en" : "fr";
  const matching = voices.filter((v) => (v.lang ?? "").toLowerCase().startsWith(target));
  if (!matching.length) return null;
  matching.sort((a, b) => rankVoice(b) - rankVoice(a));
  return { voice: matching[0], label: matching[0].name };
}

export function useTtsPlayer() {
  const [status, setStatus] = useState<TtsStatus>("idle");
  const [currentIndex, setCurrentIndex] = useState(0);
  const [total, setTotal] = useState(0);
  const [currentText, setCurrentText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [engineUsed, setEngineUsed] = useState<TtsEngineUsed | null>(null);
  const [voiceLabel, setVoiceLabel] = useState<string | null>(null);

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
    if (speechSupported()) window.speechSynthesis.cancel();
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

  /** Shared end-of-queue reset. */
  const finishRef = useRef<() => void>(() => {});
  finishRef.current = () => {
    const audio = audioRef.current;
    if (audio) audio.removeAttribute("src");
    for (const url of urlsRef.current) URL.revokeObjectURL(url);
    urlsRef.current = [];
    setStatus("idle");
    setCurrentIndex(0);
    setCurrentText("");
  };

  // ---------- System engine ----------

  const playSegmentSystem = useCallback(
    (index: number, voice: SpeechSynthesisVoice, lang: DocLanguage) => {
      const token = tokenRef.current;
      const sentences = sentencesRef.current;
      if (index >= sentences.length) {
        if (token !== tokenRef.current || !mountedRef.current) return;
        finishRef.current();
        return;
      }
      setCurrentIndex(index);
      setCurrentText(sentences[index]);

      const utter = new SpeechSynthesisUtterance(sentences[index]);
      utter.voice = voice;
      utter.lang = voice.lang || (lang === "en" ? "en-GB" : "fr-FR");
      const speed = optionsRef.current.speed ?? 1;
      utter.rate = Number.isFinite(speed) ? Math.min(2, Math.max(0.5, speed)) : 1;
      utter.onend = () => {
        if (token !== tokenRef.current) return;
        playSegmentSystem(index + 1, voice, lang);
      };
      utter.onerror = (ev) => {
        if (token !== tokenRef.current) return;
        // "interrupted"/"canceled" = we stopped ourselves — not an error.
        if (ev.error === "interrupted" || ev.error === "canceled") return;
        setError("Lecture système impossible — basculez sur la voix serveur dans Paramètres.");
        setStatus("idle");
      };
      if (mountedRef.current && speechSupported()) {
        window.speechSynthesis.speak(utter);
      }
    },
    []
  );

  /**
   * Tries to play with the system engine. Returns false when the device has
   * no usable system voice for the language (caller falls back to server).
   */
  const playSystem = useCallback(
    async (text: string, opts: TtsPlayOptions): Promise<boolean> => {
      if (!speechSupported()) return false;
      const lang: DocLanguage = opts.language === "en" ? "en" : "fr";
      const picked = await pickSystemVoice(lang);
      if (!picked) return false;
      const segments = splitSegments(text);
      if (!segments.length) return false;
      sentencesRef.current = segments;
      setTotal(segments.length);
      setError(null);
      setEngineUsed("system");
      setVoiceLabel(picked.label);
      setStatus("playing");
      playSegmentSystem(0, picked.voice, lang);
      return true;
    },
    [playSegmentSystem]
  );

  // ---------- Server engine ----------

  const playSegment = useCallback(
    async (index: number) => {
      const token = tokenRef.current;
      const sentences = sentencesRef.current;
      if (index >= sentences.length) {
        // Reached the end cleanly.
        if (token !== tokenRef.current) return;
        finishRef.current();
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

  const playServer = useCallback(
    (text: string, opts: TtsPlayOptions) => {
      const segments = splitSegments(text);
      if (segments.length === 0) {
        setError("Aucun texte à lire");
        setStatus("idle");
        return;
      }
      sentencesRef.current = segments;
      setTotal(segments.length);
      setError(null);
      setEngineUsed("serveur");
      setVoiceLabel(
        opts.voice
          ? opts.voice
          : opts.language === "en"
            ? "Jam (serveur)"
            : "Chuichui (serveur)"
      );
      void playSegment(0);
    },
    [playSegment]
  );

  const play = useCallback(
    (text: string, opts?: TtsPlayOptions) => {
      optionsRef.current = { ...optionsRef.current, ...opts };
      // Reset any ongoing playback, then queue the new segments.
      tokenRef.current += 1;
      const token = tokenRef.current;
      if (speechSupported()) window.speechSynthesis.cancel();
      const audio = audioRef.current;
      if (audio) audio.pause();
      for (const oldUrl of urlsRef.current) URL.revokeObjectURL(oldUrl);
      urlsRef.current = [];
      setStatus("loading");

      const engine = opts?.engine ?? "auto";
      const lang: DocLanguage = opts?.language === "en" ? "en" : "fr";

      const start = async () => {
        if (engine !== "serveur") {
          const ok = await playSystem(text, opts ?? {});
          if (ok) return;
          if (token !== tokenRef.current || !mountedRef.current) return;
          if (engine === "system") {
            // Explicitly requested system engine but no system voice exists.
            setError(
              "Aucune voix française trouvée sur cet appareil — lecture avec la voix serveur."
            );
          }
        }
        if (token !== tokenRef.current || !mountedRef.current) return;
        playServer(text, opts ?? {});
      };
      void start();
    },
    [playSystem, playServer]
  );

  const pause = useCallback(() => {
    if (status === "playing" || status === "loading") {
      if (engineUsed === "system" && speechSupported()) window.speechSynthesis.pause();
      else audioRef.current?.pause();
      setStatus("paused");
    }
  }, [status, engineUsed]);

  const resume = useCallback(() => {
    if (status !== "paused") return;
    if (engineUsed === "system" && speechSupported()) {
      window.speechSynthesis.resume();
      setStatus("playing");
      return;
    }
    const audio = audioRef.current;
    if (!audio) return;
    void audio
      .play()
      .then(() => setStatus("playing"))
      .catch(() => setStatus("paused"));
  }, [status, engineUsed]);

  const toggle = useCallback(() => {
    if (status === "playing" || status === "loading") pause();
    else if (status === "paused") resume();
  }, [status, pause, resume]);

  /** Update voice/speed/language/engine for the NEXT segments (lazy queue). */
  const setOptions = useCallback((opts: Partial<TtsPlayOptions>) => {
    optionsRef.current = { ...optionsRef.current, ...opts };
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      tokenRef.current += 1;
      if (speechSupported()) window.speechSynthesis.cancel();
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
    engineUsed,
    voiceLabel,
    play,
    pause,
    resume,
    stop,
    toggle,
    setOptions,
  };
}
