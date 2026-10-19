//! Deepgram speech to text, used by the measurement programs. Three recognisers listen to the same recording and all
//! their distinct guesses are used as evidence (the newer models return only one transcript, the older `base` three).
use std::time::Duration;

use anyhow::{Context, bail};
use serde_json::Value;

use crate::ranking::Heard;

#[derive(Clone)]
pub struct Deepgram {
    key: String,
    http: reqwest::Client,
}

impl Deepgram {
    pub fn from_env() -> anyhow::Result<Self> {
        let key = std::env::var("DEEPGRAM_API_KEY").context("DEEPGRAM_API_KEY is not set")?;
        if key.trim().is_empty() {
            bail!("DEEPGRAM_API_KEY is empty");
        }
        let http = reqwest::Client::builder().timeout(Duration::from_secs(30)).build().context("could not build the HTTP client")?;
        Ok(Self { key: key.trim().to_string(), http })
    }

    async fn listen(&self, model: &str, alternatives: u32, wav: &[u8]) -> anyhow::Result<Vec<Heard>> {
        let url = format!("https://api.deepgram.com/v1/listen?model={model}&language=en&alternatives={alternatives}&mip_opt_out=true");
        for attempt in 1..=3u64 {
            let response = self.http.post(&url).header("authorization", format!("Token {}", self.key)).header("content-type", "audio/wav").body(wav.to_vec()).send().await;
            match response {
                Ok(r) if r.status().is_success() => {
                    let json: Value = r.json().await.context("Deepgram's answer is not JSON")?;
                    let alts = json["results"]["channels"][0]["alternatives"].as_array().cloned().unwrap_or_default();
                    return Ok(alts
                        .iter()
                        .map(|a| Heard {
                            text: a["transcript"].as_str().unwrap_or_default().trim_matches(|c: char| c.is_whitespace() || ".,!?;:".contains(c)).to_string(),
                            confidence: a["confidence"].as_f64().unwrap_or(0.0),
                        })
                        .filter(|h| !h.text.is_empty())
                        .collect());
                }
                Ok(r) if ![429, 502, 503, 504].contains(&r.status().as_u16()) || attempt == 3 => bail!("Deepgram {model} answered HTTP {}", r.status().as_u16()),
                Err(e) if attempt == 3 => bail!("Deepgram {model} failed: {}", e.without_url()),
                _ => tokio::time::sleep(Duration::from_millis(500 * attempt)).await,
            }
        }
        Ok(Vec::new())
    }

    /// What the three recognisers heard, most confident first, at most five distinct guesses.
    pub async fn ensemble(&self, wav: &[u8]) -> Vec<Heard> {
        let (a, b, c) = tokio::join!(self.listen("nova-3", 1, wav), self.listen("nova-2", 1, wav), self.listen("base", 3, wav));
        let mut out: Vec<Heard> = Vec::new();
        for part in [a, b, c] {
            let Ok(list) = part else { continue };
            for h in list {
                if !out.iter().any(|o| o.text.to_lowercase() == h.text.to_lowercase()) {
                    out.push(h);
                }
            }
        }
        out.sort_by(|x, y| y.confidence.partial_cmp(&x.confidence).unwrap_or(std::cmp::Ordering::Equal));
        out.truncate(5);
        out
    }
}
