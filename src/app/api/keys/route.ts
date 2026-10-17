// GET /api/keys — provider list with configuration status (no secret ever
// returned) + the non-secret Agnes server configuration for the Paramètres form.

import { db } from "@/lib/db";
import { getAgnesConfig, listProviders } from "@/lib/llm";
import type { AgnesConfig, ProviderStatusDTO } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const [rows, agnesConfig] = await Promise.all([
    db.apiKey.findMany(),
    getAgnesConfig(),
  ]);
  const byProvider = new Map(rows.map((r) => [r.provider, r]));

  const providers: ProviderStatusDTO[] = listProviders().map((p) => {
    const row = byProvider.get(p.id);
    // Agnes readiness is dynamic: it depends on the configured server URL.
    const serverReady = p.id === "agnes" ? Boolean(agnesConfig.baseUrl) : p.serverReady;
    return {
      id: p.id,
      label: p.label,
      description: p.description,
      builtIn: p.builtIn,
      configured: p.builtIn ? true : Boolean(row),
      masked: row?.masked ?? null,
      verifiedAt: row?.verifiedAt?.toISOString() ?? null,
      serverReady,
      serverNote: serverReady
        ? p.serverNote
        : p.id === "agnes"
          ? "Renseignez l'URL du serveur Agnes ci-dessous, puis la clé API."
          : p.serverNote,
    };
  });

  return Response.json({ providers, agnesConfig: agnesConfig as AgnesConfig });
}
