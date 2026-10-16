// POST /api/keys/save — verify then encrypt + store an API key (upsert).

import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { getProvider } from "@/lib/llm";
import { secretbox } from "@/lib/secretbox";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as { provider?: string; key?: string } | null;
  const provider = body?.provider?.trim();
  const key = body?.key?.trim();

  if (!provider || !key) {
    return Response.json({ ok: false, message: "Fournisseur et clé requis." }, { status: 400 });
  }

  let label = provider;
  let verification: { ok: boolean; message: string };
  try {
    const p = getProvider(provider);
    label = p.label;
    verification = await p.verify(key);
  } catch (err) {
    return Response.json(
      { ok: false, message: err instanceof Error ? err.message : "Fournisseur inconnu." },
      { status: 400 }
    );
  }

  if (!verification.ok) {
    return Response.json({ ok: false, message: verification.message }, { status: 400 });
  }

  const masked = secretbox.mask(key);
  const now = new Date();
  await db.apiKey.upsert({
    where: { provider },
    update: { encrypted: secretbox.encrypt(key), masked, verifiedAt: now },
    create: { provider, encrypted: secretbox.encrypt(key), masked, verifiedAt: now },
  });

  return Response.json({
    ok: true,
    provider,
    masked,
    verifiedAt: now.toISOString(),
    message: `Clé ${label} vérifiée et enregistrée (${masked}).`,
  });
}
