//! The HTTP side: /mcp for assistants (MCP 2025-11-25, Streamable HTTP), /api/me for the person's own app actions,
//! and /internal for the web app that opens a profile for a visitor. Shared by the binary and the tests.
use axum::{
    Extension, Json, Router,
    extract::{DefaultBodyLimit, State},
    http::{HeaderMap, StatusCode},
    middleware,
    response::{IntoResponse, Response},
    routing::{get, post},
};
use rmcp::transport::streamable_http_server::{StreamableHttpServerConfig, StreamableHttpService, session::local::LocalSessionManager};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tracing::{error, info, warn};

use crate::auth::{ProfileId, create_profile, require_auth};
use crate::mcp::AlsxaServer;
use crate::service::{Service, ServiceError};

#[derive(Clone)]
struct AppState {
    service: Service,
    service_key: String,
}

impl IntoResponse for ServiceError {
    fn into_response(self) -> Response {
        match &self {
            ServiceError::Db(_) | ServiceError::Internal(_) => error!(error = %self, "request failed"),
            other => info!(error = %other, "request rejected"),
        }
        let status = StatusCode::from_u16(self.status()).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
        (status, Json(json!({ "error": self.code(), "message": self.public_message() }))).into_response()
    }
}

pub fn build_router(service: Service, service_key: String, allowed_hosts: Vec<String>) -> Router {
    let state = AppState { service: service.clone(), service_key };
    let pool = service.pool().clone();

    // Stateless: no session is kept between requests. Every request carries its own token, so a tool call needs no
    // handshake first, which is also what an assistant platform that calls tools directly expects.
    let mcp = StreamableHttpService::new(
        move || Ok(AlsxaServer::new(service.clone())),
        LocalSessionManager::default().into(),
        StreamableHttpServerConfig::default().with_legacy_session_mode(false).with_allowed_hosts(allowed_hosts),
    );

    // The person's own actions: consent and deleting data are here, not in the assistant's tools.
    let me = Router::new()
        .route("/api/me", get(status).delete(delete_me))
        .route("/api/me/consent", post(consent))
        .route("/api/me/phrases", get(phrases).delete(forget))
        .layer(DefaultBodyLimit::max(64 * 1024))
        .with_state(state.clone());
    let protected = Router::new().nest_service("/mcp", mcp).merge(me).layer(middleware::from_fn_with_state(pool, require_auth));

    Router::new()
        .route("/health", get(health))
        .route("/internal/profiles", post(open_profile))
        .with_state(state)
        .merge(protected)
}

async fn health(State(state): State<AppState>) -> (StatusCode, Json<Value>) {
    match sqlx::query_scalar::<_, i32>("SELECT 1").fetch_one(state.service.pool()).await {
        Ok(_) => (StatusCode::OK, Json(json!({ "status": "ok", "database": "up" }))),
        Err(err) => {
            error!(%err, "health check: the database query failed");
            (StatusCode::SERVICE_UNAVAILABLE, Json(json!({ "status": "degraded", "database": "down" })))
        }
    }
}

/// Compares two secrets without stopping at the first difference.
fn same_secret(a: &str, b: &str) -> bool {
    let (x, y) = (Sha256::digest(a.as_bytes()), Sha256::digest(b.as_bytes()));
    x.iter().zip(y.iter()).fold(0u8, |acc, (p, q)| acc | (p ^ q)) == 0
}

/// Only the web app, which knows the service key, can open a profile.
async fn open_profile(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let given = headers.get("x-service-key").and_then(|v| v.to_str().ok()).unwrap_or_default();
    if !same_secret(given, &state.service_key) {
        warn!("a request without the right service key was refused");
        return (StatusCode::UNAUTHORIZED, Json(json!({ "error": "unauthorized" }))).into_response();
    }
    match create_profile(state.service.pool()).await {
        Ok((profile_id, token)) => {
            info!(%profile_id, "profile opened");
            (StatusCode::CREATED, Json(json!({ "profile_id": profile_id.to_string(), "token": token }))).into_response()
        }
        Err(err) => ServiceError::Internal(err.to_string()).into_response(),
    }
}

async fn status(State(state): State<AppState>, Extension(ProfileId(id)): Extension<ProfileId>) -> Result<Json<crate::service::Status>, ServiceError> {
    Ok(Json(state.service.get_status(id).await?))
}

#[derive(Deserialize)]
struct ConsentBody {
    given: Option<bool>,
}

async fn consent(State(state): State<AppState>, Extension(ProfileId(id)): Extension<ProfileId>, Json(body): Json<ConsentBody>) -> Result<Json<crate::service::Status>, ServiceError> {
    let given = body.given.ok_or_else(|| ServiceError::InvalidArgument("given must be true or false.".into()))?;
    Ok(Json(state.service.set_consent(id, given).await?))
}

async fn phrases(State(state): State<AppState>, Extension(ProfileId(id)): Extension<ProfileId>) -> Result<Json<Value>, ServiceError> {
    Ok(Json(json!({ "phrases": state.service.list_phrases(id, 100).await? })))
}

#[derive(Deserialize)]
struct ForgetBody {
    text: Option<String>,
}

async fn forget(State(state): State<AppState>, Extension(ProfileId(id)): Extension<ProfileId>, Json(body): Json<ForgetBody>) -> Result<Json<Value>, ServiceError> {
    let text = body.text.filter(|t| !t.is_empty()).ok_or_else(|| ServiceError::InvalidArgument("text is required.".into()))?;
    Ok(Json(state.service.forget_phrase(id, &text).await?))
}

async fn delete_me(State(state): State<AppState>, Extension(ProfileId(id)): Extension<ProfileId>) -> Result<Json<Value>, ServiceError> {
    let out = state.service.delete_everything(id).await?;
    info!(profile = %id, "profile deleted by its owner");
    Ok(Json(out))
}

#[cfg(test)]
mod tests {
    use super::same_secret;

    #[test]
    fn secrets_are_compared_by_value() {
        assert!(same_secret("abc", "abc"));
        assert!(!same_secret("abc", "abd"));
        assert!(!same_secret("", "abc"));
    }
}
