//! What the server does for one person. Everything here is independent of MCP and HTTP, so it can be tested directly.
//! The sentence that is offered is only ever a suggestion: the person decides, and the person's choice is what is learned.
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::{PgPool, types::Uuid};
use tracing::{error, info, warn};

use crate::bedrock::{BedrockConfig, BedrockModel, Model, ModelError, ModelReply, ModelRequest, RetryPolicy, call_with_retries};
use crate::clarity::assess_clarity;
use crate::phrasebank::core_phrases;
use crate::ranking::{
    Alias, Candidate, Heard, MAX_OPTIONS, PersonalPhrase, apply_model_output, build_pool, fallback_rank, fill_up, shown_to_model,
};
use crate::text::normalize;
use crate::usage::{UsageEntry, record_usage, refusal_reason, worst_case_usd};

const MAX_HEARD: usize = 5;
const MAX_TEXT: usize = 200;
const TOOL_NAME: &str = "record_order";
const MAX_MODEL_TOKENS: u32 = 300;

#[derive(Debug, thiserror::Error)]
pub enum ServiceError {
    #[error("The person or their carer needs to agree in the app before anything is learned.")]
    ConsentRequired,
    #[error("{0}")]
    InvalidArgument(String),
    #[error("{0}")]
    NotFound(String),
    #[error("database error: {0}")]
    Db(#[from] sqlx::Error),
    #[error("{0}")]
    Internal(String),
}

impl ServiceError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::ConsentRequired => "consent_required",
            Self::InvalidArgument(_) => "invalid_argument",
            Self::NotFound(_) => "not_found",
            Self::Db(_) | Self::Internal(_) => "server_error",
        }
    }

    pub fn status(&self) -> u16 {
        match self {
            Self::ConsentRequired => 403,
            Self::InvalidArgument(_) => 400,
            Self::NotFound(_) => 404,
            Self::Db(_) | Self::Internal(_) => 500,
        }
    }

    /// What a person may read. Details of our own failures stay in the log.
    pub fn public_message(&self) -> String {
        match self {
            Self::Db(_) | Self::Internal(_) => "Something went wrong on our side. Please try again in a moment.".to_string(),
            other => other.to_string(),
        }
    }
}

fn bad(message: impl Into<String>) -> ServiceError {
    ServiceError::InvalidArgument(message.into())
}

/// Printable text only, one line, not too long.
pub fn clean_text(raw: &str, max: usize) -> String {
    let flat: String = raw.chars().map(|c| if c.is_control() { ' ' } else { c }).collect();
    flat.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(max).collect()
}

/// One transcript alternative as it arrives from a tool.
#[derive(Clone, Debug, Deserialize)]
pub struct HeardArg {
    pub text: String,
    pub confidence: Option<f64>,
}

pub fn clean_heard(input: &[HeardArg]) -> Vec<Heard> {
    let mut out: Vec<Heard> = Vec::new();
    for item in input.iter().take(MAX_HEARD) {
        let text = clean_text(&item.text, MAX_TEXT);
        let key = normalize(&text);
        if key.is_empty() || out.iter().any(|h| normalize(&h.text) == key) {
            continue;
        }
        let confidence = item.confidence.filter(|c| c.is_finite()).map_or(0.5, |c| c.clamp(0.0, 1.0));
        out.push(Heard { text, confidence });
    }
    out
}

#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct Status {
    pub consent: bool,
    pub speech_support: Option<bool>,
    pub phrases: i64,
    pub learned_sounds: i64,
}

#[derive(Clone)]
pub struct Service {
    pool: PgPool,
    model: Option<Arc<dyn Model>>,
    bedrock: Option<BedrockConfig>,
    retry: RetryPolicy,
}

const SYSTEM: &str = "You help a person with a speech disability say what they mean. \
A speech recognizer wrote down what it heard. For this person it is often wrong, but its mistakes are usually consistent: the same sounds are written the same wrong way. \
You are given what was heard and a list of candidate sentences with ids. Put the candidates in order, from the one the person most likely meant to the least likely. \
Prefer sentences the person has confirmed before (uses > 0) when they fit the sounds. A candidate with origin learned was confirmed for these very sounds, so it comes first. \
You may add at most two corrected sentences when what was heard is clearly a damaged version of a short everyday sentence. Keep a correction close to what was heard and use only words that appear in the candidates or in what was heard. \
Choose the order only. Do not add advice, medical information, or anything that the sounds do not suggest. \
Answer by calling the tool record_order. For a listed candidate give only its id. For a correction give only a text.";

