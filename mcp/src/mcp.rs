//! The MCP tools. Each tool is a thin wrapper over `Service`, bound to the person whose token opened the request, so
//! a tool can only ever see that person's data. Consent and deleting data are not tools on purpose: a voice assistant
//! must never be able to give consent for someone or erase their data. Those are plain app actions.
//! Transport is Streamable HTTP, protocol 2025-11-25 (the revision the Alexa+ documentation names).
use std::borrow::Cow;

use rmcp::{
    ErrorData as McpError, RoleServer, ServerHandler,
    handler::server::{router::tool::ToolRouter, wrapper::Parameters},
    model::*,
    schemars,
    service::RequestContext,
    tool, tool_handler, tool_router,
};
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::types::Uuid;
use tracing::{error, info};

use crate::auth::ProfileId;
use crate::service::{HeardArg, Service, ServiceError};

const SUPPORTED_VERSIONS: &[ProtocolVersion] = &[ProtocolVersion::V_2025_11_25];

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct HeardItem {
    /// One transcript alternative, exactly as written by the recognizer.
    #[schemars(length(max = 200))]
    pub text: String,
    /// Recognizer confidence from 0 to 1, if known.
    #[schemars(range(min = 0.0, max = 1.0))]
    pub confidence: Option<f64>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct SetSpeechSupportArgs {
    /// True if the person said they have difficulty speaking and want suggestions.
    pub enabled: bool,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct SuggestArgs {
    /// What the recognizer heard, best first. May be empty if nothing was recognised.
    #[schemars(length(max = 5))]
    pub heard: Vec<HeardItem>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct ConfirmArgs {
    /// The id that suggest_meanings returned.
    pub utterance_id: String,
    /// The position of the chosen option, 0 for the recommended sentence.
    #[schemars(range(min = 0, max = 5))]
    pub option: Option<i64>,
    /// The sentence the person typed, if none of the options was right.
    #[schemars(length(max = 200))]
    pub typed_text: Option<String>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct ListArgs {
    #[schemars(range(min = 1, max = 50))]
    pub limit: Option<i64>,
}

#[derive(Clone)]
pub struct AlsxaServer {
    service: Service,
    tool_router: ToolRouter<Self>,
}

fn profile(ctx: &RequestContext<RoleServer>) -> Result<Uuid, CallToolResult> {
    ctx.extensions
        .get::<axum::http::request::Parts>()
        .and_then(|parts| parts.extensions.get::<ProfileId>().map(|p| p.0))
        .ok_or_else(|| {
            error!("a tool call reached the handler without an authenticated profile");
            failure("unauthorized", "You are not signed in.")
        })
}

fn failure(code: &str, message: &str) -> CallToolResult {
    let mut result = CallToolResult::error(vec![ContentBlock::text(message.to_string())]);
    result.structured_content = Some(json!({ "error": { "code": code, "message": message } }));
    result
}

fn finish(tool: &str, outcome: Result<Value, ServiceError>) -> CallToolResult {
    match outcome {
        Ok(value) => {
            let spoken = value["spoken"].as_str().unwrap_or("Done.").to_string();
            let mut result = CallToolResult::success(vec![ContentBlock::text(spoken)]);
            result.structured_content = Some(value);
            result
        }
        Err(err) => {
            match &err {
                ServiceError::Db(_) | ServiceError::Internal(_) => error!(tool, %err, "tool failed"),
                other => info!(tool, error = %other, "tool rejected the request"),
            }
            failure(err.code(), &err.public_message())
        }
    }
}

fn with_spoken(status: impl serde::Serialize, spoken: &str) -> Result<Value, ServiceError> {
    let mut value = serde_json::to_value(status).map_err(|e| ServiceError::Internal(e.to_string()))?;
    value["spoken"] = Value::String(spoken.to_string());
    Ok(value)
}

#[tool_router]
impl AlsxaServer {
    pub fn new(service: Service) -> Self {
        Self { service, tool_router: Self::tool_router() }
    }

    #[tool(
        description = "Tell whether the person has agreed to use ALSxaPlus and whether the question about difficulty speaking has been answered. Use it first in a conversation."
    )]
    async fn get_status(&self, ctx: RequestContext<RoleServer>) -> Result<CallToolResult, McpError> {
        let id = match profile(&ctx) {
            Ok(id) => id,
            Err(r) => return Ok(r),
        };
        let outcome = match self.service.get_status(id).await {
            Ok(status) => with_spoken(status, "Here is the current setting."),
            Err(e) => Err(e),
        };
        Ok(finish("get_status", outcome))
    }

    #[tool(
        description = "Record the person's answer to 'Do you have difficulty speaking?'. Ask it only once, when suggest_meanings says the speech was hard to understand (needs_speech_support_answer), and never again unless the person asks to change it. Never answer it on the person's behalf. enabled=true turns suggestions on for every later utterance."
    )]
    async fn set_speech_support(&self, Parameters(args): Parameters<SetSpeechSupportArgs>, ctx: RequestContext<RoleServer>) -> Result<CallToolResult, McpError> {
        let id = match profile(&ctx) {
            Ok(id) => id,
            Err(r) => return Ok(r),
        };
        let outcome = match self.service.set_speech_support(id, args.enabled).await {
            Ok(status) => with_spoken(
                status,
                if args.enabled { "Thank you. From now on I will offer sentences for what you say." } else { "Okay. I will listen as usual. You can change this at any time." },
            ),
            Err(e) => Err(e),
        };
        Ok(finish("set_speech_support", outcome))
    }

    #[tool(
        description = "Use this when a person who has difficulty speaking has said something. Pass every transcript alternative you have for what was heard, even if it looks wrong. Returns one recommended sentence and five others to show on the screen, best first. Read 'spoken' aloud, show the options, and let the person choose or type. Never act on a suggestion before the person confirms it."
    )]
    async fn suggest_meanings(&self, Parameters(args): Parameters<SuggestArgs>, ctx: RequestContext<RoleServer>) -> Result<CallToolResult, McpError> {
        let id = match profile(&ctx) {
            Ok(id) => id,
            Err(r) => return Ok(r),
        };
        let heard: Vec<HeardArg> = args.heard.into_iter().map(|h| HeardArg { text: h.text, confidence: h.confidence }).collect();
        Ok(finish("suggest_meanings", self.service.suggest_meanings(id, &heard).await))
    }

    #[tool(
        description = "Call this after the person chose one of the options (give option 0 to 5, where 0 is the recommended sentence) or typed their own sentence (give typed_text). The choice is saved so later suggestions fit this person better. Read 'spoken' aloud: it is the sentence the person meant to say."
    )]
    async fn confirm_meaning(&self, Parameters(args): Parameters<ConfirmArgs>, ctx: RequestContext<RoleServer>) -> Result<CallToolResult, McpError> {
        let id = match profile(&ctx) {
            Ok(id) => id,
            Err(r) => return Ok(r),
        };
        Ok(finish("confirm_meaning", self.service.confirm_meaning(id, &args.utterance_id, args.option, args.typed_text.as_deref()).await))
    }

    #[tool(description = "List the sentences this person has confirmed, most used first. Use it when the person asks what has been learned.")]
    async fn list_my_phrases(&self, Parameters(args): Parameters<ListArgs>, ctx: RequestContext<RoleServer>) -> Result<CallToolResult, McpError> {
        let id = match profile(&ctx) {
            Ok(id) => id,
            Err(r) => return Ok(r),
        };
        let outcome = match self.service.list_phrases(id, args.limit.unwrap_or(20)).await {
            Ok(phrases) => {
                let spoken = match phrases.first() {
                    Some(first) => format!("You have {} saved sentences. The most used is: {}.", phrases.len(), first["text"].as_str().unwrap_or_default()),
                    None => "Nothing has been saved yet.".to_string(),
                };
                Ok(json!({ "phrases": phrases, "spoken": spoken }))
            }
            Err(e) => Err(e),
        };
        Ok(finish("list_my_phrases", outcome))
    }
}

#[tool_handler(router = self.tool_router)]
impl ServerHandler for AlsxaServer {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(Implementation::new("alsxaplus", env!("CARGO_PKG_VERSION")))
            .with_protocol_version(ProtocolVersion::V_2025_11_25)
            .with_instructions(
                "ALSxaPlus helps a person whose speech is hard to understand say what they mean. Call get_status first. When the person \
                 has said something, pass every transcript alternative to suggest_meanings, read 'spoken' aloud, show the options, and \
                 let the person choose or type. Never act on a suggestion before the person confirms it with confirm_meaning. If \
                 suggest_meanings asks the speech question, ask the person and record their own answer with set_speech_support: never \
                 answer it for them.",
            )
    }

    fn supported_protocol_versions(&self) -> Cow<'static, [ProtocolVersion]> {
        Cow::Borrowed(SUPPORTED_VERSIONS)
    }
}
