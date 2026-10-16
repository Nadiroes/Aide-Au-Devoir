// POST /api/qa/clear — bulk-clear the Q&A ledger of a document.
// body: { documentId, mode: "shown"|"hidden"|"all", alsoDelete?: boolean }
//  - shown:  hide every visible entry (they stay "remembered" by the course)
//  - hidden: permanently delete every already-hidden entry
//  - all:    delete everything if alsoDelete, else hide everything
// Returns { count }.

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as {
    documentId?: string;
    mode?: string;
    alsoDelete?: boolean;
  } | null;

  const documentId = String(body?.documentId ?? "").trim();
  const mode = String(body?.mode ?? "");
  if (!documentId) {
    return NextResponse.json({ message: "Paramètre documentId requis." }, { status: 400 });
  }
  if (!["shown", "hidden", "all"].includes(mode)) {
    return NextResponse.json(
      { message: "Mode invalide (shown, hidden ou all attendu)." },
      { status: 400 }
    );
  }

  let count = 0;

  if (mode === "shown") {
    const res = await db.revisionQA.updateMany({
      where: { documentId, hidden: false },
      data: { hidden: true },
    });
    count = res.count;
  } else if (mode === "hidden") {
    const res = await db.revisionQA.deleteMany({ where: { documentId, hidden: true } });
    count = res.count;
  } else {
    // mode === "all"
    if (body?.alsoDelete) {
      const res = await db.revisionQA.deleteMany({ where: { documentId } });
      count = res.count;
    } else {
      const res = await db.revisionQA.updateMany({
        where: { documentId, hidden: false },
        data: { hidden: true },
      });
      count = res.count;
    }
  }

  return NextResponse.json({ count });
}
