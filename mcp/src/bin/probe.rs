//! Sends damaged transcripts to the real model through the real service code, and reports what happened: how often the
//! model's order passed the policy, which sentence came first, tokens, cost and delay. It spends a little money: run it
//! on purpose. Usage (needs DATABASE_URL and the Bedrock variables): probe
use std::collections::BTreeMap;

use alsxaplus_mcp::auth::create_profile;
use alsxaplus_mcp::config::Config;
use alsxaplus_mcp::service::{HeardArg, Service};
use anyhow::{Context, bail};
use sqlx::postgres::PgPoolOptions;

/// [what a recogniser might write for a person with unclear speech, the sentence they meant]
const SAMPLES: [(&str, &str); 20] = [
    ("i nee wa er", "I need water"),
    ("ah hun ry", "I am hungry"),
    ("pees hep me", "Please help me eat"),
    ("tu urn off ligh", "Please turn off the light"),
    ("ah in pay", "I am in pain"),
    ("goo mawnin", "Good morning"),
    ("ah wan bed", "I want to go to bed"),
    ("cah my dawer", "Please call my daughter"),
    ("wha tie is it", "What time is it"),
    ("tank oo", "Thank you"),
    ("ah col", "I am cold"),
    ("ah tie", "I am tired"),
    ("pees pay mu", "Please play some music"),
    ("ah nee bath oom", "I need to use the bathroom"),
    ("no", "No"),
    ("bring me pil oh", "Please bring me a pillow"),
    ("i wan watch fim", "Let us watch a film"),
    ("ah wo ied", "I am worried"),
    ("oen win ow", "Please open the window"),
    ("whe my fone", "Where is my phone"),
];

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let _ = dotenvy::dotenv();
    let cfg = Config::from_env()?;
    if cfg.bedrock.is_none() {
        bail!("AWS_BEARER_TOKEN_BEDROCK is not set, so there is no model to probe");
    }
    let pool = PgPoolOptions::new().max_connections(4).connect(&cfg.database_url).await.context("could not connect to PostgreSQL")?;
    sqlx::migrate!("./migrations").run(&pool).await?;
    let service = Service::new(pool.clone(), cfg.bedrock.clone())?;
    let (profile, _) = create_profile(&pool).await?;
    service.set_consent(profile, true).await?;
    service.set_speech_support(profile, true).await?;
    let before: i64 = sqlx::query_scalar("SELECT count(*) FROM model_usage").fetch_one(&pool).await?;

    let (mut agent, mut top1, mut top6) = (0, 0, 0);
    let mut reasons: BTreeMap<String, u32> = BTreeMap::new();
    for (heard, meant) in SAMPLES {
        let r = service.suggest_meanings(profile, &[HeardArg { text: heard.into(), confidence: Some(0.4) }]).await?;
        anyhow::ensure!(r["status"] == "ok", "unexpected status {}", r["status"]);
        let source = r["source"].as_str().unwrap_or("?");
        if source == "agent" {
            agent += 1;
        } else {
            let why = r["fallback_reason"].as_str().unwrap_or("").split(':').next().unwrap_or("").to_string();
            *reasons.entry(why).or_default() += 1;
        }
        let texts: Vec<String> = r["options"].as_array().into_iter().flatten().filter_map(|o| o["text"].as_str().map(str::to_lowercase)).collect();
        let want = meant.to_lowercase();
        let (hit1, hit6) = (texts.first() == Some(&want), texts.contains(&want));
        top1 += u32::from(hit1);
        top6 += u32::from(hit6);
        println!(
            "{source:<5} {}  heard \"{heard}\" meant \"{meant}\" -> {} | {}",
            if hit1 { "TOP1" } else if hit6 { "top6" } else { "miss" },
            r["recommended"].as_str().unwrap_or(""),
            texts.iter().skip(1).take(3).cloned().collect::<Vec<_>>().join(" / ")
        );
    }
    let n = SAMPLES.len();
    let after: i64 = sqlx::query_scalar("SELECT count(*) FROM model_usage").fetch_one(&pool).await?;
    let usage: (i64, i64, i64, f64, i32, i32) = sqlx::query_as(
        "SELECT count(*), COALESCE(sum(input_tokens),0)::bigint, COALESCE(sum(output_tokens),0)::bigint, COALESCE(sum(estimated_usd),0)::float8,
                COALESCE(percentile_cont(0.5) WITHIN GROUP (ORDER BY latency_ms),0)::int, COALESCE(max(latency_ms),0)::int
         FROM (SELECT * FROM model_usage ORDER BY created_at DESC LIMIT $1) x",
    )
    .bind(after - before)
    .fetch_one(&pool)
    .await?;
    println!("\nsamples {n}: model order used {agent}, rules {} {reasons:?}", n - agent);
    println!("the sentence that was meant: first {top1} of {n}, among the six {top6} of {n}");
    println!("usage: calls {}, input tokens {}, output tokens {}, cost {:.6} USD, median {} ms, max {} ms", usage.0, usage.1, usage.2, usage.3, usage.4, usage.5);
    service.delete_everything(profile).await?;
    Ok(())
}
