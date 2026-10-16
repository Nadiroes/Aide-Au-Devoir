// GET /api/keys — provider list with configuration status (no secret ever returned).

import { db } from "@/lib/db";
import { listProviders } from "@/lib/llm";
import type { ProviderStatusDTO } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const rows = await db.apiKey.findMany();
  const byProvider = new Map(rows.map((r) => [r.provider, r]));

  const providers: ProviderStatusDTO[] = listProviders().map((p) => {
    const row = byProvider.get(p.id);
    return {
      id: p.id,
      label: p.label,
      description: p.description,
      builtIn: p.builtIn,
      configured: p.builtIn ? true : Boolean(row),
      masked: row?.masked ?? null,
      verifiedAt: row?.verifiedAt?.toISOString() ?? null,
      serverReady: p.serverReady,
      serverNote: p.serverNote,
    };
  });

  return Response.json({ providers });
}
