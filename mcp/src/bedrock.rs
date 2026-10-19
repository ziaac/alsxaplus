//! Amazon Bedrock through the Converse API with a Bedrock API key (bearer token). The model must answer by calling one
//! tool, which is the reliable way to get one JSON object back. Model id, region, key, prices and limits all come from
//! the environment, never from code.
use std::fmt;
use std::future::Future;
use std::pin::Pin;
use std::time::{Duration, Instant};

use anyhow::{Context, bail};
use serde_json::{Value, json};
use tracing::{info, warn};

#[derive(Clone)]
pub struct BedrockConfig {
    pub region: String,
    pub model_id: String,
    pub api_key: String,
    pub timeout: Duration,
    pub price_input_usd_per_mtok: f64,
    pub price_output_usd_per_mtok: f64,
    pub monthly_limit_usd: f64,
}

impl fmt::Debug for BedrockConfig {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("BedrockConfig")
            .field("region", &self.region)
            .field("model_id", &self.model_id)
            .field("api_key", &"<hidden>")
            .field("timeout", &self.timeout)
            .field("price_input_usd_per_mtok", &self.price_input_usd_per_mtok)
            .field("price_output_usd_per_mtok", &self.price_output_usd_per_mtok)
            .field("monthly_limit_usd", &self.monthly_limit_usd)
            .finish()
    }
}

fn required(name: &str) -> anyhow::Result<String> {
    let value = std::env::var(name).with_context(|| format!("{name} is not set"))?;
    if value.trim().is_empty() {
        bail!("{name} is empty");
    }
    Ok(value.trim().to_string())
}

fn positive(name: &str) -> anyhow::Result<f64> {
    let v: f64 = required(name)?.parse().with_context(|| format!("{name} must be a number"))?;
    if !v.is_finite() || v <= 0.0 {
        bail!("{name} must be greater than zero");
    }
    Ok(v)
}

impl BedrockConfig {
    /// `Ok(None)` when no API key is set: the rules then order the sentences alone. If the key is set, everything
    /// else must be set too, because a half-configured model that spends money without a limit is worse than none.
    pub fn from_env() -> anyhow::Result<Option<Self>> {
        let Ok(api_key) = std::env::var("AWS_BEARER_TOKEN_BEDROCK") else {
            return Ok(None);
        };
        if api_key.trim().is_empty() {
            return Ok(None);
        }
        Ok(Some(Self {
            region: required("AWS_REGION")?,
            model_id: required("BEDROCK_MODEL_ID")?,
            api_key: api_key.trim().to_string(),
            timeout: Duration::from_secs(positive("BEDROCK_TIMEOUT_SECONDS").unwrap_or(20.0) as u64),
            price_input_usd_per_mtok: positive("BEDROCK_PRICE_INPUT_USD_PER_MTOK")?,
            price_output_usd_per_mtok: positive("BEDROCK_PRICE_OUTPUT_USD_PER_MTOK")?,
            monthly_limit_usd: positive("BEDROCK_MONTHLY_LIMIT_USD")?,
        }))
    }

    pub fn endpoint(&self) -> String {
        format!("https://bedrock-runtime.{}.amazonaws.com/model/{}/converse", self.region, self.model_id)
    }
}

#[derive(Clone, Debug)]
pub struct ModelRequest {
    pub system: String,
    pub user: String,
    pub tool_name: &'static str,
    pub tool_description: &'static str,
    /// JSON Schema of the one tool the model must call. Its input is the model's whole answer.
    pub tool_schema: Value,
    pub max_tokens: u32,
}

#[derive(Clone, Debug)]
pub struct ModelReply {
    pub tool_input: Value,
    pub input_tokens: u32,
    pub output_tokens: u32,
    pub latency_ms: u32,
}

#[derive(Debug, Clone, thiserror::Error, PartialEq, Eq)]
pub enum ModelError {
    /// A timeout, throttling or a service hiccup. Worth another try.
    #[error("temporary failure: {0}")]
    Transient(String),
    /// A refusal, a bad request or a missing tool call. Trying again will not change the answer.
    #[error("permanent failure: {0}")]
    Permanent(String),
}

pub type ModelFuture<'a> = Pin<Box<dyn Future<Output = Result<ModelReply, ModelError>> + Send + 'a>>;

/// A language model, seen from the service. The trait lets tests use a scripted model and lets the real Bedrock
/// client be swapped without touching the rules.
pub trait Model: Send + Sync {
    fn model_id(&self) -> &str;
    fn call<'a>(&'a self, request: &'a ModelRequest) -> ModelFuture<'a>;
}

