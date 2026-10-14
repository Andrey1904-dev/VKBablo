import { all } from "./db.ts";

function normalize(text: string): string[] {
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

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

export function similarity(a: string, b: string): number {
  return jaccard(shingles(normalize(a)), shingles(normalize(b)));
}

export function findSimilar(
  communityId: string,
  text: string,
  excludeId?: string,
): { id: string; score: number; topic: string } | null {
  const rows = all<{ id: string; text: string; topic: string }>(
    "SELECT id, text, topic FROM posts WHERE community_id = ? AND status NOT IN ('rejected')",
    communityId,
  );
  let best: { id: string; score: number; topic: string } | null = null;
  for (const row of rows) {
    if (excludeId && row.id === excludeId) continue;
    const score = similarity(text, row.text);
    if (!best || score > best.score) best = { id: row.id, score, topic: row.topic };
  }
  return best && best.score >= 0.28 ? best : null;
}