/// The ids the model may use are listed in the schema itself, so an id that was not offered cannot even be named.
fn tool_schema(ids: &[String]) -> Value {
    json!({
        "type": "object",
        "properties": { "choices": {
            "type": "array", "minItems": 1, "maxItems": 8,
            "items": { "type": "object",
                "properties": { "id": { "type": "string", "enum": ids }, "text": { "type": "string", "maxLength": 120 } },
                "additionalProperties": false },
        }},
        "required": ["choices"],
        "additionalProperties": false,
    })
}

impl Service {
    pub fn new(pool: PgPool, bedrock: Option<BedrockConfig>) -> anyhow::Result<Self> {
        let model: Option<Arc<dyn Model>> = match &bedrock {
            Some(cfg) => Some(Arc::new(BedrockModel::new(cfg.clone())?)),
            None => None,
        };
        Ok(Self { pool, model, bedrock, retry: RetryPolicy::default() })
    }

    /// A service that uses the given model. For tests.
    pub fn with_model(mut self, model: Arc<dyn Model>, bedrock: BedrockConfig, retry: RetryPolicy) -> Self {
        self.model = Some(model);
        self.bedrock = Some(bedrock);
        self.retry = retry;
        self
    }

    pub fn pool(&self) -> &PgPool {
        &self.pool
    }

    pub async fn get_status(&self, profile: Uuid) -> Result<Status, ServiceError> {
        let row: Option<(bool, Option<bool>, i32, i32)> = sqlx::query_as(
            "SELECT consented_at IS NOT NULL, speech_support,
                    (SELECT count(*) FROM phrases WHERE profile_id = $1)::int,
                    (SELECT count(*) FROM aliases WHERE profile_id = $1)::int
             FROM profiles WHERE id = $1",
        )
        .bind(profile)
        .fetch_optional(&self.pool)
        .await?;
        let (consent, speech_support, phrases, learned) = row.ok_or_else(|| ServiceError::NotFound("The profile was not found.".into()))?;
        Ok(Status { consent, speech_support, phrases: i64::from(phrases), learned_sounds: i64::from(learned) })
    }

    pub async fn set_consent(&self, profile: Uuid, given: bool) -> Result<Status, ServiceError> {
        sqlx::query("UPDATE profiles SET consented_at = CASE WHEN $2 THEN COALESCE(consented_at, now()) END WHERE id = $1")
            .bind(profile)
            .bind(given)
            .execute(&self.pool)
            .await?;
        let status = self.get_status(profile).await?;
        if status.consent != given {
            return Err(ServiceError::Internal(format!("consent for {profile} was set to {given} but reads back as {}", status.consent)));
        }
        Ok(status)
    }

    async fn require_consent(&self, profile: Uuid) -> Result<Status, ServiceError> {
        let status = self.get_status(profile).await?;
        if !status.consent {
            return Err(ServiceError::ConsentRequired);
        }
        Ok(status)
    }

    /// Asked once. The answer stays with the profile, and the person can change it at any time.
    pub async fn set_speech_support(&self, profile: Uuid, enabled: bool) -> Result<Status, ServiceError> {
        self.require_consent(profile).await?;
        sqlx::query("UPDATE profiles SET speech_support = $2 WHERE id = $1").bind(profile).bind(enabled).execute(&self.pool).await?;
        let status = self.get_status(profile).await?;
        if status.speech_support != Some(enabled) {
            return Err(ServiceError::Internal(format!("speech support for {profile} did not read back as {enabled}")));
        }
        Ok(status)
    }

