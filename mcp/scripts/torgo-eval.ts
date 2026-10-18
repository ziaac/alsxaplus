// Measures the sentence ordering on recordings of speakers with dysarthria from the TORGO database.
//
// For each speaker, in the order the recordings were made: three Deepgram recognisers write down what they hear, the
// rules order the speaker's own prompts (a closed list, like a personal phrase book), and we check whether the sentence
// that was really spoken is first, or among the first six. Then the sentence is "confirmed", so what the speaker's
// sounds turned out to mean is learned and used for the next recordings. The same recordings are scored cold (the
// first time a sentence is spoken) and warm (after it was confirmed before).
//
// The audio never leaves this machine except to the recognisers, is never copied into the repository, and only
// aggregate numbers are reported. TORGO is free for academic and non-profit use and asks for citation:
// Rudzicz, Namasivayam and Wolff (2012), Language Resources and Evaluation 46(4).
//
// Usage (from mcp/): npx tsx scripts/torgo-eval.ts <folder with the TORGO speakers> [--per-speaker 60] [--speakers F01,M02]
import { readdirSync, readFileSync, statSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { applyModelOutput, buildPool, fallbackRank, type Alias, type Heard, type PersonalPhrase } from "../src/ranking.js";
import { normalize } from "../src/similarity.js";

try {
  process.loadEnvFile(new URL("../../web/.env", import.meta.url));
} catch {
  // the key may come from the environment
}
void applyModelOutput;

const args = process.argv.slice(2);
const root = args.find((a) => !a.startsWith("--"));
const flag = (name: string, fallback: string) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1]! : fallback;
};
if (!root || !existsSync(root)) {
  console.error("Give the folder that holds the TORGO speakers (F01, M01, ...).");
  process.exit(2);
}
const perSpeaker = Number(flag("--per-speaker", "80"));
const onlySpeakers = flag("--speakers", "").split(",").filter(Boolean);
const key = process.env.DEEPGRAM_API_KEY?.trim();
if (!key) {
  console.error("DEEPGRAM_API_KEY is not set.");
  process.exit(2);
}

interface Item {
  speaker: string;
  wav: string;
  prompt: string;
  order: number;
}

const dirs = (p: string) => readdirSync(p).filter((d) => statSync(join(p, d)).isDirectory());

