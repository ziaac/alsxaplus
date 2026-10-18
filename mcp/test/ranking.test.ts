import { describe, expect, it } from "vitest";
import { CORE_PHRASES } from "../src/phrasebank.js";
import { applyModelOutput, buildPool, fallbackRank, fillUp, MAX_OPTIONS, PolicyViolation, shownToModel, type Heard } from "../src/ranking.js";
import { assessClarity } from "../src/clarity.js";
import { dice, editRatio, levenshtein, normalize, similarity } from "../src/similarity.js";

const heard = (text: string, confidence = 0.5): Heard[] => [{ text, confidence }];

describe("text helpers", () => {
  it("normalize keeps letters, digits and apostrophes in lower case", () => {
    expect(normalize("  I'M   Thirsty!! ")).toBe("i'm thirsty");
    expect(normalize("Café")).toBe("cafe");
  });
  it("levenshtein and editRatio count edits", () => {
    expect(levenshtein("kitten", "sitting")).toBe(3);
    expect(editRatio("water", "water")).toBe(0);
    expect(editRatio("abc", "xyz")).toBe(1);
  });
  it("dice and similarity rank a damaged word near the right word", () => {
    expect(dice("wa er", "water")).toBeGreaterThan(dice("wa er", "light"));
    expect(similarity("I need water", "i need wa er")).toBeGreaterThan(similarity("Please close the door", "i need wa er"));
  });
});

describe("the rules without a model", () => {
  const pool = (h: Heard[], personal: { text: string; uses: number }[] = [], aliases: { heard: string; text: string; uses: number }[] = []) => buildPool(h, personal, aliases, CORE_PHRASES);

  it("offers one recommended and five other sentences, all different", () => {
    const h = heard("i thirsty");
    const ranked = fallbackRank(pool(h), h);
    expect(ranked).toHaveLength(MAX_OPTIONS);
    expect(new Set(ranked.map((c) => normalize(c.text))).size).toBe(MAX_OPTIONS);
  });

  it("puts a sentence that sounds like what was heard near the top", () => {
    const h = heard("i am hun ry");
    const ranked = fallbackRank(pool(h), h).map((c) => c.text);
    expect(ranked.slice(0, 3)).toContain("I am hungry");
  });

  it("puts a sentence confirmed for these very sounds first", () => {
    const h = heard("wa er", 0.3);
    const ranked = fallbackRank(pool(h, [{ text: "Please bring me a pillow", uses: 3 }], [{ heard: "wa er", text: "Please bring me a pillow", uses: 2 }]), h);
    expect(ranked[0]?.text).toBe("Please bring me a pillow");
  });

  it("prefers sentences the person uses often when the sounds fit equally", () => {
    const h = heard("i am", 0.3);
    const ranked = fallbackRank(pool(h, [{ text: "I am fine today", uses: 9 }]), h);
    expect(ranked.slice(0, 3).map((c) => c.text)).toContain("I am fine today");
  });

  it("still offers a full list when nothing was heard", () => {
    const ranked = fallbackRank(pool([], [{ text: "Call Maya", uses: 4 }]), []);
    expect(ranked).toHaveLength(MAX_OPTIONS);
    expect(ranked[0]?.text).toBe("Call Maya");
  });

  it("does not recommend the recogniser's damaged text over a real sentence that sounds like it", () => {
    const h = heard("ah in pay", 0.4);
    const ranked = fallbackRank(pool(h), h).map((c) => c.text);
    expect(ranked[0]).not.toBe("Ah in pay");
    expect(ranked).toContain("I am in pain");
  });

  it("keeps what was heard as a choice, so the person is never denied their own words", () => {
    const h = heard("banana");
    const ids = pool(h).map((c) => c.origin);
    expect(ids).toContain("heard");
  });
});