/// The Converse request body. Thinking is off and effort is low: the task is a small ranking, and a forced tool call
/// is the way to get one JSON object back.
pub fn build_body(request: &ModelRequest) -> Value {
    json!({
        "system": [{ "text": request.system }],
        "messages": [{ "role": "user", "content": [{ "text": request.user }] }],
        "inferenceConfig": { "maxTokens": request.max_tokens },
        "toolConfig": {
            "tools": [{ "toolSpec": {
                "name": request.tool_name,
                "description": request.tool_description,
                "inputSchema": { "json": request.tool_schema },
            }}],
            "toolChoice": { "tool": { "name": request.tool_name } },
        },
        "additionalModelRequestFields": {
            "thinking": { "type": "disabled" },
            "output_config": { "effort": "low" },
        },
    })
}

/// Which HTTP statuses are worth another try: timeouts, throttling and service trouble.
pub fn is_transient_status(status: u16) -> bool {
    matches!(status, 408 | 429 | 500 | 502 | 503 | 504 | 529)
}

pub fn parse_response(body: &Value, tool_name: &str, latency_fallback_ms: u32) -> Result<ModelReply, ModelError> {
    let stop = body["stopReason"].as_str().unwrap_or("unknown");
    let tool_input = body["output"]["message"]["content"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|block| block.get("toolUse"))
        .find(|tool| tool["name"] == tool_name)
        .map(|tool| tool["input"].clone())
        .ok_or_else(|| ModelError::Permanent(format!("the model did not call the tool (stopReason {stop})")))?;
    let tokens = |key: &str| body["usage"][key].as_u64().map_or(0, |n| n.min(u64::from(u32::MAX)) as u32);
    Ok(ModelReply {
        tool_input,
        input_tokens: tokens("inputTokens"),
        output_tokens: tokens("outputTokens"),
        latency_ms: body["metrics"]["latencyMs"].as_u64().map_or(latency_fallback_ms, |n| n as u32),
    })
}

pub struct BedrockModel {
    config: BedrockConfig,
    http: reqwest::Client,
}

impl BedrockModel {
    pub fn new(config: BedrockConfig) -> anyhow::Result<Self> {
        let http = reqwest::Client::builder()
            .timeout(config.timeout)
            .connect_timeout(Duration::from_secs(5))
            .build()
            .context("could not build the HTTP client")?;
        Ok(Self { config, http })
    }

    async fn call_once(&self, request: &ModelRequest) -> Result<ModelReply, ModelError> {
        let started = Instant::now();
        let response = self
            .http
            .post(self.config.endpoint())
            .bearer_auth(&self.config.api_key)
            .json(&build_body(request))
            .send()
            .await
            .map_err(|e| {
                // Never log the request: it carries the key in a header. The error text does not.
                let kind = if e.is_timeout() {
                    "timeout"
                } else if e.is_connect() {
                    "connect"
                } else {
                    "request"
                };
                let transient = e.is_timeout() || e.is_connect() || e.is_request();
                let why = format!("{} ({kind})", e.without_url());
                if transient { ModelError::Transient(why) } else { ModelError::Permanent(why) }
            })?;
        let status = response.status().as_u16();
        let text = response.text().await.map_err(|e| ModelError::Transient(format!("could not read the reply: {}", e.without_url())))?;
        let elapsed_ms = started.elapsed().as_millis().min(u128::from(u32::MAX)) as u32;
        if status != 200 {
            let snippet: String = text.chars().take(200).collect();
            let why = format!("Bedrock answered HTTP {status}: {snippet}");
            return Err(if is_transient_status(status) { ModelError::Transient(why) } else { ModelError::Permanent(why) });
        }
        let body: Value = serde_json::from_str(&text).map_err(|e| ModelError::Permanent(format!("the reply is not JSON: {e}")))?;
        let reply = parse_response(&body, request.tool_name, elapsed_ms)?;
        info!(model = %self.config.model_id, input_tokens = reply.input_tokens, output_tokens = reply.output_tokens, latency_ms = reply.latency_ms, "bedrock call finished");
        Ok(reply)
    }
}

impl Model for BedrockModel {
    fn model_id(&self) -> &str {
        &self.config.model_id
    }

    fn call<'a>(&'a self, request: &'a ModelRequest) -> ModelFuture<'a> {
        Box::pin(self.call_once(request))
    }
}

/// Retries are only for temporary failures, are limited, and every wait is logged.
#[derive(Clone, Copy, Debug)]
pub struct RetryPolicy {
    pub max_retries: u32,
    pub base_delay: Duration,
}

impl Default for RetryPolicy {
    fn default() -> Self {
        Self { max_retries: 2, base_delay: Duration::from_millis(500) }
    }
}

