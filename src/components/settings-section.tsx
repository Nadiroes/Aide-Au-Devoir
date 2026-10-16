"use client";

import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Eye,
  EyeOff,
  FlaskConical,
  KeyRound,
  Loader2,
  Save,
  ShieldCheck,
  Trash2,
  Volume2,
  XCircle,
} from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
import { deleteApiKey, fetchProviders, saveApiKey, testApiKey, ttsToBlob } from "@/lib/api-client";
import { TTS_VOICES } from "@/lib/types";
import type { ProviderStatusDTO } from "@/lib/types";
import { toast } from "sonner";

// ---------- TTS preferences (persisted locally, shared with the revision tab) ----------

export interface TtsPrefs {
  voice?: string;
  speed?: number;
  autoread: boolean;
}

const LS_VOICE = "ad_tts_voice";
const LS_SPEED = "ad_tts_speed";
const LS_AUTOREAD = "ad_tts_autoread";

/** Reads the persisted audio preferences (client-side only). */
export function getTtsPrefs(): TtsPrefs {
  if (typeof window === "undefined") return { autoread: false };
  let voice: string | undefined;
  let speed: number | undefined;
  let autoread = false;
  try {
    const v = window.localStorage.getItem(LS_VOICE);
    if (v && v !== "auto") voice = v;
    const s = window.localStorage.getItem(LS_SPEED);
    if (s) {
      const n = Number(s);
      if (Number.isFinite(n) && n > 0) speed = n;
    }
    autoread = window.localStorage.getItem(LS_AUTOREAD) === "1";
  } catch {
    // localStorage unavailable (private mode) — use defaults.
  }
  return { voice, speed, autoread };
}

const TTS_SPEED_OPTIONS = ["0.75", "1", "1.25", "1.5"];