describe("the policy for a model's answer", () => {
  const h = heard("i want wa er", 0.4);
  const fullPool = buildPool(h, [], [], CORE_PHRASES);
  const shown = shownToModel(fullPool, h);
  const idOf = (text: string) => fullPool.find((c) => c.text === text)!.id;

  it("accepts ids that were shown, and fills the list up to six", () => {
    const out = applyModelOutput({ choices: [{ id: idOf("I need water") }, { id: idOf("I am thirsty") }] }, shown, fullPool, h);
    expect(out[0]?.text).toBe("I need water");
    expect(out).toHaveLength(MAX_OPTIONS);
  });

  it("rejects an id that was not shown", () => {
    expect(() => applyModelOutput({ choices: [{ id: "zzz" }] }, shown, fullPool, h)).toThrow(PolicyViolation);
  });

  it("rejects a repeated sentence", () => {
    const id = idOf("I need water");
    expect(() => applyModelOutput({ choices: [{ id }, { id }] }, shown, fullPool, h)).toThrow(/twice/);
  });

  it("accepts an id with the same sentence copied beside it, and rejects an id with a different text, or neither", () => {
    const ok = applyModelOutput({ choices: [{ id: idOf("I need water"), text: "I need water" }] }, shown, fullPool, h);
    expect(ok[0]?.text).toBe("I need water");
    expect(() => applyModelOutput({ choices: [{ id: idOf("I need water"), text: "I want water" }] }, shown, fullPool, h)).toThrow(/different text/);
    expect(() => applyModelOutput({ choices: [{}] }, shown, fullPool, h)).toThrow(PolicyViolation);
  });

  it("allows a correction that stays close to what was heard and uses known words", () => {
    const out = applyModelOutput({ choices: [{ text: "I want water" }] }, shown, fullPool, h);
    expect(out[0]).toMatchObject({ text: "I want water", origin: "correction" });
  });

  it("rejects a correction that is far from what was heard", () => {
    expect(() => applyModelOutput({ choices: [{ text: "Please call my doctor" }] }, shown, fullPool, h)).toThrow(/too far/);
  });

  it("rejects a correction made of words nobody used", () => {
    const damaged = heard("take two pil", 0.3);
    const p = buildPool(damaged, [], [], CORE_PHRASES);
    expect(() => applyModelOutput({ choices: [{ text: "Take two pills" }] }, shownToModel(p, damaged), p, damaged)).toThrow(/word nobody has used/);
  });

  it("rejects more than two corrections, a long one, and any when nothing was heard", () => {
    const three = { choices: [{ text: "I want water" }, { text: "I want a water" }, { text: "I want wa ter" }] };
    expect(() => applyModelOutput(three, shown, fullPool, h)).toThrow(/too many/);
    expect(() => applyModelOutput({ choices: [{ text: "x".repeat(130) }] }, shown, fullPool, h)).toThrow(PolicyViolation);
    expect(() => applyModelOutput({ choices: [{ text: "I want water" }] }, shownToModel(buildPool([], [], [], CORE_PHRASES), []), buildPool([], [], [], CORE_PHRASES), [])).toThrow(/nothing was heard/);
  });

  it("rejects a corrected sentence with a character that is not plain text", () => {
    expect(() => applyModelOutput({ choices: [{ text: "I want wäter" }] }, shown, fullPool, h)).toThrow(PolicyViolation);
  });

  it("rejects an answer that is not a list", () => {
    for (const bad of [null, {}, { choices: [] }, { choices: "x" }, { choices: Array.from({ length: 9 }, () => ({ id: "b1" })) }]) {
      expect(() => applyModelOutput(bad, shown, fullPool, h)).toThrow(PolicyViolation);
    }
  });

  it("fillUp never repeats a sentence", () => {
    const filled = fillUp([fullPool[0]!], fullPool, h);
    expect(new Set(filled.map((c) => normalize(c.text))).size).toBe(filled.length);
  });
});

describe("estimating whether to ask", () => {
  it("confident recognisers that agree are understood without a question", () => {
    expect(assessClarity([{ text: "I need some water", confidence: 0.97 }, { text: "I need some water.", confidence: 0.9 }]).unclear).toBe(false);
  });
  it("low confidence, disagreement, or nothing heard lead to the question", () => {
    expect(assessClarity([{ text: "I need some water", confidence: 0.6 }]).reasons).toContain("low_confidence");
    expect(assessClarity([{ text: "mother shows yellow gingham", confidence: 0.92 }, { text: "bubble in a bed", confidence: 0.4 }]).reasons).toContain("recognisers_disagree");
    expect(assessClarity([]).reasons).toEqual(["nothing_heard"]);
  });
});