    pub async fn suggest_meanings(&self, profile: Uuid, heard_input: &[HeardArg]) -> Result<Value, ServiceError> {
        let status = self.require_consent(profile).await?;
        let heard = clean_heard(heard_input);
        match status.speech_support {
            None => {
                // Not asked yet. Only when what was heard looks unclear is the person asked, and only the person's answer
                // counts: the estimate is not stored and never switches anything on.
                let clarity = assess_clarity(&heard);
                if !clarity.unclear {
                    return Ok(json!({
                        "status": "no_help_needed",
                        "spoken": "I understood that, so I will carry on as usual. If it ever gets hard to understand you, I will ask whether you would like help.",
                    }));
                }
                return Ok(json!({
                    "status": "needs_speech_support_answer",
                    "reasons": clarity.reasons,
                    "spoken": "I had some trouble understanding that. Do you have difficulty speaking? Say yes or no. I will only ask once, and I will not assume anything.",
                }));
            }
            Some(false) => {
                return Ok(json!({
                    "status": "speech_support_off",
                    "spoken": "Speech support is off, so I will listen as usual. You can turn it on at any time.",
                }));
            }
            Some(true) => {}
        }

        let personal: Vec<PersonalPhrase> = sqlx::query_as::<_, (String, i32)>("SELECT text, uses FROM phrases WHERE profile_id = $1 ORDER BY uses DESC, last_used_at DESC LIMIT 40")
            .bind(profile)
            .fetch_all(&self.pool)
            .await?
            .into_iter()
            .map(|(text, uses)| PersonalPhrase { text, uses: i64::from(uses) })
            .collect();
        let keys: Vec<String> = heard.iter().map(|h| normalize(&h.text)).collect();
        let aliases: Vec<Alias> = if keys.is_empty() {
            Vec::new()
        } else {
            sqlx::query_as::<_, (String, String, i32)>("SELECT heard, text, uses FROM aliases WHERE profile_id = $1 AND heard = ANY($2::text[]) ORDER BY uses DESC LIMIT 10")
                .bind(profile)
                .bind(&keys)
                .fetch_all(&self.pool)
                .await?
                .into_iter()
                .map(|(heard, text, uses)| Alias { heard, text, uses: i64::from(uses) })
                .collect()
        };

        let pool = build_pool(&heard, &personal, &aliases, core_phrases());
        let mut ranked: Vec<Candidate> = fallback_rank(&pool, &heard, MAX_OPTIONS);
        let mut source = "rule";
        let mut fallback_reason: Option<String> = None;

        if heard.is_empty() {
            fallback_reason = Some("nothing_heard".into());
        } else if let (Some(model), Some(cfg)) = (self.model.as_ref(), self.bedrock.as_ref()) {
            let shown = shown_to_model(&pool, &heard);
            let user = json!({
                "heard": heard.iter().map(|h| json!({ "text": h.text, "confidence": h.confidence })).collect::<Vec<_>>(),
                "candidates": shown.iter().map(|c| json!({ "id": c.id, "text": c.text, "origin": c.origin.as_str(), "uses": c.uses })).collect::<Vec<_>>(),
            })
            .to_string();
            let ids: Vec<String> = shown.iter().map(|c| c.id.clone()).collect();
            let request = ModelRequest {
                system: SYSTEM.to_string(),
                user,
                tool_name: TOOL_NAME,
                tool_description: "Record the order of the candidate sentences.",
                tool_schema: tool_schema(&ids),
                max_tokens: MAX_MODEL_TOKENS,
            };
            let worst = worst_case_usd(cfg, SYSTEM.chars().count() + request.user.chars().count(), MAX_MODEL_TOKENS);
            if let Some(reason) = refusal_reason(&self.pool, cfg, worst).await {
                fallback_reason = Some(reason);
            } else {
                let usage = |outcome: &'static str, reply: Option<&ModelReply>, detail: Option<&str>| {
                    let (i, o, l) = reply.map_or((0, 0, None), |r| (r.input_tokens, r.output_tokens, Some(r.latency_ms)));
                    (outcome, i, o, l, detail.map(str::to_owned))
                };
                let record = |u: (&'static str, u32, u32, Option<u32>, Option<String>)| async move {
                    record_usage(
                        &self.pool,
                        cfg,
                        UsageEntry { profile_id: Some(profile), purpose: "suggest", model_id: model.model_id(), input_tokens: u.1, output_tokens: u.2, outcome: u.0, detail: u.4.as_deref(), latency_ms: u.3 },
                    )
                    .await;
                };
                let (first, _retries) = call_with_retries(model.as_ref(), &request, &self.retry).await;
                // A model now and then answers with an empty object. One more try is cheap; after that the rules decide.
                let empty = |r: &ModelReply| r.tool_input.as_object().is_none_or(|o| o.is_empty());
                let outcome: Result<ModelReply, ModelError> = match first {
                    Ok(reply) if empty(&reply) => {
                        warn!("the model answered with nothing, asking once more");
                        record(usage("invalid_output", Some(&reply), Some("empty tool input"))).await;
                        call_with_retries(model.as_ref(), &request, &self.retry).await.0
                    }
                    other => other,
                };
                match outcome {
                    Ok(reply) => match apply_model_output(&reply.tool_input, &shown, &pool, &heard) {
                        Ok(order) => {
                            ranked = order;
                            source = "agent";
                            record(usage("ok", Some(&reply), None)).await;
                        }
                        Err(violation) => {
                            warn!(%violation, "the model's order breaks the policy, the rules decide");
                            let reason = format!("policy_violation: {violation}");
                            record(usage("policy_violation", Some(&reply), Some(&reason))).await;
                            fallback_reason = Some(reason);
                        }
                    },
                    Err(err) => {
                        error!(%err, "the model could not be used, the rules decide");
                        let reason: String = format!("model_error: {err}").chars().take(300).collect();
                        record(usage("error", None, Some(&reason))).await;
                        fallback_reason = Some(reason);
                    }
                }
            }
        } else {
            fallback_reason = Some("model_not_configured".into());
        }
        ranked.truncate(MAX_OPTIONS);
        let ranked = fill_up(ranked, &pool, &heard);

