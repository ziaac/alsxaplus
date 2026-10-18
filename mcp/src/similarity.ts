// Small, exact text helpers. No model is involved: these decide how close two sentences are.

/** Lower case, letters and digits and apostrophes only, single spaces. */
export function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9' ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function words(text: string): string[] {
  const n = normalize(text);
  return n ? n.split(" ") : [];
}

function bigrams(s: string): Map<string, number> {
  const out = new Map<string, number>();
  const flat = s.replace(/ /g, "");
  if (flat.length === 1) out.set(flat, 1);
  for (let i = 0; i < flat.length - 1; i++) {
    const g = flat.slice(i, i + 2);
    out.set(g, (out.get(g) ?? 0) + 1);
  }
  return out;
}

/** Dice coefficient on letter pairs: 1 for the same letters in the same order, 0 for nothing shared. */
export function dice(a: string, b: string): number {
  const x = bigrams(normalize(a));
  const y = bigrams(normalize(b));
  let sizeX = 0;
  let sizeY = 0;
  let shared = 0;
  for (const n of x.values()) sizeX += n;
  for (const n of y.values()) sizeY += n;
  if (sizeX === 0 || sizeY === 0) return 0;
  for (const [g, n] of x) shared += Math.min(n, y.get(g) ?? 0);
  return (2 * shared) / (sizeX + sizeY);
}

export function jaccard(a: string[], b: string[]): number {
  const x = new Set(a);
  const y = new Set(b);
  if (x.size === 0 || y.size === 0) return 0;
  let shared = 0;
  for (const w of x) if (y.has(w)) shared++;
  return shared / (x.size + y.size - shared);
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min((prev[j] ?? 0) + 1, (row[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + cost);
    }
    prev = row;
  }
  return prev[b.length] ?? 0;
}

/** Edits needed to turn one sentence into the other, as a share of the longer one. 0 is the same, 1 is nothing alike. */
export function editRatio(a: string, b: string): number {
  const x = normalize(a);
  const y = normalize(b);
  return levenshtein(x, y) / Math.max(x.length, y.length, 1);
}

/** Consonants only, repeats squeezed: speech that loses or bends vowels still keeps most of its consonants. */
export function skeleton(text: string): string {
  return normalize(text).replace(/[aeiouy]+/g, "").replace(/(.)\1+/g, "$1");
}

/** 0 to 1: how much two sentences look and sound alike on paper. */
export function similarity(a: string, b: string): number {
  return 0.4 * dice(a, b) + 0.4 * dice(skeleton(a), skeleton(b)) + 0.2 * jaccard(words(a), words(b));
}