function collect(): Item[] {
  // scripts/extract_torgo_subset.py writes a manifest next to the recordings it copied.
  const manifest = join(root!, "manifest.json");
  if (existsSync(manifest)) {
    const rows = JSON.parse(readFileSync(manifest, "utf8")) as { speaker: string; file: string; prompt: string; order: number }[];
    return rows
      .filter((r) => !onlySpeakers.length || onlySpeakers.includes(r.speaker))
      .map((r) => ({ speaker: r.speaker, wav: join(root!, r.file), prompt: r.prompt, order: r.order }));
  }
  const items: Item[] = [];
  // Speakers with dysarthria are F01, F03, F04, M01 to M05. Controls (FC.., MC..) are left out.
  const speakers = dirs(root!).filter((d) => /^[FM]0\d$/.test(d)).filter((d) => !onlySpeakers.length || onlySpeakers.includes(d));
  for (const speaker of speakers) {
    for (const session of dirs(join(root!, speaker)).filter((d) => /^Session/.test(d)).sort()) {
      const base = join(root!, speaker, session);
      const wavDir = ["wav_headMic", "wav_arrayMic"].map((d) => join(base, d)).find((d) => existsSync(d));
      const promptDir = join(base, "prompts");
      if (!wavDir || !existsSync(promptDir)) continue;
      for (const file of readdirSync(wavDir).filter((f) => f.endsWith(".wav")).sort()) {
        const promptFile = join(promptDir, file.replace(/\.wav$/, ".txt"));
        if (!existsSync(promptFile)) continue;
        const prompt = readFileSync(promptFile, "utf8").replace(/\s+/g, " ").trim();
        // Instructions in brackets, picture prompts and empty lines are not sentences.
        if (!prompt || /[\[\]/\\]|xxx|\.jpg|\.png/i.test(prompt) || !/^[A-Za-z' ,.!?-]+$/.test(prompt)) continue;
        items.push({ speaker, wav: join(wavDir, file), prompt, order: items.length });
      }
    }
  }
  return items;
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

interface Result {
  speaker: string;
  prompt: string;
  words: number;
  seenBefore: boolean;
  transcriptExact: boolean;
  anyTranscriptExact: boolean;
  top1: boolean;
  top6: boolean;
}

async function main() {
  const all = collect();
  if (all.length === 0) throw new Error("No recordings with prompts were found. Expected <speaker>/Session*/wav_headMic/*.wav and prompts/*.txt");
  const results: Result[] = [];
  const speakers = [...new Set(all.map((i) => i.speaker))];
  console.log(`${all.length} usable recordings from ${speakers.length} speaker(s): ${speakers.join(", ")}`);

  for (const speaker of speakers) {
    const mine = all.filter((i) => i.speaker === speaker);
    // The closed list of this speaker's sentences, like a personal phrase book.
    const book = [...new Set(mine.map((i) => i.prompt))];
    // Spread the recordings over all sessions so repeats and first times are both included.
    const step = Math.max(1, Math.floor(mine.length / perSpeaker));
    const chosen = mine.filter((_, i) => i % step === 0).slice(0, perSpeaker);
    const uses = new Map<string, number>();
    const aliasMap = new Map<string, Map<string, number>>();
    console.log(`${speaker}: ${chosen.length} recordings, a book of ${book.length} sentences`);

    for (const item of chosen) {
      let heard: Heard[] = [];
      try {
        heard = await ensemble(readFileSync(item.wav));
      } catch (error) {
        console.warn(`  skipped ${item.wav}: ${(error as Error).message}`);
        continue;
      }
      const personal: PersonalPhrase[] = [...uses].map(([text, n]) => ({ text, uses: n })).sort((a, b) => b.uses - a.uses);
      const aliases: Alias[] = [];
      for (const h of heard) {
        const k = normalize(h.text);
        for (const [text, n] of aliasMap.get(k) ?? []) aliases.push({ heard: k, text, uses: n });
      }
      const ranked = fallbackRank(buildPool(heard, personal, aliases, book), heard).map((c) => normalize(c.text));
      const want = normalize(item.prompt);
      results.push({
        speaker,
        prompt: item.prompt,
        words: want.split(" ").length,
        seenBefore: uses.has(item.prompt),
        transcriptExact: heard[0] ? normalize(heard[0].text) === want : false,
        anyTranscriptExact: heard.some((h) => normalize(h.text) === want),
        top1: ranked[0] === want,
        top6: ranked.slice(0, 6).includes(want),
      });
      // The speaker confirms the sentence: it and the sounds that were written for it are learned.
      uses.set(item.prompt, (uses.get(item.prompt) ?? 0) + 1);
      for (const h of heard) {
        const k = normalize(h.text);
        if (!k || k === want) continue;
        const m = aliasMap.get(k) ?? new Map<string, number>();
        m.set(item.prompt, (m.get(item.prompt) ?? 0) + 1);
        aliasMap.set(k, m);
      }
    }
  }

  const rate = (rs: Result[], f: (r: Result) => boolean) => (rs.length ? `${((100 * rs.filter(f).length) / rs.length).toFixed(0)}% (${rs.filter(f).length}/${rs.length})` : "n/a");
  const row = (label: string, rs: Result[]) =>
    `| ${label} | ${rs.length} | ${rate(rs, (r) => r.transcriptExact)} | ${rate(rs, (r) => r.anyTranscriptExact)} | ${rate(rs, (r) => r.top1)} | ${rate(rs, (r) => r.top6)} |`;
  const lines = [
    "| Recordings | n | Best transcript is exactly right | Any of the transcripts is exactly right | Right sentence first | Right sentence among the six |",
    "|---|---|---|---|---|---|",
    row("All", results),
    row("First time this sentence is spoken (cold)", results.filter((r) => !r.seenBefore)),
    row("Spoken and confirmed before (warm)", results.filter((r) => r.seenBefore)),
    row("One word", results.filter((r) => r.words === 1)),
    row("Two or more words", results.filter((r) => r.words > 1)),
    ...speakers.map((s) => row(`Speaker ${s}`, results.filter((r) => r.speaker === s))),
  ];
  console.log("\n" + lines.join("\n"));
  writeFileSync(new URL("../../data/torgo-results.json", import.meta.url), JSON.stringify({ results }, null, 1));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
