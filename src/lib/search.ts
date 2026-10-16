// BM25 lexical search over document chunks (French-aware tokenization).
// Chunks live in SQLite; an in-memory index is rebuilt lazily and invalidated
// explicitly when documents change.

import { db } from "@/lib/db";
import type { RetrievalHit } from "@/lib/types";

const FRENCH_STOPWORDS = new Set(
  `alors au aucuns aussi autre avant avec avoir bon car ce cela ces ceux chaque ci comme comment dans des du dedans dehors depuis deux devrait doit donc dos droite début elle elles en encore essai est et eu fait faites fois font force haut hors ici il ils je juste la le les leur là ma maintenant mais mes mien moins mon mot même ni nommés notre nous nouveaux ou où par parce parole pas personnes peut peu pièce plupart pour pourquoi quand que quel quelle quelles quels qui sa sans ses seulement si sien son sont sous soyez sujet sur ta tandis tellement tels tes ton tous tout trop très tu valeur voie voient vont votre vous vu ça étaient état étions été être un une des ce cette ces ainsi alors lors notre vos leurs d un d une l on n est s il y a qu il n y a c est d après il s agit plus moins très bien page pages chapitre chap cours leçon exemple ex`.split(
    /\s+/
  )
);

function normalizeToken(word: string): string {
  return word
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // strip accents
    .toLowerCase();
}

function tokenize(text: string): string[] {
  return normalizeToken(text)
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !FRENCH_STOPWORDS.has(t))
    .map((t) => (t.length > 4 && t.endsWith("s") ? t.slice(0, -1) : t)); // naive plural stem
}

interface IndexedChunk {
  id: string;
  documentId: string;
  idx: number;
  content: string;
  title: string;
  subject: string;
  tf: Map<string, number>;
  length: number;
}

interface SearchIndex {
  chunks: IndexedChunk[];
  df: Map<string, number>;
  avgLen: number;
  totalChunks: number;
}

const K1 = 1.4;
const B = 0.72;

let cached: { index: SearchIndex; builtAt: number } | null = null;

export function invalidateSearchCache() {
  cached = null;
}

async function buildIndex(): Promise<SearchIndex> {
  const rows = await db.chunk.findMany({
    select: {
      id: true,
      documentId: true,
      idx: true,
      content: true,
      document: { select: { title: true, subject: true } },
    },
    orderBy: [{ documentId: "asc" }, { idx: "asc" }],
  });

  const chunks: IndexedChunk[] = rows.map((r) => {
    const tokens = tokenize(r.content);
    const tf = new Map<string, number>();
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    return {
      id: r.id,
      documentId: r.documentId,
      idx: r.idx,
      content: r.content,
      title: r.document.title,
      subject: r.document.subject,
      tf,
      length: tokens.length,
    };
  });

  const df = new Map<string, number>();
  for (const c of chunks) {
    for (const term of c.tf.keys()) df.set(term, (df.get(term) ?? 0) + 1);
  }
  const totalLen = chunks.reduce((s, c) => s + c.length, 0);
  return {
    chunks,
    df,
    avgLen: chunks.length ? totalLen / chunks.length : 0,
    totalChunks: chunks.length,
  };
}

async function getIndex(): Promise<SearchIndex> {
  if (!cached || Date.now() - cached.builtAt > 5 * 60_000) {
    cached = { index: await buildIndex(), builtAt: Date.now() };
  }
  return cached.index;
}

function tokenizeQuery(query: string): string[] {
  const seen = new Map<string, number>();
  for (const t of tokenize(query)) seen.set(t, (seen.get(t) ?? 0) + 1);
  return [...seen.keys()];
}

/** BM25 search. Returns top-k hits above a minimal score. */
export async function searchChunks(query: string, k = 6): Promise<RetrievalHit[]> {
  const index = await getIndex();
  if (!index.chunks.length) return [];

  const terms = tokenizeQuery(query);
  if (!terms.length) return [];

  const N = index.chunks.length;
  const scores: { chunk: IndexedChunk; score: number }[] = [];

  for (const chunk of index.chunks) {
    let score = 0;
    for (const term of terms) {
      const f = chunk.tf.get(term);
      if (!f) continue;
      const df = index.df.get(term) ?? 1;
      const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
      const denom = f + K1 * (1 - B + B * (chunk.length / (index.avgLen || 1)));
      score += idf * ((f * (K1 + 1)) / denom);
    }
    if (score > 0) scores.push({ chunk, score });
  }

  scores.sort((a, b) => b.score - a.score);

  return scores.slice(0, k).map(({ chunk, score }) => ({
    documentId: chunk.documentId,
    title: chunk.title,
    subject: chunk.subject,
    idx: chunk.idx,
    score: Math.round(score * 1000) / 1000,
    preview:
      chunk.content.length > 220 ? `${chunk.content.slice(0, 220)}…` : chunk.content,
  }));
}

/** Fetch full chunk contents for the given hits (previews are truncated). */
export async function fetchFullContents(hits: RetrievalHit[]): Promise<Map<string, string>> {
  if (!hits.length) return new Map();
  const documentIds = [...new Set(hits.map((h) => h.documentId))];
  const rows = await db.chunk.findMany({
    where: { documentId: { in: documentIds } },
    select: { documentId: true, idx: true, content: true },
  });
  const map = new Map<string, string>();
  for (const r of rows) map.set(`${r.documentId}:${r.idx}`, r.content);
  return map;
}

/** Build the solver context block from hits + full contents. */
export function buildContext(hits: RetrievalHit[], fullContent: Map<string, string>): string {
  return hits
    .map((h, i) => {
      const full = fullContent.get(`${h.documentId}:${h.idx}`) ?? h.preview;
      return `[Extrait ${i + 1} — « ${h.title} » (${h.subject})]\n${full.slice(0, 2400)}`;
    })
    .join("\n\n---\n\n");
}
