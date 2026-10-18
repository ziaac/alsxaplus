// What the server does for one person. Everything here is independent of MCP and HTTP, so it can be tested directly.
// The sentence that is offered is only ever a suggestion: the person decides, and the person's choice is what is learned.
import { callWithRetries, ModelError } from "./bedrock.js";
import { assessClarity, type UnclearReason } from "./clarity.js";
import type { Config } from "./config.js";
import type { Db } from "./db.js";
import { CORE_PHRASES } from "./phrasebank.js";
import {
  applyModelOutput,
  buildPool,
  type Alias,
  type Candidate,
  fallbackRank,
  fillUp,
  type Heard,
  MAX_OPTIONS,
  type PersonalPhrase,
  PolicyViolation,
  shownToModel,
} from "./ranking.js";
import { normalize } from "./similarity.js";
import { recordUsage, refusalReason, worstCaseUsd } from "./usage.js";

export class ServiceError extends Error {
  constructor(
    readonly code: "consent_required" | "invalid_argument" | "not_found",
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_HEARD = 5;
const MAX_TEXT = 200;

/** Printable text only, one line, not too long. */
export function cleanText(raw: unknown, max = MAX_TEXT): string {
  return String(raw ?? "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

export function cleanHeard(input: unknown): Heard[] {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) throw new ServiceError("invalid_argument", "heard must be a list of what was heard.", 400);
  const out: Heard[] = [];
  const seen = new Set<string>();
  for (const item of input.slice(0, MAX_HEARD)) {
    const text = cleanText((item as { text?: unknown })?.text);
    const key = normalize(text);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const c = Number((item as { confidence?: unknown })?.confidence);
    out.push({ text, confidence: Number.isFinite(c) ? Math.min(1, Math.max(0, c)) : 0.5 });
  }
  return out;
}

export interface Deps {
  db: Db;
  config: Config;
}

export interface Status {
  consent: boolean;
  speech_support: boolean | null;
  phrases: number;
  learned_sounds: number;
}

export async function getStatus(db: Db, profileId: string): Promise<Status> {
  const r = await db.query(
    `SELECT consented_at IS NOT NULL AS consent, speech_support,
            (SELECT count(*) FROM phrases WHERE profile_id = $1)::int AS phrases,
            (SELECT count(*) FROM aliases WHERE profile_id = $1)::int AS learned
     FROM profiles WHERE id = $1`,
    [profileId],
  );
  const row = r.rows[0];
  if (!row) throw new ServiceError("not_found", "The profile was not found.", 404);
  return { consent: row.consent, speech_support: row.speech_support, phrases: row.phrases, learned_sounds: row.learned };
}

export async function setConsent(db: Db, profileId: string, given: boolean): Promise<Status> {
  await db.query("UPDATE profiles SET consented_at = CASE WHEN $2 THEN COALESCE(consented_at, now()) END WHERE id = $1", [profileId, given]);
  const s = await getStatus(db, profileId);
  if (s.consent !== given) throw new Error(`consent for ${profileId} was set to ${given} but reads back as ${s.consent}`);
  return s;
}

/** Asked once. The answer stays with the profile, and the person can change it at any time. */
export async function setSpeechSupport(db: Db, profileId: string, enabled: boolean): Promise<Status> {
  await requireConsent(db, profileId);
  await db.query("UPDATE profiles SET speech_support = $2 WHERE id = $1", [profileId, enabled]);
  const s = await getStatus(db, profileId);
  if (s.speech_support !== enabled) throw new Error(`speech support for ${profileId} did not read back as ${enabled}`);
  return s;
}

async function requireConsent(db: Db, profileId: string): Promise<Status> {
  const s = await getStatus(db, profileId);
  if (!s.consent) throw new ServiceError("consent_required", "The person or their carer needs to agree in the app before anything is learned.", 403);
  return s;
}

const SYSTEM = [
  "You help a person with a speech disability say what they mean.",
  "A speech recognizer wrote down what it heard. For this person it is often wrong, but its mistakes are usually consistent: the same sounds are written the same wrong way.",
  "You are given what was heard and a list of candidate sentences with ids. Put the candidates in order, from the one the person most likely meant to the least likely.",
  "Prefer sentences the person has confirmed before (uses > 0) when they fit the sounds. A candidate with origin learned was confirmed for these very sounds, so it comes first.",
  "You may add at most two corrected sentences when what was heard is clearly a damaged version of a short everyday sentence. Keep a correction close to what was heard and use only words that appear in the candidates or in what was heard.",
  "Choose the order only. Do not add advice, medical information, or anything that the sounds do not suggest.",
  "Answer by calling the tool record_order. For a listed candidate give only its id. For a correction give only a text.",
].join(" ");

const TOOL_NAME = "record_order";

/** The ids the model may use are listed in the schema itself, so an id that was not offered cannot even be named. */
const toolSchema = (ids: string[]) => ({
  type: "object",
  properties: {
    choices: {
      type: "array",
      minItems: 1,
      maxItems: 8,
      items: {
        type: "object",
        properties: { id: { type: "string", enum: ids }, text: { type: "string", maxLength: 120 } },
        additionalProperties: false,
      },
    },
  },
  required: ["choices"],
  additionalProperties: false,
});

export interface Suggestion {
  status: "ok";
  utterance_id: string;
  recommended: string;
  others: string[];
  options: { rank: number; text: string; origin: string }[];
  source: "agent" | "rule";
  fallback_reason: string | null;
  heard_nothing: boolean;
  spoken: string;
}

export type SuggestResult =
  | Suggestion
  | { status: "needs_speech_support_answer"; reasons: UnclearReason[]; spoken: string }
  | { status: "no_help_needed"; spoken: string }
  | { status: "speech_support_off"; spoken: string };

export async function suggestMeanings(deps: Deps, profileId: string, heardInput: unknown): Promise<SuggestResult> {
  const { db, config } = deps;
  const status = await requireConsent(db, profileId);
  const heard = cleanHeard(heardInput);
  if (status.speech_support === null) {
    // Not asked yet. Only when what was heard looks unclear is the person asked, and only the person's answer counts:
    // the estimate is not stored and never switches anything on.
    const clarity = assessClarity(heard);
    if (!clarity.unclear) {
      return { status: "no_help_needed", spoken: "I understood that, so I will carry on as usual. If it ever gets hard to understand you, I will ask whether you would like help." };
    }
    return {
      status: "needs_speech_support_answer",
      reasons: clarity.reasons,
      spoken: "I had some trouble understanding that. Do you have difficulty speaking? Say yes or no. I will only ask once, and I will not assume anything.",
    };
  }
  if (status.speech_support === false) {
    return { status: "speech_support_off", spoken: "Speech support is off, so I will listen as usual. You can turn it on at any time." };
  }

  const personalRows = await db.query("SELECT text, uses FROM phrases WHERE profile_id = $1 ORDER BY uses DESC, last_used_at DESC LIMIT 40", [profileId]);
  const personal: PersonalPhrase[] = personalRows.rows.map((r) => ({ text: String(r.text), uses: Number(r.uses) }));
  const keys = heard.map((h) => normalize(h.text));
  const aliasRows = keys.length
    ? await db.query("SELECT heard, text, uses FROM aliases WHERE profile_id = $1 AND heard = ANY($2::text[]) ORDER BY uses DESC LIMIT 10", [profileId, keys])
    : { rows: [] };
  const aliases: Alias[] = aliasRows.rows.map((r) => ({ heard: String(r.heard), text: String(r.text), uses: Number(r.uses) }));

  const pool = buildPool(heard, personal, aliases, CORE_PHRASES);
  let ranked: Candidate[] = fallbackRank(pool, heard);
  let source: "agent" | "rule" = "rule";
  let fallbackReason: string | null = null;

  if (heard.length === 0) {
    fallbackReason = "nothing_heard";
  } else if (!config.bedrock) {
    fallbackReason = "model_not_configured";
  } else {
    const shown = shownToModel(pool, heard);
    const user = JSON.stringify({
      heard,
      candidates: shown.map((c) => ({ id: c.id, text: c.text, origin: c.origin, uses: c.uses })),
    });
    const request = { system: SYSTEM, user, toolName: TOOL_NAME, toolDescription: "Record the order of the candidate sentences.", toolSchema: toolSchema(shown.map((c) => c.id)), maxTokens: 300 };
    const refusal = await refusalReason(db, config.bedrock, worstCaseUsd(config.bedrock, SYSTEM.length + user.length, request.maxTokens));
    if (refusal) {
      fallbackReason = refusal;
    } else {
      try {
        let { reply, retries } = await callWithRetries(config.bedrock, request);
        // A model now and then answers with an empty object. One more try is cheap; after that the rules decide.
        const empty = (r: typeof reply) => !(r.toolInput && typeof r.toolInput === "object" && Object.keys(r.toolInput).length > 0);
        if (empty(reply)) {
          console.warn("[suggest] the model answered with nothing, asking once more");
          await recordUsage(db, config.bedrock, { profileId, purpose: "suggest", modelId: config.bedrock.modelId, inputTokens: reply.inputTokens, outputTokens: reply.outputTokens, outcome: "invalid_output", detail: "empty tool input", latencyMs: reply.latencyMs });
          ({ reply, retries } = await callWithRetries(config.bedrock, request));
        }
        try {
          ranked = applyModelOutput(reply.toolInput, shown, pool, heard);
          source = "agent";
          await recordUsage(db, config.bedrock, { profileId, purpose: "suggest", modelId: config.bedrock.modelId, inputTokens: reply.inputTokens, outputTokens: reply.outputTokens, outcome: "ok", latencyMs: reply.latencyMs });
        } catch (violation) {
          if (!(violation instanceof PolicyViolation)) throw violation;
          console.warn(`[suggest] the model's order breaks the policy, the rules decide: ${violation.message}`);
          fallbackReason = `policy_violation: ${violation.message}`;
          await recordUsage(db, config.bedrock, { profileId, purpose: "suggest", modelId: config.bedrock.modelId, inputTokens: reply.inputTokens, outputTokens: reply.outputTokens, outcome: "policy_violation", detail: fallbackReason, latencyMs: reply.latencyMs });
        }
        void retries;
      } catch (error) {
        const why = error instanceof ModelError ? error.message : `unexpected: ${(error as Error).message}`;
        console.error(`[suggest] the model could not be used, the rules decide: ${why}`);
        fallbackReason = `model_error: ${why}`.slice(0, 300);
        await recordUsage(db, config.bedrock, { profileId, purpose: "suggest", modelId: config.bedrock.modelId, inputTokens: 0, outputTokens: 0, outcome: "error", detail: fallbackReason });
      }
    }
  }
  ranked = fillUp(ranked.slice(0, MAX_OPTIONS), pool, heard);

  const options = ranked.map((c, i) => ({ rank: i, text: c.text, origin: c.origin }));
  const inserted = await db.query(
    "INSERT INTO utterances (profile_id, heard, candidates, source, fallback_reason) VALUES ($1, $2, $3, $4, $5) RETURNING id",
    [profileId, JSON.stringify(heard), JSON.stringify(options), source, fallbackReason?.slice(0, 300) ?? null],
  );
  const utteranceId = String(inserted.rows[0].id);
  const back = await db.query("SELECT jsonb_array_length(candidates) AS n FROM utterances WHERE id = $1 AND profile_id = $2", [utteranceId, profileId]);
  if (Number(back.rows[0]?.n) !== options.length) throw new Error(`utterance ${utteranceId} was not stored as offered`);

  const recommended = ranked[0]?.text ?? "";
  return {
    status: "ok",
    utterance_id: utteranceId,
    recommended,
    others: ranked.slice(1).map((c) => c.text),
    options,
    source,
    fallback_reason: fallbackReason,
    heard_nothing: heard.length === 0,
    spoken: heard.length === 0 ? `I did not catch anything. Is it: ${recommended}? You can pick another sentence or type it.` : `Did you mean: ${recommended}? You can say yes, pick another sentence, or type it.`,
  };
}

export interface Confirmed {
  text: string;
  kind: "suggested" | "alternative" | "typed";
  already_confirmed: boolean;
  uses: number;
  learned_sounds: number;
  spoken: string;
}

export async function confirmMeaning(db: Db, profileId: string, input: { utteranceId: string; option?: number; typedText?: string }): Promise<Confirmed> {
  await requireConsent(db, profileId);
  if (!UUID.test(input.utteranceId)) throw new ServiceError("invalid_argument", "utterance_id must be the id that suggest_meanings returned.", 400);
  const hasOption = input.option !== undefined && input.option !== null;
  const hasTyped = input.typedText !== undefined && input.typedText !== null && input.typedText !== "";
  if (hasOption === hasTyped) throw new ServiceError("invalid_argument", "Give either option (0 to 5) or typed_text, not both.", 400);

  const u = await db.query("SELECT heard, candidates FROM utterances WHERE id = $1 AND profile_id = $2", [input.utteranceId, profileId]);
  const row = u.rows[0];
  if (!row) throw new ServiceError("not_found", "That suggestion was not found.", 404);
  const options: { rank: number; text: string }[] = row.candidates;
  const heard: Heard[] = row.heard;

  const existing = await db.query("SELECT text, kind FROM confirmations WHERE utterance_id = $1", [input.utteranceId]);
  if (existing.rows[0]) {
    const p = await db.query("SELECT uses FROM phrases WHERE profile_id = $1 AND text = $2", [profileId, existing.rows[0].text]);
    const s = await getStatus(db, profileId);
    return { text: existing.rows[0].text, kind: existing.rows[0].kind, already_confirmed: true, uses: Number(p.rows[0]?.uses ?? 1), learned_sounds: s.learned_sounds, spoken: existing.rows[0].text };
  }

  let text: string;
  let kind: Confirmed["kind"];
  let rank: number | null = null;
  if (hasOption) {
    const i = Number(input.option);
    const chosen = Number.isInteger(i) ? options[i] : undefined;
    if (!chosen) throw new ServiceError("invalid_argument", `option must be a whole number from 0 to ${options.length - 1}.`, 400);
    text = chosen.text;
    rank = i;
    kind = i === 0 ? "suggested" : "alternative";
  } else {
    text = cleanText(input.typedText);
    if (!normalize(text)) throw new ServiceError("invalid_argument", "typed_text needs letters or numbers.", 400);
    kind = "typed";
  }

  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query("INSERT INTO confirmations (utterance_id, profile_id, text, kind, rank) VALUES ($1, $2, $3, $4, $5)", [input.utteranceId, profileId, text, kind, rank]);
    await client.query(
      `INSERT INTO phrases (profile_id, text) VALUES ($1, $2)
       ON CONFLICT (profile_id, text) DO UPDATE SET uses = phrases.uses + 1, last_used_at = now()`,
      [profileId, text],
    );
    // The sounds that were written down for this sentence now point to it. Up to three, most confident first.
    const sounds = [...heard].sort((a, b) => b.confidence - a.confidence).map((h) => normalize(h.text)).filter((h, i, all) => h && h !== normalize(text) && all.indexOf(h) === i).slice(0, 3);
    for (const sound of sounds) {
      await client.query(
        `INSERT INTO aliases (profile_id, heard, text) VALUES ($1, $2, $3)
         ON CONFLICT (profile_id, heard, text) DO UPDATE SET uses = aliases.uses + 1, last_used_at = now()`,
        [profileId, sound, text],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }

  const back = await db.query("SELECT c.text, p.uses FROM confirmations c JOIN phrases p ON p.profile_id = c.profile_id AND p.text = c.text WHERE c.utterance_id = $1", [input.utteranceId]);
  if (back.rows[0]?.text !== text) throw new Error(`confirmation for ${input.utteranceId} was not stored as chosen`);
  const s = await getStatus(db, profileId);
  return { text, kind, already_confirmed: false, uses: Number(back.rows[0].uses), learned_sounds: s.learned_sounds, spoken: text };
}

export async function listPhrases(db: Db, profileId: string, limit = 50): Promise<{ text: string; uses: number }[]> {
  const r = await db.query("SELECT text, uses FROM phrases WHERE profile_id = $1 ORDER BY uses DESC, last_used_at DESC LIMIT $2", [profileId, Math.min(200, Math.max(1, limit))]);
  return r.rows.map((x) => ({ text: String(x.text), uses: Number(x.uses) }));
}

/** Forgets one sentence, and the sounds that pointed to it. */
export async function forgetPhrase(db: Db, profileId: string, text: string): Promise<{ removed: boolean }> {
  const removed = await db.query("DELETE FROM phrases WHERE profile_id = $1 AND text = $2", [profileId, text]);
  await db.query("DELETE FROM aliases WHERE profile_id = $1 AND text = $2", [profileId, text]);
  const left = await db.query("SELECT 1 FROM phrases WHERE profile_id = $1 AND text = $2 UNION ALL SELECT 1 FROM aliases WHERE profile_id = $1 AND text = $2", [profileId, text]);
  if (left.rowCount) throw new Error("the phrase is still there after it was forgotten");
  return { removed: (removed.rowCount ?? 0) > 0 };
}

/** Deletes the profile and everything about it. Cost records stay, without the link to the person. */
export async function deleteEverything(db: Db, profileId: string): Promise<{ deleted: true }> {
  await db.query("DELETE FROM profiles WHERE id = $1", [profileId]);
  const left = await db.query(
    `SELECT (SELECT count(*) FROM profiles WHERE id = $1) + (SELECT count(*) FROM utterances WHERE profile_id = $1) + (SELECT count(*) FROM confirmations WHERE profile_id = $1)
          + (SELECT count(*) FROM phrases WHERE profile_id = $1) + (SELECT count(*) FROM aliases WHERE profile_id = $1) + (SELECT count(*) FROM access_tokens WHERE profile_id = $1) AS n`,
    [profileId],
  );
  if (Number(left.rows[0].n) !== 0) throw new Error(`deleting profile ${profileId} left ${left.rows[0].n} rows behind`);
  return { deleted: true };
}

/** For the public demo: profiles nobody has used for a while are removed. Returns how many. */
export async function sweepIdleProfiles(db: Db, ttlHours: number): Promise<number> {
  const r = await db.query("DELETE FROM profiles WHERE last_seen_at < now() - make_interval(hours => $1)", [ttlHours]);
  return r.rowCount ?? 0;
}
