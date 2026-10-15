// DELETE /api/keys/[provider] — forget a stored key (revoke it at the provider too!).

import { NextRequest } from "next/server";
import { db } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ provider: string }> }) {
  const { provider } = await ctx.params;
  try {
    await db.apiKey.delete({ where: { provider } });
    return Response.json({ ok: true, message: `Clé ${provider} supprimée.` });
  } catch {
    return Response.json({ ok: false, error: "Aucune clé enregistrée pour ce fournisseur." }, { status: 404 });
  }
}