function AudioSettingsCard() {
  const [voice, setVoice] = useState("auto");
  const [speed, setSpeed] = useState("1");
  const [autoread, setAutoread] = useState(false);
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    const prefs = getTtsPrefs();
    setVoice(prefs.voice ?? "auto");
    setSpeed(prefs.speed ? String(prefs.speed) : "1");
    setAutoread(prefs.autoread);
  }, []);

  const applyVoice = (value: string) => {
    setVoice(value);
    try {
      window.localStorage.setItem(LS_VOICE, value);
    } catch {
      // ignore
    }
  };

  const applySpeed = (value: string) => {
    setSpeed(value);
    try {
      window.localStorage.setItem(LS_SPEED, value);
    } catch {
      // ignore
    }
  };

  const applyAutoread = (value: boolean) => {
    setAutoread(value);
    try {
      window.localStorage.setItem(LS_AUTOREAD, value ? "1" : "0");
    } catch {
      // ignore
    }
  };

  const runTest = async () => {
    if (testing) return;
    setTesting(true);
    let url: string | null = null;
    try {
      const blob = await ttsToBlob({
        text: "Bonjour ! Voici la voix choisie pour tes révisions. Bon courage !",
        voice: voice === "auto" ? undefined : voice,
        speed: Number(speed),
      });
      url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audio.onended = () => {
        if (url) URL.revokeObjectURL(url);
      };
      await audio.play();
      toast.success("Lecture de l'échantillon voix");
    } catch (err) {
      if (url) URL.revokeObjectURL(url);
      toast.error(err instanceof Error ? err.message : "Synthèse vocale indisponible");
    } finally {
      setTesting(false);
    }
  };

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">🔊 Audio &amp; Voix</CardTitle>
        <CardDescription>
          Choisis la voix et la vitesse de lecture des cours et des questions du coach.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="tts-voice">Voix</Label>
            <Select value={voice} onValueChange={applyVoice}>
              <SelectTrigger id="tts-voice" className="h-11 w-full" aria-label="Choisir la voix de synthèse">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">Automatique (selon la langue)</SelectItem>
                {TTS_VOICES.map((v) => (
                  <SelectItem key={v.id} value={v.id}>
                    {v.label} — {v.description}
                    {v.bestFor !== "both" ? ` (${v.bestFor.toUpperCase()})` : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              {voice === "auto"
                ? "FR → Tongtong · EN → Jam"
                : TTS_VOICES.find((v) => v.id === voice)?.bestFor === "en"
                  ? "Particulièrement adaptée à l'anglais"
                  : TTS_VOICES.find((v) => v.id === voice)?.bestFor === "fr"
                    ? "Particulièrement adaptée au français"
                    : "Adaptée à toutes les langues"}
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="tts-speed">Vitesse de lecture</Label>
            <Select value={speed} onValueChange={applySpeed}>
              <SelectTrigger id="tts-speed" className="h-11 w-full" aria-label="Choisir la vitesse de lecture">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TTS_SPEED_OPTIONS.map((s) => (
                  <SelectItem key={s} value={s}>
                    {s}×
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="flex items-center justify-between gap-4 rounded-lg border p-3">
          <div className="min-w-0">
            <Label htmlFor="tts-autoread" className="text-sm">
              Lire automatiquement les questions du coach
            </Label>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Chaque nouvelle question sera lue à voix haute pendant la révision.
            </p>
          </div>
          <Switch
            id="tts-autoread"
            checked={autoread}
            onCheckedChange={applyAutoread}
            aria-label="Lire automatiquement les questions du coach"
          />
        </div>

        <Button variant="outline" className="h-11 gap-2" onClick={() => void runTest()} disabled={testing}>
          {testing ? (
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          ) : (
            <Volume2 className="size-4" aria-hidden="true" />
          )}
          {testing ? "Test en cours…" : "Tester la voix"}
        </Button>
      </CardContent>
    </Card>
  );
}

const SECURITY_POINTS = [
  "Chiffrement AES-256-GCM côté serveur — la clé n'est jamais stockée en clair.",
  "La clé n'est jamais renvoyée en clair : seule une version masquée (sk-…abcd) est affichée.",
  "Vérification en direct auprès du fournisseur avant enregistrement.",
  "Le bouton « Tester » ne sauvegarde rien : il valide la clé sans la conserver.",
];

function ProviderCard({
  provider,
  onChanged,
}: {
  provider: ProviderStatusDTO;
  onChanged: () => void;
}) {
  const isZai = provider.id === "zai";
  const [key, setKey] = useState("");
  const [show, setShow] = useState(false);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  const busy = testing || saving;
  const serverBlocked = provider.serverReady === false;
  const disabled = busy || serverBlocked || key.trim().length === 0;

  const runTest = async () => {
    if (disabled) return;
    setTesting(true);
    setResult(null);
    try {
      const res = await testApiKey(provider.id, key.trim());
      setResult({ ok: res.ok, message: res.message });
      if (res.ok) toast.success(res.message);
      else toast.error(res.message);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Erreur réseau pendant le test";
      setResult({ ok: false, message: msg });
      toast.error(msg);
    } finally {
      setTesting(false);
    }
  };

  const runSave = async () => {
    if (disabled) return;
    setSaving(true);
    setResult(null);
    try {
      const res = await saveApiKey(provider.id, key.trim());
      setResult({ ok: res.ok, message: res.message });
      if (res.ok) {
        toast.success(res.message);
        setKey("");
        onChanged();
      } else {
        toast.error(res.message);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Erreur pendant l'enregistrement";
      setResult({ ok: false, message: msg });
      toast.error(msg);
    } finally {
      setSaving(false);
    }
  };

  const runDelete = async () => {
    setDeleting(true);
    try {
      const message = await deleteApiKey(provider.id);
      toast.success(message);
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Suppression impossible");
    } finally {
      setDeleting(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-base">{provider.label}</CardTitle>
          <Badge
            variant={provider.builtIn ? "secondary" : provider.configured ? "outline" : "outline"}
            className={
              provider.builtIn
                ? undefined
                : provider.configured
                  ? "border-transparent bg-emerald-100 text-emerald-800"
                  : undefined
            }
          >
            {provider.builtIn ? "Inclus" : provider.configured ? "Configurée" : "Non configurée"}
          </Badge>
        </div>
        <CardDescription>{provider.description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {serverBlocked && (
          <Alert className="border-amber-200 bg-amber-50 text-amber-900">
            <AlertTriangle className="size-4 text-amber-600" />
            <AlertTitle>Serveur non disponible</AlertTitle>
            <AlertDescription>
              {provider.serverNote ?? "Ce fournisseur n'est pas prêt pour le moment."}
            </AlertDescription>
          </Alert>
        )}

        {isZai ? (
          <p className="text-sm text-muted-foreground">
            Aucune clé nécessaire — ce fournisseur fonctionne immédiatement.
          </p>
        ) : (
          <>
            <div className="space-y-2">
              <Label htmlFor={`key-${provider.id}`}>Clé API</Label>
              <div className="relative">
                <KeyRound
                  className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
                  aria-hidden="true"
                />
                <Input
                  id={`key-${provider.id}`}
                  type={show ? "text" : "password"}
                  value={key}
                  onChange={(e) => setKey(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void runTest();
                    }
                  }}
                  placeholder="sk-..."
                  disabled={serverBlocked}
                  autoComplete="off"
                  spellCheck={false}
                  className="h-11 pl-9 pr-11 font-mono"
                />
                <button
                  type="button"
                  onClick={() => setShow((s) => !s)}
                  aria-label={show ? "Masquer la clé" : "Afficher la clé"}
                  className="absolute right-1.5 top-1/2 flex size-8 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground hover:bg-muted"
                >
                  {show ? (
                    <EyeOff className="size-4" aria-hidden="true" />
                  ) : (
                    <Eye className="size-4" aria-hidden="true" />
                  )}
                </button>
              </div>
            </div>

            {result && (
              <Alert
                className={
                  result.ok
                    ? "border-emerald-200 bg-emerald-50 text-emerald-900"
                    : "border-red-200 bg-red-50 text-red-900"
                }
              >
                {result.ok ? (
                  <CheckCircle2 className="size-4 text-emerald-600" />
                ) : (
                  <XCircle className="size-4 text-red-500" />
                )}
                <AlertDescription>{result.message}</AlertDescription>
              </Alert>
            )}

            <div className="flex flex-col gap-2 sm:flex-row">
              <Button
                variant="outline"
                className="h-11 flex-1"
                onClick={() => void runTest()}
                disabled={disabled}
              >
                {testing ? (
                  <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                ) : (
                  <FlaskConical className="size-4" aria-hidden="true" />
                )}
                {testing ? "Test en cours…" : "Tester"}
              </Button>
              <Button
                className="h-11 flex-1 bg-emerald-600 text-white hover:bg-emerald-700"
                onClick={() => void runSave()}
                disabled={disabled}
              >
                {saving ? (
                  <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                ) : (
                  <Save className="size-4" aria-hidden="true" />
                )}
                {saving ? "Vérification…" : "Vérifier & enregistrer"}
              </Button>
            </div>

            {provider.configured && provider.masked && (
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-muted/40 p-3">
                <div className="min-w-0">
                  <p className="truncate font-mono text-xs text-muted-foreground">{provider.masked}</p>
                  {provider.verifiedAt && (
                    <p className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
                      <Clock className="size-3 shrink-0" aria-hidden="true" />
                      Vérifiée le {new Date(provider.verifiedAt).toLocaleString("fr-FR")}
                    </p>
                  )}
                </div>
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-10 shrink-0 text-red-500 hover:bg-red-50 hover:text-red-600"
                      disabled={deleting}
                      aria-label={`Supprimer la clé ${provider.label}`}
                    >
                      {deleting ? (
                        <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                      ) : (
                        <Trash2 className="size-4" aria-hidden="true" />
                      )}
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Supprimer la clé {provider.label} ?</AlertDialogTitle>
                      <AlertDialogDescription>
                        L&apos;application oubliera la clé localement. Pensez aussi à la révoquer dans la
                        console du fournisseur.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Annuler</AlertDialogCancel>
                      <AlertDialogAction
                        className="bg-red-600 text-white hover:bg-red-700"
                        onClick={() => void runDelete()}
                      >
                        Supprimer
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

export function SettingsSection() {
  const [providers, setProviders] = useState<ProviderStatusDTO[]>([]);
  const [loading, setLoading] = useState(true);

  const loadProviders = useCallback(async () => {
    try {
      setProviders(await fetchProviders());
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Impossible de charger les fournisseurs");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadProviders();
  }, [loadProviders]);

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold md:text-3xl">Paramètres</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Gérez les clés API des fournisseurs de modèles. Z.ai fonctionne sans configuration.
        </p>
      </div>

      {loading ? (
        <Card className="gap-0 py-0">
          <CardContent className="flex items-center gap-3 p-6 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            Chargement des fournisseurs…
          </CardContent>
        </Card>
      ) : (
        providers.map((p) => <ProviderCard key={p.id} provider={p} onChanged={() => void loadProviders()} />)
      )}

      <AudioSettingsCard />

      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center gap-2">
            <ShieldCheck className="size-5 text-emerald-600" aria-hidden="true" />
            <CardTitle className="text-base">🔒 Sécurité</CardTitle>
          </div>
        </CardHeader>
        <CardContent>
          <ul className="list-disc space-y-1.5 pl-5 text-sm text-muted-foreground">
            {SECURITY_POINTS.map((point) => (
              <li key={point}>{point}</li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
