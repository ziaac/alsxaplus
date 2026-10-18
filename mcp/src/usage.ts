// The spending limit. Every model call is recorded with an estimated cost, and a call is refused when the month's
// spending plus the worst case of the new call would pass the limit. If the spending cannot be read, the call is refused.
import type { BedrockSettings } from "./config.js";
import type { Db } from "./db.js";

const FIXED_INPUT_TOKENS = 700;

export const costUsd = (s: BedrockSettings, inputTokens: number, outputTokens: number): number =>
  (inputTokens * s.priceInputPerMtok + outputTokens * s.priceOutputPerMtok) / 1_000_000;

/** An upper bound for one call: every prompt character counted as a token, plus overhead, plus the whole output allowance. */
export const worstCaseUsd = (s: BedrockSettings, promptChars: number, maxOutputTokens: number): number =>
  costUsd(s, promptChars + FIXED_INPUT_TOKENS, maxOutputTokens);

export async function monthSpendUsd(db: Db): Promise<number> {
  const r = await db.query(
    `SELECT COALESCE(sum(estimated_usd), 0)::float8 AS spent FROM model_usage
     WHERE created_at >= date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`,
  );
  return Number(r.rows[0]?.spent ?? 0);
}

/** Null when the call may go ahead, otherwise the reason it must not. */
export async function refusalReason(db: Db, s: BedrockSettings, worstCase: number): Promise<string | null> {
  try {
    const spent = await monthSpendUsd(db);
    if (spent + worstCase <= s.monthlyLimitUsd) return null;
    console.warn(`[usage] model call refused: spent ${spent.toFixed(4)} of ${s.monthlyLimitUsd} USD this month`);
    return `budget_exceeded: spent ${spent.toFixed(4)} of ${s.monthlyLimitUsd.toFixed(2)} USD this month`;
  } catch (error) {
    console.error("[usage] could not read this month's spending, refusing the model call:", (error as Error).message);
    return `budget_unknown: ${(error as Error).message}`;
  }
}

export interface UsageEntry {
  profileId: string | null;
  purpose: string;
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  outcome: "ok" | "invalid_output" | "policy_violation" | "error";
  detail?: string;
  latencyMs?: number;
}

export async function recordUsage(db: Db, s: BedrockSettings, e: UsageEntry): Promise<void> {
  const cost = costUsd(s, e.inputTokens, e.outputTokens);
  try {
    await db.query(
      `INSERT INTO model_usage (profile_id, purpose, model_id, input_tokens, output_tokens, estimated_usd, outcome, detail, latency_ms)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [e.profileId, e.purpose, e.modelId, e.inputTokens, e.outputTokens, cost.toFixed(6), e.outcome, e.detail?.slice(0, 300) ?? null, e.latencyMs ?? null],
    );
  } catch (error) {
    // The call already happened and cannot be undone; the loss is logged loudly.
    console.error(`[usage] could not record model usage, this call is not counted against the limit (${cost.toFixed(6)} USD):`, (error as Error).message);
  }
}
