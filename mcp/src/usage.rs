//! The spending limit. Every model call is recorded with an estimated cost, and a call is refused when the month's
//! spending plus the worst case of the new call would pass the limit. If the spending cannot be read, the call is refused.
use sqlx::{PgPool, types::Uuid};
use tracing::{error, warn};

use crate::bedrock::BedrockConfig;

const FIXED_INPUT_TOKENS: f64 = 700.0;

pub fn cost_usd(c: &BedrockConfig, input_tokens: u32, output_tokens: u32) -> f64 {
    (f64::from(input_tokens) * c.price_input_usd_per_mtok + f64::from(output_tokens) * c.price_output_usd_per_mtok) / 1_000_000.0
}

/// An upper bound for one call: every prompt character counted as a token, plus overhead, plus the whole output allowance.
pub fn worst_case_usd(c: &BedrockConfig, prompt_chars: usize, max_output_tokens: u32) -> f64 {
    (((prompt_chars as f64) + FIXED_INPUT_TOKENS) * c.price_input_usd_per_mtok + f64::from(max_output_tokens) * c.price_output_usd_per_mtok) / 1_000_000.0
}

pub async fn month_spend_usd(pool: &PgPool) -> Result<f64, sqlx::Error> {
    sqlx::query_scalar(
        "SELECT COALESCE(sum(estimated_usd), 0)::float8 FROM model_usage
         WHERE created_at >= date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'",
    )
    .fetch_one(pool)
    .await
}

/// None when the call may go ahead, otherwise the reason it must not.
pub async fn refusal_reason(pool: &PgPool, c: &BedrockConfig, worst_case: f64) -> Option<String> {
    match month_spend_usd(pool).await {
        Ok(spent) if spent + worst_case <= c.monthly_limit_usd => None,
        Ok(spent) => {
            warn!(spent, limit = c.monthly_limit_usd, "model call refused: the monthly limit would be passed");
            Some(format!("budget_exceeded: spent {spent:.4} of {:.2} USD this month", c.monthly_limit_usd))
        }
        Err(err) => {
            error!(%err, "could not read this month's spending, refusing the model call");
            Some(format!("budget_unknown: {err}"))
        }
    }
}

pub struct UsageEntry<'a> {
    pub profile_id: Option<Uuid>,
    pub purpose: &'a str,
    pub model_id: &'a str,
    pub input_tokens: u32,
    pub output_tokens: u32,
    /// ok, invalid_output, policy_violation or error
    pub outcome: &'a str,
    pub detail: Option<&'a str>,
    pub latency_ms: Option<u32>,
}

pub async fn record_usage(pool: &PgPool, c: &BedrockConfig, e: UsageEntry<'_>) {
    let cost = cost_usd(c, e.input_tokens, e.output_tokens);
    let detail: Option<String> = e.detail.map(|d| d.chars().take(300).collect());
    let result = sqlx::query(
        "INSERT INTO model_usage (profile_id, purpose, model_id, input_tokens, output_tokens, estimated_usd, outcome, detail, latency_ms)
         VALUES ($1, $2, $3, $4, $5, CAST($6 AS float8), $7, $8, $9)",
    )
    .bind(e.profile_id)
    .bind(e.purpose)
    .bind(e.model_id)
    .bind(e.input_tokens as i32)
    .bind(e.output_tokens as i32)
    .bind(cost)
    .bind(e.outcome)
    .bind(detail)
    .bind(e.latency_ms.map(|n| n as i32))
    .execute(pool)
    .await;
    if let Err(err) = result {
        // The call already happened and cannot be undone; the loss is logged loudly.
        error!(%err, cost, "could not record model usage: this call is not counted against the limit");
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;

    fn cfg() -> BedrockConfig {
        BedrockConfig {
            region: "r".into(),
            model_id: "m".into(),
            api_key: "k".into(),
            timeout: Duration::from_secs(1),
            price_input_usd_per_mtok: 0.10,
            price_output_usd_per_mtok: 0.50,
            monthly_limit_usd: 20.0,
        }
    }

    #[test]
    fn cost_follows_the_prices_and_the_worst_case_is_an_upper_bound() {
        let c = cfg();
        assert!((cost_usd(&c, 1_000_000, 1_000_000) - 0.60).abs() < 1e-12);
        assert!(worst_case_usd(&c, 2000, 300) >= cost_usd(&c, 2000, 300));
    }
}
