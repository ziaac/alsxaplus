// Measures the estimate that decides when the assistant asks "Do you have difficulty speaking?".
//
// The same three recognisers listen to recordings of speakers with dysarthria and to recordings of speakers without it
// (the TORGO control speakers). For each recording the code decides "ask" or "do not ask". We report how often each
// group would be asked, and how soon a speaker would be asked within a first run of recordings. A control speaker who
// is asked is a false alarm (harmless, the answer is "no"); a speaker with dysarthria who is not asked can still turn
// the help on in the settings. Only aggregate numbers are reported and the audio stays on this machine.
//
// Usage (from mcp/): npx tsx scripts/torgo-clarity.ts <dysarthria folder> <controls folder> [--per-speaker 40]
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assessClarity, DISAGREEMENT, LOW_CONFIDENCE } from "../src/clarity.js";
import type { Heard } from "../src/ranking.js";

try {
  process.loadEnvFile(new URL("../../web/.env", import.meta.url));
} catch {
  // the key may come from the environment
}
const args = process.argv.slice(2);
const folders = args.filter((a) => !a.startsWith("--") && !/^[0-9]+$/.test(a));
const perSpeaker = Number(args[args.indexOf("--per-speaker") + 1] || 40);
const key = process.env.DEEPGRAM_API_KEY?.trim();
if (folders.length < 2 || !folders.every((f) => existsSync(join(f, "manifest.json")))) {
  console.error("Give the dysarthria folder and the controls folder, each with a manifest.json.");
  process.exit(2);
}
if (!key) {
  console.error("DEEPGRAM_API_KEY is not set.");
  process.exit(2);
}

async function listen(model: string, alternatives: number, audio: Buffer): Promise<Heard[]> {
  const params = new URLSearchParams({ model, language: "en", alternatives: String(alternatives), mip_opt_out: "true" });
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await fetch(`https://api.deepgram.com/v1/listen?${params}`, { method: "POST", headers: { authorization: `Token ${key}`, "content-type": "audio/wav" }, body: new Uint8Array(audio), signal: AbortSignal.timeout(30_000) });
    if (res.ok) {
      const json: any = await res.json();
      return ((json?.results?.channels?.[0]?.alternatives ?? []) as any[]).map((a) => ({ text: String(a.transcript ?? "").replace(/[\s.,!?;:]+$|^[\s.,!?;:]+/g, "").trim(), confidence: Number(a.confidence ?? 0) })).filter((h) => h.text);
    }
    if (![429, 502, 503, 504].includes(res.status) || attempt === 3) throw new Error(`Deepgram ${model} answered HTTP ${res.status}`);
    await new Promise((r) => setTimeout(r, 500 * attempt));
  }
  return [];
}

async function ensemble(audio: Buffer): Promise<Heard[]> {
  const parts = await Promise.allSettled([listen("nova-3", 1, audio), listen("nova-2", 1, audio), listen("base", 3, audio)]);
  const out: Heard[] = [];
  const seen = new Set<string>();
  for (const p of parts) {
    if (p.status !== "fulfilled") continue;
    for (const h of p.value) {
      const k = h.text.toLowerCase();
      if (!seen.has(k)) {
        seen.add(k);
        out.push(h);
      }
    }
  }
  return out.sort((a, b) => b.confidence - a.confidence).slice(0, 5);
}

interface Row {
  group: "dysarthria" | "control";
  speaker: string;
  index: number;
  top: number;
  heard: number;
}

async function run(folder: string, group: Row["group"]): Promise<{ rows: Row[]; heards: Heard[][] }> {
  const manifest = JSON.parse(readFileSync(join(folder, "manifest.json"), "utf8")) as { speaker: string; file: string }[];
  const rows: Row[] = [];
  const heards: Heard[][] = [];
  for (const speaker of [...new Set(manifest.map((m) => m.speaker))]) {
    const mine = manifest.filter((m) => m.speaker === speaker);
    const step = Math.max(1, Math.floor(mine.length / perSpeaker));
    const chosen = mine.filter((_, i) => i % step === 0).slice(0, perSpeaker);
    console.log(`${group} ${speaker}: ${chosen.length} recordings`);
    let index = 0;
    for (const item of chosen) {
      try {
        const heard = await ensemble(readFileSync(join(folder, item.file)));
        rows.push({ group, speaker, index: index++, top: heard.length ? Math.max(...heard.map((h) => h.confidence)) : 0, heard: heard.length });
        heards.push(heard);
      } catch (error) {
        console.warn(`  skipped ${item.file}: ${(error as Error).message}`);
      }
    }
  }
  return { rows, heards };
}

const pct = (n: number, d: number) => (d ? `${((100 * n) / d).toFixed(0)}% (${n}/${d})` : "n/a");

async function main() {
  const a = await run(folders[0]!, "dysarthria");
  const b = await run(folders[1]!, "control");
  const all = [...a.rows.map((r, i) => ({ r, h: a.heards[i]! })), ...b.rows.map((r, i) => ({ r, h: b.heards[i]! }))];
  const flagged = (h: Heard[]) => assessClarity(h).unclear;

  const lines = ["| Recordings | n | Would be asked (this setting) | Asked because of low confidence | Asked because the recognisers disagree |", "|---|---|---|---|---|"];
  for (const group of ["dysarthria", "control"] as const) {
    const g = all.filter((x) => x.r.group === group);
    const why = (reason: string) => g.filter((x) => assessClarity(x.h).reasons.includes(reason as never)).length;
    lines.push(`| ${group === "dysarthria" ? "Speakers with dysarthria" : "Speakers without dysarthria (controls)"} | ${g.length} | ${pct(g.filter((x) => flagged(x.h)).length, g.length)} | ${pct(why("low_confidence"), g.length)} | ${pct(why("recognisers_disagree"), g.length)} |`);
  }
  console.log(`\nConfidence threshold ${LOW_CONFIDENCE}, disagreement threshold ${DISAGREEMENT}\n${lines.join("\n")}`);

  // How soon would a speaker be asked, going through their recordings in order?
  const firstAsked = (speaker: string) => {
    const mine = all.filter((x) => x.r.speaker === speaker);
    const i = mine.findIndex((x) => flagged(x.h));
    return i < 0 ? Infinity : i + 1;
  };
  for (const group of ["dysarthria", "control"] as const) {
    const speakers = [...new Set(all.filter((x) => x.r.group === group).map((x) => x.r.speaker))];
    const firsts = speakers.map(firstAsked);
    console.log(`${group}: speakers asked within their first 3 recordings: ${pct(firsts.filter((n) => n <= 3).length, speakers.length)}; first asked at recording ${firsts.map((n) => (n === Infinity ? "never" : n)).join(", ")}`);
  }

  // The same rule at other confidence thresholds, to show the trade-off.
  console.log("\nOther confidence thresholds (disagreement rule unchanged):");
  for (const t of [0.7, 0.8, 0.85, 0.9, 0.95]) {
    const f = (x: { h: Heard[] }) => x.h.length === 0 || Math.max(...x.h.map((h) => h.confidence)) < t || assessClarity(x.h).reasons.includes("recognisers_disagree");
    const d = all.filter((x) => x.r.group === "dysarthria");
    const c = all.filter((x) => x.r.group === "control");
    console.log(`  ${t}: dysarthria asked ${pct(d.filter(f).length, d.length)}, controls asked ${pct(c.filter(f).length, c.length)}`);
  }
  writeFileSync(new URL("../../data/clarity-results.json", import.meta.url), JSON.stringify(all.map((x) => x.r), null, 1));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
