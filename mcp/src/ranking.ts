// Which sentences to offer. The model may propose an order; this file decides what is allowed and what is used.
// Whatever the model says, only an answer that passes `applyModelOutput` is shown. `fallbackRank` needs no model.
import { editRatio, normalize, similarity, words } from "./similarity.js";

/** One recommended sentence and five others. */
export const MAX_OPTIONS = 6;
const MAX_PERSONAL = 40;
// The whole bank is only a few hundred tokens, and the right sentence must never be hidden from the model.
const MAX_SHOWN_TO_MODEL = 120;
const MAX_CORRECTIONS = 2;
const MAX_CORRECTION_CHARS = 120;
const MAX_CORRECTION_WORDS = 14;
/** A correction may differ from what was heard by at most this share of its letters. */
const MAX_CORRECTION_EDIT = 0.5;

export interface Heard {
  text: string;
  confidence: number;
}

export type Origin = "learned" | "personal" | "heard" | "bank" | "correction";

export interface Candidate {
  id: string;
  text: string;
  origin: Origin;
  /** How often the person has confirmed this sentence. */
  uses: number;
  /** How often the person has confirmed this sentence after the recogniser heard something like what it heard now. */
  aliasUses: number;
}

export interface PersonalPhrase {
  text: string;
  uses: number;
}

/** A sound-alike the person has already settled: "wa er" was confirmed as "I need water". */
export interface Alias {
  heard: string;
  text: string;
  uses: number;
}

export class PolicyViolation extends Error {}

function sentence(text: string): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/** Collects everything that could be offered, once each. Earlier sources win when the same sentence appears twice. */
export function buildPool(heard: Heard[], personal: PersonalPhrase[], aliases: Alias[], bank: readonly string[]): Candidate[] {
  const seen = new Set<string>();
  const pool: Candidate[] = [];
  const add = (id: string, text: string, origin: Origin, uses: number, aliasUses: number) => {
    const key = normalize(text);
    if (!key || seen.has(key)) return;
    seen.add(key);
    pool.push({ id, text: sentence(text), origin, uses, aliasUses });
  };
  const aliasUsesFor = (text: string) => aliases.filter((a) => normalize(a.text) === normalize(text)).reduce((n, a) => n + a.uses, 0);

  aliases.forEach((a, i) => add(`l${i + 1}`, a.text, "learned", personal.find((p) => normalize(p.text) === normalize(a.text))?.uses ?? 0, aliasUsesFor(a.text)));
  personal.slice(0, MAX_PERSONAL).forEach((p, i) => add(`p${i + 1}`, p.text, "personal", p.uses, aliasUsesFor(p.text)));
  bank.forEach((b, i) => add(`b${i + 1}`, b, "bank", 0, 0));
  // What was heard stays a choice, so the person is never denied their own words, unless a known sentence is the same.
  heard.forEach((h, i) => add(`h${i + 1}`, h.text, "heard", 0, 0));
  return pool;
}

/** Higher is more likely to be what the person meant. */
export function score(candidate: Candidate, heard: Heard[]): number {
  // The recogniser's own text is a fallback choice, not a good guess: it matches itself perfectly, so it is scored
  // by how sure the recogniser was and kept below a real sentence that sounds like it.
  if (candidate.origin === "heard") {
    const own = heard.find((h) => normalize(h.text) === normalize(candidate.text));
    return 0.15 + 0.15 * Math.min(1, Math.max(0, own?.confidence ?? 0));
  }
  let best = 0;
  for (const h of heard) {
    const weight = 0.6 + 0.4 * Math.min(1, Math.max(0, h.confidence));
    best = Math.max(best, similarity(candidate.text, h.text) * weight);
  }
  // A sound-alike the person has settled before is the strongest sign. Frequent use is a weaker one.
  const learned = candidate.aliasUses > 0 ? 1 + 0.1 * Math.log2(1 + candidate.aliasUses) : 0;
  const familiar = candidate.uses > 0 ? Math.min(0.3, 0.1 + 0.05 * Math.log2(1 + candidate.uses)) : 0;
  return best + learned + familiar;
}

