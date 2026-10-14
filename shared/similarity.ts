/**
 * Проверка повторов: шинглы + коэффициент Жаккара. Изоморфно, без зависимостей.
 */
export interface SimilarityCandidate {
  id: string;
  text: string;
  topic?: string | null;
}

export function normalizeForSimilarity(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[^a-zа-я0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2);
}

function shingles(words: string[], n = 3): Set<string> {
  const s = new Set<string>();
  if (words.length < n) {
    s.add(words.join(" "));
    return s;
  }
  for (let i = 0; i <= words.length - n; i++) s.add(words.slice(i, i + n).join(" "));
  return s;
}

export function similarity(a: string, b: string): number {
  const x = shingles(normalizeForSimilarity(a));
  const y = shingles(normalizeForSimilarity(b));
  if (!x.size || !y.size) return 0;
  let inter = 0;
  for (const t of x) if (y.has(t)) inter++;
  return inter / (x.size + y.size - inter);
}

export const SIMILARITY_THRESHOLD = 0.28;
export const SIMILARITY_BLOCK_THRESHOLD = 0.7;

export function findSimilar(
  candidates: readonly SimilarityCandidate[],
  text: string,
  excludeId?: string,
): { id: string; score: number; topic: string } | null {
  let best: { id: string; score: number; topic: string } | null = null;
  for (const row of candidates) {
    if (excludeId && row.id === excludeId) continue;
    if (!row.text) continue;
    const score = similarity(text, row.text);
    if (!best || score > best.score) best = { id: row.id, score, topic: row.topic ?? "" };
  }
  return best && best.score >= SIMILARITY_THRESHOLD ? best : null;
}

export function isDuplicateScore(score: number | null | undefined): boolean {
  return typeof score === "number" && score >= SIMILARITY_BLOCK_THRESHOLD;
}
