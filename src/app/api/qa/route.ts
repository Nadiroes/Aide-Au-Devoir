// Q&A ledger API — GET /api/qa?documentId=...&filter=...&sort=...&limit=...
// Returns stored revision Q&A entries for a document.

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { qaToDTO } from "@/lib/revision";
import type { QAFilter, QASort, RevisionQADTO, RevisionVerdict, QARating } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const FILTERS: QAFilter[] = ["all", "visible", "hidden", "arevoir", "moyen", "connu"];
const SORTS: QASort[] = ["recent", "oldest", "verdict", "rating"];
const VERDICT_ORDER: RevisionVerdict[] = ["wrong", "partly", "correct", "info"];
const RATING_ORDER: (QARating | null)[] = ["arevoir", "moyen", "connu", null];

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const documentId = searchParams.get("documentId")?.trim() ?? "";
  if (!documentId) {
    return NextResponse.json({ message: "Paramètre documentId requis." }, { status: 400 });
  }

  const filter = (FILTERS.includes(searchParams.get("filter") as QAFilter)
    ? searchParams.get("filter")
    : "all") as QAFilter;
  const sort = (SORTS.includes(searchParams.get("sort") as QASort)
    ? searchParams.get("sort")
    : "recent") as QASort;
  const limitRaw = Number(searchParams.get("limit") ?? 200);
  const limit = Number.isFinite(limitRaw) ? Math.min(500, Math.max(1, Math.trunc(limitRaw))) : 200;

  const where: Record<string, unknown> = { documentId };
  if (filter === "visible") where.hidden = false;
  else if (filter === "hidden") where.hidden = true;
  else if (filter === "arevoir") where.rating = "arevoir";
  else if (filter === "moyen") where.rating = "moyen";
  else if (filter === "connu") where.rating = "connu";

  // Fetch a bounded set, then sort in JS for verdict/rating orders.
  const rows = await db.revisionQA.findMany({
    where: where as { documentId: string },
    orderBy: { createdAt: "desc" },
    take: 1000,
  });

  let dtos: RevisionQADTO[] = rows.map(qaToDTO);

  if (sort === "oldest") {
    dtos.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  } else if (sort === "verdict") {
    dtos.sort((a, b) => {
      const d = VERDICT_ORDER.indexOf(a.verdict) - VERDICT_ORDER.indexOf(b.verdict);
      return d !== 0 ? d : b.createdAt.localeCompare(a.createdAt);
    });
  } else if (sort === "rating") {
    dtos.sort((a, b) => {
      const d = RATING_ORDER.indexOf(a.rating ?? null) - RATING_ORDER.indexOf(b.rating ?? null);
      return d !== 0 ? d : b.createdAt.localeCompare(a.createdAt);
    });
  }
  // sort === "recent": already createdAt desc from the query.

  return NextResponse.json({ qas: dtos.slice(0, limit) });
}
