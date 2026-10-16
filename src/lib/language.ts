// Language detection (fr / en) for imported courses — heuristic scoring.
// French markers: accented characters (weighted x2) + common French words.
// English markers: occurrences of common English words.
// Ties or empty text → "fr" (the app's primary language).

const FRENCH_WORDS = [
  "le", "la", "les", "des", "une", "un", "est", "sont", "dans", "avec",
  "pour", "qui", "que", "mais", "très", "plus", "où", "être", "avoir",
];

const ENGLISH_WORDS = [
  "the", "and", "of", "to", "is", "are", "with", "for", "that", "this",
  "from", "not", "it",
];

const ACCENT_RE = /[éèêëàâçùûôîœ]/g;
const TOKEN_SPLIT_RE = /[^a-zà-ÿ0-9]+/;

function countTokens(tokens: string[], words: string[]): number {
  let score = 0;
  for (const w of words) {
    for (const t of tokens) if (t === w) score += 1;
  }
  return score;
}

export function detectLanguage(text: string): "fr" | "en" {
  const sample = text.slice(0, 4000).toLowerCase();
  if (!sample.trim()) return "fr";

  const accents = (sample.match(ACCENT_RE) ?? []).length;
  const tokens = sample.split(TOKEN_SPLIT_RE).filter(Boolean);

  const frScore = accents * 2 + countTokens(tokens, FRENCH_WORDS);
  const enScore = countTokens(tokens, ENGLISH_WORDS);

  return enScore > frScore ? "en" : "fr";
}

export function languageLabel(l: "fr" | "en"): string {
  return l === "en" ? "Anglais (EN)" : "Français (FR)";
}