        let options: Vec<Value> = ranked.iter().enumerate().map(|(i, c)| json!({ "rank": i, "text": c.text, "origin": c.origin.as_str() })).collect();
        let heard_json = serde_json::to_value(&heard).map_err(|e| ServiceError::Internal(e.to_string()))?;
        let reason_text: Option<String> = fallback_reason.as_ref().map(|r| r.chars().take(300).collect());
        let utterance_id: Uuid = sqlx::query_scalar("INSERT INTO utterances (profile_id, heard, candidates, source, fallback_reason) VALUES ($1, $2, $3, $4, $5) RETURNING id")
            .bind(profile)
            .bind(&heard_json)
            .bind(Value::Array(options.clone()))
            .bind(source)
            .bind(reason_text)
            .fetch_one(&self.pool)
            .await?;
        let stored: Option<i32> = sqlx::query_scalar("SELECT jsonb_array_length(candidates) FROM utterances WHERE id = $1 AND profile_id = $2")
            .bind(utterance_id)
            .bind(profile)
            .fetch_optional(&self.pool)
            .await?;
        if stored != Some(options.len() as i32) {
            return Err(ServiceError::Internal(format!("utterance {utterance_id} was not stored as offered")));
        }

        let recommended = ranked.first().map(|c| c.text.clone()).unwrap_or_default();
        let spoken = if heard.is_empty() {
            format!("I did not catch anything. Is it: {recommended}? You can pick another sentence or type it.")
        } else {
            format!("Did you mean: {recommended}? You can say yes, pick another sentence, or type it.")
        };
        Ok(json!({
            "status": "ok",
            "utterance_id": utterance_id.to_string(),
            "recommended": recommended,
            "others": ranked.iter().skip(1).map(|c| c.text.clone()).collect::<Vec<_>>(),
            "options": options,
            "source": source,
            "fallback_reason": fallback_reason,
            "heard_nothing": heard.is_empty(),
            "spoken": spoken,
        }))
    }

    pub async fn confirm_meaning(&self, profile: Uuid, utterance_id: &str, option: Option<i64>, typed_text: Option<&str>) -> Result<Value, ServiceError> {
        self.require_consent(profile).await?;
        let utterance: Uuid = utterance_id.parse().map_err(|_| bad("utterance_id must be the id that suggest_meanings returned."))?;
        let typed = typed_text.filter(|t| !t.is_empty());
        if option.is_some() == typed.is_some() {
            return Err(bad("Give either option (0 to 5) or typed_text, not both."));
        }

        let row: Option<(Value, Value)> = sqlx::query_as("SELECT heard, candidates FROM utterances WHERE id = $1 AND profile_id = $2")
            .bind(utterance)
            .bind(profile)
            .fetch_optional(&self.pool)
            .await?;
        let (heard_json, candidates) = row.ok_or_else(|| ServiceError::NotFound("That suggestion was not found.".into()))?;
        let options: Vec<String> = candidates.as_array().into_iter().flatten().filter_map(|o| o["text"].as_str().map(str::to_owned)).collect();
        let heard: Vec<Heard> = serde_json::from_value(heard_json).map_err(|e| ServiceError::Internal(format!("stored transcripts are unreadable: {e}")))?;

        let existing: Option<(String, String)> = sqlx::query_as("SELECT text, kind FROM confirmations WHERE utterance_id = $1").bind(utterance).fetch_optional(&self.pool).await?;
        if let Some((text, kind)) = existing {
            let uses: Option<i32> = sqlx::query_scalar("SELECT uses FROM phrases WHERE profile_id = $1 AND text = $2").bind(profile).bind(&text).fetch_optional(&self.pool).await?;
            let status = self.get_status(profile).await?;
            return Ok(json!({ "text": text, "kind": kind, "already_confirmed": true, "uses": uses.unwrap_or(1), "learned_sounds": status.learned_sounds, "spoken": text }));
        }

        let (text, kind, rank): (String, &str, Option<i16>) = if let Some(i) = option {
            let chosen = usize::try_from(i).ok().and_then(|n| options.get(n));
            let Some(chosen) = chosen else {
                return Err(bad(format!("option must be a whole number from 0 to {}.", options.len().saturating_sub(1))));
            };
            (chosen.clone(), if i == 0 { "suggested" } else { "alternative" }, Some(i as i16))
        } else {
            let text = clean_text(typed.unwrap_or_default(), MAX_TEXT);
            if normalize(&text).is_empty() {
                return Err(bad("typed_text needs letters or numbers."));
            }
            (text, "typed", None)
        };

        let mut tx = self.pool.begin().await?;
        sqlx::query("INSERT INTO confirmations (utterance_id, profile_id, text, kind, rank) VALUES ($1, $2, $3, $4, $5)")
            .bind(utterance)
            .bind(profile)
            .bind(&text)
            .bind(kind)
            .bind(rank)
            .execute(&mut *tx)
            .await?;
        sqlx::query("INSERT INTO phrases (profile_id, text) VALUES ($1, $2) ON CONFLICT (profile_id, text) DO UPDATE SET uses = phrases.uses + 1, last_used_at = now()")
            .bind(profile)
            .bind(&text)
            .execute(&mut *tx)
            .await?;
        // The sounds that were written down for this sentence now point to it. Up to three, most confident first.
        let mut by_confidence = heard.clone();
        by_confidence.sort_by(|a, b| b.confidence.partial_cmp(&a.confidence).unwrap_or(std::cmp::Ordering::Equal));
        let own = normalize(&text);
        let mut sounds: Vec<String> = Vec::new();
        for h in &by_confidence {
            let key = normalize(&h.text);
            if !key.is_empty() && key != own && !sounds.contains(&key) {
                sounds.push(key);
            }
        }
        for sound in sounds.into_iter().take(3) {
            sqlx::query(
                "INSERT INTO aliases (profile_id, heard, text) VALUES ($1, $2, $3)
                 ON CONFLICT (profile_id, heard, text) DO UPDATE SET uses = aliases.uses + 1, last_used_at = now()",
            )
            .bind(profile)
            .bind(sound)
            .bind(&text)
            .execute(&mut *tx)
            .await?;
        }
        tx.commit().await?;

        let back: Option<(String, i32)> = sqlx::query_as("SELECT c.text, p.uses FROM confirmations c JOIN phrases p ON p.profile_id = c.profile_id AND p.text = c.text WHERE c.utterance_id = $1")
            .bind(utterance)
            .fetch_optional(&self.pool)
            .await?;
        let uses = match back {
            Some((stored, uses)) if stored == text => uses,
            _ => return Err(ServiceError::Internal(format!("confirmation for {utterance} was not stored as chosen"))),
        };
        let status = self.get_status(profile).await?;
        info!(%profile, kind, "a sentence was confirmed");
        Ok(json!({ "text": text, "kind": kind, "already_confirmed": false, "uses": uses, "learned_sounds": status.learned_sounds, "spoken": text }))
    }

    pub async fn list_phrases(&self, profile: Uuid, limit: i64) -> Result<Vec<Value>, ServiceError> {
        let rows: Vec<(String, i32)> = sqlx::query_as("SELECT text, uses FROM phrases WHERE profile_id = $1 ORDER BY uses DESC, last_used_at DESC LIMIT $2")
            .bind(profile)
            .bind(limit.clamp(1, 200))
            .fetch_all(&self.pool)
            .await?;
        Ok(rows.into_iter().map(|(text, uses)| json!({ "text": text, "uses": uses })).collect())
    }

    /// Forgets one sentence, and the sounds that pointed to it.
    pub async fn forget_phrase(&self, profile: Uuid, text: &str) -> Result<Value, ServiceError> {
        let removed = sqlx::query("DELETE FROM phrases WHERE profile_id = $1 AND text = $2").bind(profile).bind(text).execute(&self.pool).await?.rows_affected();
        sqlx::query("DELETE FROM aliases WHERE profile_id = $1 AND text = $2").bind(profile).bind(text).execute(&self.pool).await?;
        let left: i64 = sqlx::query_scalar("SELECT (SELECT count(*) FROM phrases WHERE profile_id = $1 AND text = $2) + (SELECT count(*) FROM aliases WHERE profile_id = $1 AND text = $2)")
            .bind(profile)
            .bind(text)
            .fetch_one(&self.pool)
            .await?;
        if left != 0 {
            return Err(ServiceError::Internal("the phrase is still there after it was forgotten".into()));
        }
        Ok(json!({ "removed": removed > 0 }))
    }

    /// Deletes the profile and everything about it. Cost records stay, without the link to the person.
    pub async fn delete_everything(&self, profile: Uuid) -> Result<Value, ServiceError> {
        sqlx::query("DELETE FROM profiles WHERE id = $1").bind(profile).execute(&self.pool).await?;
        let left: i64 = sqlx::query_scalar(
            "SELECT (SELECT count(*) FROM profiles WHERE id = $1) + (SELECT count(*) FROM utterances WHERE profile_id = $1) + (SELECT count(*) FROM confirmations WHERE profile_id = $1)
                  + (SELECT count(*) FROM phrases WHERE profile_id = $1) + (SELECT count(*) FROM aliases WHERE profile_id = $1) + (SELECT count(*) FROM access_tokens WHERE profile_id = $1)",
        )
        .bind(profile)
        .fetch_one(&self.pool)
        .await?;
        if left != 0 {
            return Err(ServiceError::Internal(format!("deleting profile {profile} left {left} rows behind")));
        }
        Ok(json!({ "deleted": true }))
    }

    /// For the public demo: profiles nobody has used for a while are removed. Returns how many.
    pub async fn sweep_idle_profiles(&self, ttl_hours: i32) -> Result<u64, ServiceError> {
        Ok(sqlx::query("DELETE FROM profiles WHERE last_seen_at < now() - make_interval(hours => $1)").bind(ttl_hours).execute(&self.pool).await?.rows_affected())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_is_made_printable_one_line_and_short() {
        assert_eq!(clean_text("a\u{0}b\tc\n d", 200), "a b c d");
        assert_eq!(clean_text("  spaced   out  ", 200), "spaced out");
        assert_eq!(clean_text(&"x".repeat(250), 200).chars().count(), 200);
        assert_eq!(clean_text("0123456789abc", 10), "0123456789");
    }

    #[test]
    fn transcripts_are_cleaned_deduplicated_and_limited() {
        let arg = |t: &str, c: Option<f64>| HeardArg { text: t.into(), confidence: c };
        // Only the first five are read; of those, a repeat and an empty one are dropped.
        let out = clean_heard(&[arg("  hello   world  ", Some(0.9)), arg("Hello World!", Some(0.3)), arg("", Some(1.0)), arg("x", None), arg("y", Some(7.0)), arg("z", Some(0.2))]);
        let texts: Vec<&str> = out.iter().map(|h| h.text.as_str()).collect();
        assert_eq!(texts, ["hello world", "x", "y"]);
        assert_eq!(out.iter().map(|h| h.confidence).collect::<Vec<_>>(), [0.9, 0.5, 1.0]);
        assert_eq!(clean_heard(&[arg("n", Some(f64::NAN))])[0].confidence, 0.5);
        let many: Vec<HeardArg> = (0..8).map(|i| arg(&format!("w{i}"), Some(0.5))).collect();
        assert_eq!(clean_heard(&many).len(), MAX_HEARD);
    }

    #[test]
    fn errors_have_a_code_a_status_and_a_message_that_hides_our_own_failures() {
        assert_eq!((ServiceError::ConsentRequired.code(), ServiceError::ConsentRequired.status()), ("consent_required", 403));
        assert_eq!((bad("x").code(), bad("x").status()), ("invalid_argument", 400));
        let internal = ServiceError::Internal("secret detail".into());
        assert_eq!((internal.code(), internal.status()), ("server_error", 500));
        assert!(!internal.public_message().contains("secret"));
    }
}
