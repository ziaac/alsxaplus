//! Settings come from the environment, never from code.
use std::net::SocketAddr;

use anyhow::{Context, bail};

use crate::bedrock::BedrockConfig;

#[derive(Clone, Debug)]
pub struct Config {
    pub database_url: String,
    pub bind_addr: SocketAddr,
    /// Shared secret that only the web app knows. It lets the web app open a profile for a visitor.
    pub service_key: String,
    /// Profiles that have not been used for this long are deleted (the public demo keeps nothing for long).
    pub profile_ttl_hours: i32,
    /// Host names the MCP endpoint accepts in the Host header (DNS rebinding protection).
    pub allowed_hosts: Vec<String>,
    /// Absent when no Bedrock key is set: the rules then order the sentences alone.
    pub bedrock: Option<BedrockConfig>,
}

fn required(name: &str) -> anyhow::Result<String> {
    let value = std::env::var(name).with_context(|| format!("{name} is not set"))?;
    if value.trim().is_empty() {
        bail!("{name} is empty");
    }
    Ok(value.trim().to_string())
}

pub fn default_allowed_hosts() -> Vec<String> {
    ["localhost", "127.0.0.1", "::1"].iter().map(|h| (*h).to_string()).collect()
}

impl Config {
    pub fn from_env() -> anyhow::Result<Self> {
        let port: u16 = match std::env::var("PORT") {
            Ok(p) if !p.trim().is_empty() => p.trim().parse().context("PORT must be a port number")?,
            _ => 8081,
        };
        let profile_ttl_hours: i32 = match std::env::var("PROFILE_TTL_HOURS") {
            Ok(h) if !h.trim().is_empty() => h.trim().parse().context("PROFILE_TTL_HOURS must be a whole number")?,
            _ => 24,
        };
        if profile_ttl_hours <= 0 {
            bail!("PROFILE_TTL_HOURS must be greater than zero");
        }
        let allowed_hosts = match std::env::var("ALLOWED_HOSTS") {
            Ok(list) => list.split(',').map(|h| h.trim().to_string()).filter(|h| !h.is_empty()).collect(),
            Err(_) => default_allowed_hosts(),
        };
        Ok(Self {
            database_url: required("DATABASE_URL")?,
            bind_addr: SocketAddr::from(([0, 0, 0, 0], port)),
            service_key: required("SERVICE_KEY")?,
            profile_ttl_hours,
            allowed_hosts,
            bedrock: BedrockConfig::from_env()?,
        })
    }
}
