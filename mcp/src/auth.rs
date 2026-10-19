//! Access tokens. A token belongs to one profile, is random, is shown once, and is stored only as a SHA-256 hash.
use axum::{
    Json,
    extract::{Request, State},
    http::{StatusCode, header::AUTHORIZATION},
    middleware::Next,
    response::{IntoResponse, Response},
};
use serde_json::json;
use sha2::{Digest, Sha256};
use sqlx::{PgPool, types::Uuid};
use tracing::{error, warn};

const TOKEN_DAYS: i32 = 30;

/// The profile a request is for. The authentication layer adds it to the request, and the tools read it from there.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ProfileId(pub Uuid);

pub fn hash_token(token: &str) -> Vec<u8> {
    Sha256::digest(token.as_bytes()).to_vec()
}

fn generate_token() -> anyhow::Result<String> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|e| anyhow::anyhow!("no secure random source: {e}"))?;
    let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    Ok(format!("als_{hex}"))
}

fn well_formed(token: &str) -> bool {
    token.len() == 68 && token.starts_with("als_") && token[4..].bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// Opens a profile and returns its first token. The token is returned only here.
pub async fn create_profile(pool: &PgPool) -> anyhow::Result<(Uuid, String)> {
    let token = generate_token()?;
    let mut tx = pool.begin().await?;
    let profile_id: Uuid = sqlx::query_scalar("INSERT INTO profiles DEFAULT VALUES RETURNING id").fetch_one(&mut *tx).await?;
    sqlx::query("INSERT INTO access_tokens (token_hash, profile_id, expires_at) VALUES ($1, $2, now() + make_interval(days => $3))")
        .bind(hash_token(&token))
        .bind(profile_id)
        .bind(TOKEN_DAYS)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    // Read back: the token must open the profile that was just made.
    match authenticate(pool, &token).await? {
        Some(back) if back == profile_id => Ok((profile_id, token)),
        _ => anyhow::bail!("the new token does not open the new profile"),
    }
}

/// The profile a token opens, or None if the token is unknown or has expired. Using a token counts as being seen.
pub async fn authenticate(pool: &PgPool, token: &str) -> Result<Option<Uuid>, sqlx::Error> {
    if !well_formed(token) {
        return Ok(None);
    }
    sqlx::query_scalar(
        "UPDATE profiles p SET last_seen_at = now()
         FROM access_tokens t
         WHERE t.profile_id = p.id AND t.token_hash = $1 AND t.expires_at > now()
         RETURNING p.id",
    )
    .bind(hash_token(token))
    .fetch_optional(pool)
    .await
}

fn unauthorized() -> Response {
    // No WWW-Authenticate header on a 401, as the Alexa+ documentation asks.
    (StatusCode::UNAUTHORIZED, Json(json!({ "error": "unauthorized", "message": "A valid bearer token is required." }))).into_response()
}

/// Rejects requests without a valid bearer token. On success the ProfileId is added to the request extensions.
pub async fn require_auth(State(pool): State<PgPool>, mut req: Request, next: Next) -> Response {
    let token = req
        .headers()
        .get(AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|h| h.strip_prefix("Bearer "))
        .map(|t| t.trim().to_owned());
    let Some(token) = token else {
        warn!(method = %req.method(), path = %req.uri().path(), "request refused: no bearer token");
        return unauthorized();
    };
    match authenticate(&pool, &token).await {
        Ok(Some(id)) => {
            req.extensions_mut().insert(ProfileId(id));
            next.run(req).await
        }
        Ok(None) => {
            warn!(method = %req.method(), path = %req.uri().path(), "request refused: token unknown or expired");
            unauthorized()
        }
        Err(err) => {
            error!(%err, "token lookup failed");
            (StatusCode::SERVICE_UNAVAILABLE, Json(json!({ "error": "unavailable", "message": "Could not check the token right now." }))).into_response()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_well_formed_tokens_are_looked_up() {
        assert!(well_formed(&format!("als_{}", "a1".repeat(32))));
        assert!(!well_formed("als_short"));
        assert!(!well_formed(&format!("als_{}", "A1".repeat(32))));
        assert!(!well_formed(&format!("mt_{}", "a1".repeat(33))));
    }

    #[test]
    fn a_token_has_the_expected_shape_and_hash() {
        let token = generate_token().unwrap();
        assert!(well_formed(&token));
        assert_eq!(hash_token(&token).len(), 32);
        assert_ne!(token, generate_token().unwrap());
    }
}