/// Returns the final result and how many retries were used.
pub async fn call_with_retries(model: &dyn Model, request: &ModelRequest, policy: &RetryPolicy) -> (Result<ModelReply, ModelError>, u32) {
    let mut retries = 0;
    loop {
        match model.call(request).await {
            Ok(reply) => return (Ok(reply), retries),
            Err(ModelError::Transient(why)) if retries < policy.max_retries => {
                let delay = policy.base_delay * 2u32.pow(retries);
                retries += 1;
                warn!(attempt = retries, max_retries = policy.max_retries, delay_ms = delay.as_millis() as u64, %why, "model call failed temporarily, retrying");
                tokio::time::sleep(delay).await;
            }
            Err(error) => return (Err(error), retries),
        }
    }
}

/// A model that answers from a script, one entry per call. For tests.
pub mod testing {
    use std::sync::Mutex;

    use super::*;

    pub struct Scripted {
        script: Mutex<Vec<Result<ModelReply, ModelError>>>,
        calls: Mutex<u32>,
    }

    impl Scripted {
        pub fn new(script: Vec<Result<ModelReply, ModelError>>) -> Self {
            Self { script: Mutex::new(script.into_iter().rev().collect()), calls: Mutex::new(0) }
        }

        pub fn reply(input: Value) -> Result<ModelReply, ModelError> {
            Ok(ModelReply { tool_input: input, input_tokens: 600, output_tokens: 90, latency_ms: 800 })
        }

        pub fn calls(&self) -> u32 {
            *self.calls.lock().unwrap()
        }
    }

    impl Model for Scripted {
        fn model_id(&self) -> &str {
            "scripted-model"
        }

        fn call<'a>(&'a self, _request: &'a ModelRequest) -> ModelFuture<'a> {
            *self.calls.lock().unwrap() += 1;
            let next = self.script.lock().unwrap().pop().unwrap_or_else(|| Err(ModelError::Permanent("script is empty".to_string())));
            Box::pin(async move { next })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::testing::Scripted;
    use super::*;

    fn request() -> ModelRequest {
        ModelRequest { system: "sys".into(), user: "usr".into(), tool_name: "record_order", tool_description: "d", tool_schema: json!({"type":"object"}), max_tokens: 300 }
    }

    #[test]
    fn the_body_forces_the_tool_and_turns_thinking_off() {
        let body = build_body(&request());
        assert_eq!(body["toolConfig"]["toolChoice"]["tool"]["name"], "record_order");
        assert_eq!(body["additionalModelRequestFields"]["thinking"]["type"], "disabled");
        assert_eq!(body["additionalModelRequestFields"]["output_config"]["effort"], "low");
        assert!(body["inferenceConfig"].get("temperature").is_none());
        assert_eq!(body["inferenceConfig"]["maxTokens"], 300);
    }

    #[test]
    fn parses_a_tool_use_reply_and_rejects_a_reply_without_one() {
        let body = json!({
            "output": { "message": { "content": [{ "toolUse": { "name": "record_order", "input": { "choices": [{ "id": "b1" }] } } }] } },
            "stopReason": "tool_use",
            "usage": { "inputTokens": 612, "outputTokens": 41 },
            "metrics": { "latencyMs": 1431 }
        });
        let reply = parse_response(&body, "record_order", 9).unwrap();
        assert_eq!((reply.input_tokens, reply.output_tokens, reply.latency_ms), (612, 41, 1431));
        assert_eq!(reply.tool_input["choices"][0]["id"], "b1");
        let none = json!({ "output": { "message": { "content": [{ "text": "hello" }] } }, "stopReason": "end_turn" });
        assert!(matches!(parse_response(&none, "record_order", 9), Err(ModelError::Permanent(m)) if m.contains("end_turn")));
    }

    #[test]
    fn only_temporary_statuses_are_worth_a_retry() {
        for s in [408, 429, 500, 502, 503, 504, 529] {
            assert!(is_transient_status(s), "{s}");
        }
        for s in [400, 401, 403, 404, 422] {
            assert!(!is_transient_status(s), "{s}");
        }
    }

    #[tokio::test]
    async fn retries_temporary_failures_a_limited_number_of_times_and_never_permanent_ones() {
        let fast = RetryPolicy { max_retries: 2, base_delay: Duration::from_millis(1) };
        let model = Scripted::new(vec![Err(ModelError::Transient("429".into())), Err(ModelError::Transient("429".into())), Scripted::reply(json!({}))]);
        let (result, retries) = call_with_retries(&model, &request(), &fast).await;
        assert!(result.is_ok());
        assert_eq!((retries, model.calls()), (2, 3));

        let model = Scripted::new(vec![Err(ModelError::Transient("a".into())); 5]);
        let (result, retries) = call_with_retries(&model, &request(), &fast).await;
        assert!(result.is_err());
        assert_eq!((retries, model.calls()), (2, 3));

        let model = Scripted::new(vec![Err(ModelError::Permanent("400".into())), Scripted::reply(json!({}))]);
        let (result, retries) = call_with_retries(&model, &request(), &fast).await;
        assert!(result.is_err());
        assert_eq!((retries, model.calls()), (0, 1));
    }
}
