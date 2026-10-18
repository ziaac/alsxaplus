// An estimate of whether what was just heard was hard to understand. It decides only one thing: whether the assistant
// should ASK "Do you have difficulty speaking?". It never decides the answer. Unclear speech has many causes (a noisy
// room, a cold, an accent, a child), so the estimate is never stored as a conclusion about the person and never switches
// anything on by itself. Only the person's own answer, or their carer's, changes the profile.
import { normalize, similarity } from "./similarity.js";
import type { Heard } from "./ranking.js";

/** Below this confidence from the best recogniser, the words are treated as uncertain. */
export const LOW_CONFIDENCE = 0.85;
/** Two recognisers that write the same sounds this differently are treated as disagreeing. */
export const DISAGREEMENT = 0.75;

export type UnclearReason = "nothing_heard" | "low_confidence" | "recognisers_disagree";

export interface Clarity {
  unclear: boolean;
  reasons: UnclearReason[];
}

export function assessClarity(heard: Heard[]): Clarity {
  if (heard.length === 0) return { unclear: true, reasons: ["nothing_heard"] };
  const reasons: UnclearReason[] = [];
  const top = Math.max(...heard.map((h) => h.confidence));
  if (top < LOW_CONFIDENCE) reasons.push("low_confidence");
  // Different recognisers writing different words for the same recording is itself a sign of unclear speech.
  const best = heard.reduce((a, b) => (b.confidence > a.confidence ? b : a));
  const others = heard.filter((h) => normalize(h.text) !== normalize(best.text));
  if (others.some((h) => similarity(best.text, h.text) < DISAGREEMENT)) reasons.push("recognisers_disagree");
  return { unclear: reasons.length > 0, reasons };
}
