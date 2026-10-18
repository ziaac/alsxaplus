// Sends damaged transcripts to the real model through the real service code, and reports what happened: how often the
// model's order passed the policy, which sentence came first, tokens, cost and delay. It spends a little money: run it
// on purpose. Usage (from mcp/): npx tsx scripts/probe.ts
import { createProfile } from "../src/auth.js";
import { loadConfig } from "../src/config.js";
import { connect, migrate } from "../src/db.js";
import { SAMPLES } from "./samples.js";
import { deleteEverything, setConsent, setSpeechSupport, suggestMeanings } from "../src/service.js";

try {
  process.loadEnvFile(new URL("../.env", import.meta.url));
} catch {
  // variables may come from the environment
}


async function main() {
  const config = loadConfig();
  if (!config.bedrock) throw new Error("AWS_BEARER_TOKEN_BEDROCK is not set, so there is no model to probe");
  const db = connect(config.databaseUrl);
  await migrate(db);
  const { profileId } = await createProfile(db);
  await setConsent(db, profileId, true);
  await setSpeechSupport(db, profileId, true);
  const before = Number((await db.query("SELECT count(*) AS n FROM model_usage")).rows[0].n);

  let agent = 0;
  let top1 = 0;
  let top6 = 0;
  const reasons: Record<string, number> = {};
  for (const [heard, meant] of SAMPLES) {
    const r = await suggestMeanings({ db, config }, profileId, [{ text: heard, confidence: 0.4 }]);
    if (r.status !== "ok") throw new Error(`unexpected status ${r.status}`);
    if (r.source === "agent") agent++;
    else reasons[(r.fallback_reason ?? "").split(":")[0] ?? ""] = (reasons[(r.fallback_reason ?? "").split(":")[0] ?? ""] ?? 0) + 1;
    const texts = r.options.map((o) => o.text.toLowerCase());
    const hit1 = texts[0] === meant.toLowerCase();
    const hit6 = texts.includes(meant.toLowerCase());
    if (hit1) top1++;
    if (hit6) top6++;
    console.log(`${r.source.padEnd(5)} ${hit1 ? "TOP1" : hit6 ? "top6" : "miss"}  heard "${heard}" meant "${meant}" -> ${r.recommended} | ${texts.slice(1, 4).join(" / ")}`);
  }
  const usage = await db.query(
    `SELECT count(*)::int AS calls, COALESCE(sum(input_tokens),0)::int AS tin, COALESCE(sum(output_tokens),0)::int AS tout, COALESCE(sum(estimated_usd),0)::float8 AS usd,
            COALESCE(percentile_cont(0.5) WITHIN GROUP (ORDER BY latency_ms),0)::int AS median_ms, COALESCE(max(latency_ms),0)::int AS max_ms
     FROM (SELECT * FROM model_usage ORDER BY created_at DESC LIMIT $1) x`,
    [Number((await db.query("SELECT count(*) AS n FROM model_usage")).rows[0].n) - before],
  );
  console.log(`\nsamples ${SAMPLES.length}: model order used ${agent}, rules ${SAMPLES.length - agent} ${JSON.stringify(reasons)}`);
  console.log(`the sentence that was meant: first ${top1} of ${SAMPLES.length}, among the six ${top6} of ${SAMPLES.length}`);
  console.log("usage:", JSON.stringify(usage.rows[0]));
  await deleteEverything(db, profileId);
  await db.end();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