/** The order the rules would choose with no model. Ties go to sentences used more, then to alphabetical order. */
export function fallbackRank(pool: Candidate[], heard: Heard[], limit = MAX_OPTIONS): Candidate[] {
  return [...pool]
    .map((c) => ({ c, s: score(c, heard) }))
    .sort((a, b) => b.s - a.s || b.c.uses - a.c.uses || a.c.text.localeCompare(b.c.text))
    .slice(0, limit)
    .map((x) => x.c);
}

/** What the model is shown: nearly everything, with the best by the rules first. */
export function shownToModel(pool: Candidate[], heard: Heard[]): Candidate[] {
  return fallbackRank(pool, heard, MAX_SHOWN_TO_MODEL);
}

interface ModelChoice {
  id?: unknown;
  text?: unknown;
}

/**
 * Turns the model's answer into the list that is shown. Throws PolicyViolation if the answer breaks a rule:
 * an id that was not offered, a repeat, or a "correction" that is longer than allowed, too far from what was heard,
 * or made of words that nobody in the conversation has used.
 */
export function applyModelOutput(output: unknown, shown: Candidate[], pool: Candidate[], heard: Heard[]): Candidate[] {
  const choices = (output as { choices?: unknown })?.choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    const shape = Array.isArray(choices) ? "an empty list" : typeof choices;
    throw new PolicyViolation(`choices must be a list with at least one item, not ${shape}; the answer was ${JSON.stringify(output)?.slice(0, 120)}`);
  }
  // Only the first eight are read: six are shown, and a model that lists more has still put its best first.
  const byId = new Map(shown.map((c) => [c.id, c]));
  const vocabulary = new Set<string>();
  for (const c of pool) for (const w of words(c.text)) vocabulary.add(w);
  for (const h of heard) for (const w of words(h.text)) vocabulary.add(w);

  const chosen: Candidate[] = [];
  const used = new Set<string>();
  let corrections = 0;
  for (const raw of (choices as ModelChoice[]).slice(0, 8)) {
    const hasId = typeof raw?.id === "string" && raw.id !== "";
    const hasText = typeof raw?.text === "string" && raw.text !== "";
    if (!hasId && !hasText) throw new PolicyViolation("each choice needs an id or a text");
    let candidate: Candidate;
    if (hasId) {
      const found = byId.get(raw.id as string);
      if (!found) throw new PolicyViolation(`id ${String(raw.id)} was not offered`);
      // Models often copy the sentence next to its id. That is fine as long as the two agree.
      if (hasText && normalize(String(raw.text)) !== normalize(found.text)) throw new PolicyViolation("a choice has an id and a different text");
      candidate = found;
    } else {
      const text = sentence(String(raw.text));
      if (++corrections > MAX_CORRECTIONS) throw new PolicyViolation("too many corrected sentences");
      if (text.length > MAX_CORRECTION_CHARS || words(text).length > MAX_CORRECTION_WORDS) throw new PolicyViolation("a corrected sentence is too long");
      if (!/^[\x20-\x7e]+$/.test(text)) throw new PolicyViolation("a corrected sentence holds a character that is not plain text");
      if (heard.length === 0) throw new PolicyViolation("nothing was heard, so nothing can be corrected");
      if (Math.min(...heard.map((h) => editRatio(text, h.text))) > MAX_CORRECTION_EDIT) throw new PolicyViolation("a corrected sentence is too far from what was heard");
      const unknown = words(text).find((w) => !vocabulary.has(w));
      if (unknown) throw new PolicyViolation(`a corrected sentence uses a word nobody has used: ${unknown}`);
      candidate = { id: `c${corrections}`, text, origin: "correction", uses: 0, aliasUses: 0 };
    }
    const key = normalize(candidate.text);
    if (used.has(key)) throw new PolicyViolation("a sentence was offered twice");
    used.add(key);
    chosen.push(candidate);
  }
  return fillUp(chosen.slice(0, MAX_OPTIONS), pool, heard);
}

/** If fewer than six were chosen, the rules add the next best, so the person always has five other choices. */
export function fillUp(chosen: Candidate[], pool: Candidate[], heard: Heard[]): Candidate[] {
  const used = new Set(chosen.map((c) => normalize(c.text)));
  for (const c of fallbackRank(pool, heard, pool.length)) {
    if (chosen.length >= MAX_OPTIONS) break;
    if (!used.has(normalize(c.text))) {
      used.add(normalize(c.text));
      chosen.push(c);
    }
  }
  return chosen;
}
