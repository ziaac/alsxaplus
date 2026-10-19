//! The service against a real PostgreSQL database (TEST_DATABASE_URL). Without it the tests say so and pass, so a
//! machine with no database can still run `cargo test`. The model is a scripted stand-in, never the real one.
use std::sync::Arc;
use std::time::Duration;

use alsxaplus_mcp::auth::create_profile;
use alsxaplus_mcp::bedrock::testing::Scripted;
use alsxaplus_mcp::bedrock::{BedrockConfig, ModelError, RetryPolicy};
use alsxaplus_mcp::service::{HeardArg, Service, ServiceError};
use serde_json::{Value, json};
use sqlx::{PgPool, postgres::PgPoolOptions, types::Uuid};

async fn pool() -> Option<PgPool> {
    let Ok(url) = std::env::var("TEST_DATABASE_URL") else {
        eprintln!("TEST_DATABASE_URL is not set: the database tests are skipped");
        return None;
    };
    let pool = PgPoolOptions::new().max_connections(4).connect(&url).await.expect("the test database is reachable");
    sqlx::migrate!("./migrations").run(&pool).await.expect("migrations apply");
    Some(pool)
}

fn bedrock(limit: f64) -> BedrockConfig {
    BedrockConfig {
        region: "test".into(),
        model_id: "scripted-model".into(),
        api_key: "not-a-key".into(),
        timeout: Duration::from_secs(1),
        price_input_usd_per_mtok: 0.10,
        price_output_usd_per_mtok: 0.50,
        monthly_limit_usd: limit,
    }
}

fn fast() -> RetryPolicy {
    RetryPolicy { max_retries: 2, base_delay: Duration::from_millis(1) }
}

fn heard(text: &str, confidence: f64) -> Vec<HeardArg> {
    vec![HeardArg { text: text.into(), confidence: Some(confidence) }]
}

async fn person(pool: &PgPool) -> Uuid {
    create_profile(pool).await.expect("a profile opens").0
}

async fn ready(service: &Service, id: Uuid) {
    service.set_consent(id, true).await.unwrap();
    service.set_speech_support(id, true).await.unwrap();
}

fn texts(v: &Value) -> Vec<String> {
    v["options"].as_array().unwrap().iter().map(|o| o["text"].as_str().unwrap().to_string()).collect()
}

#[tokio::test]
async fn nothing_works_without_consent_and_the_question_comes_only_after_unclear_speech() {
    let Some(pool) = pool().await else { return };
    let service = Service::new(pool.clone(), None).unwrap();
    let id = person(&pool).await;

    let err = service.suggest_meanings(id, &heard("wa er", 0.4)).await.unwrap_err();
    assert!(matches!(err, ServiceError::ConsentRequired));
    service.set_consent(id, true).await.unwrap();

    // Clear speech is understood, nothing is asked, nothing is switched on.
    let clear = [HeardArg { text: "I need some water".into(), confidence: Some(0.97) }, HeardArg { text: "i need some water.".into(), confidence: Some(0.95) }];
    assert_eq!(service.suggest_meanings(id, &clear).await.unwrap()["status"], "no_help_needed");
    assert_eq!(service.get_status(id).await.unwrap().speech_support, None);

    // Unsure words: the person is asked, and the estimate itself changes nothing.
    let asked = service.suggest_meanings(id, &heard("wa er", 0.4)).await.unwrap();
    assert_eq!(asked["status"], "needs_speech_support_answer");
    assert_eq!(asked["reasons"], json!(["low_confidence"]));
    assert_eq!(service.get_status(id).await.unwrap().speech_support, None);

    // Only the person's answer turns it on.
    assert_eq!(service.set_speech_support(id, true).await.unwrap().speech_support, Some(true));
    let ok = service.suggest_meanings(id, &heard("wa er", 0.4)).await.unwrap();
    assert_eq!(ok["status"], "ok");
    assert_eq!(texts(&ok).len(), 6);
    assert_eq!(ok["recommended"], ok["options"][0]["text"]);
    assert_eq!(ok["others"].as_array().unwrap().len(), 5);
    assert_eq!(ok["source"], "rule");
    service.delete_everything(id).await.unwrap();
}

#[tokio::test]
async fn it_learns_what_a_persons_sounds_mean_and_keeps_it_to_that_person() {
    let Some(pool) = pool().await else { return };
    let service = Service::new(pool.clone(), None).unwrap();
    let (a, b) = (person(&pool).await, person(&pool).await);
    ready(&service, a).await;
    ready(&service, b).await;

    let first = service.suggest_meanings(a, &heard("uh oh ee", 0.3)).await.unwrap();
    let typed = service.confirm_meaning(a, first["utterance_id"].as_str().unwrap(), None, Some("Please bring me a blanket")).await.unwrap();
    assert_eq!((typed["kind"].as_str(), typed["uses"].as_i64(), typed["learned_sounds"].as_i64()), (Some("typed"), Some(1), Some(1)));

    // The same sounds later: that sentence is now the recommended one.
    let second = service.suggest_meanings(a, &heard("uh oh ee", 0.3)).await.unwrap();
    assert_eq!(second["recommended"], "Please bring me a blanket");
    let again = service.confirm_meaning(a, second["utterance_id"].as_str().unwrap(), Some(0), None).await.unwrap();
    assert_eq!((again["kind"].as_str(), again["uses"].as_i64()), (Some("suggested"), Some(2)));

    // Another person with the same sounds learned nothing from this.
    let other = service.suggest_meanings(b, &heard("uh oh ee", 0.3)).await.unwrap();
    assert!(!texts(&other).contains(&"Please bring me a blanket".to_string()));
    assert!(service.list_phrases(b, 20).await.unwrap().is_empty());
    assert_eq!(service.list_phrases(a, 20).await.unwrap()[0], json!({ "text": "Please bring me a blanket", "uses": 2 }));

    // Forgetting a sentence also forgets the sounds that pointed to it.
    assert_eq!(service.forget_phrase(a, "Please bring me a blanket").await.unwrap()["removed"], true);
    assert_eq!(service.get_status(a).await.unwrap().learned_sounds, 0);
    let after = service.suggest_meanings(a, &heard("uh oh ee", 0.3)).await.unwrap();
    assert_ne!(after["recommended"], "Please bring me a blanket");
    service.delete_everything(a).await.unwrap();
    service.delete_everything(b).await.unwrap();
}

#[tokio::test]
async fn the_same_suggestion_is_confirmed_once_and_bad_input_gets_a_readable_error() {
    let Some(pool) = pool().await else { return };
    let service = Service::new(pool.clone(), None).unwrap();
    let id = person(&pool).await;
    ready(&service, id).await;

    let s = service.suggest_meanings(id, &heard("i thirsty", 0.5)).await.unwrap();
    let uid = s["utterance_id"].as_str().unwrap();
    let one = service.confirm_meaning(id, uid, Some(1), None).await.unwrap();
    assert_eq!(one["already_confirmed"], false);
    let two = service.confirm_meaning(id, uid, Some(3), None).await.unwrap();
    assert_eq!((two["already_confirmed"].clone(), two["text"].clone()), (json!(true), one["text"].clone()));

    let fresh = service.suggest_meanings(id, &heard("hello", 0.5)).await.unwrap();
    let fid = fresh["utterance_id"].as_str().unwrap();
    for (utterance, option, typed) in [(fid, None, None), (fid, Some(1), Some("x")), ("not-an-id", Some(1), None), ("00000000-0000-4000-8000-000000000000", Some(1), None), (fid, Some(9), None), (fid, None, Some("!!!"))] {
        let err = service.confirm_meaning(id, utterance, option, typed).await.unwrap_err();
        assert!(matches!(err, ServiceError::InvalidArgument(_) | ServiceError::NotFound(_)), "{utterance} {option:?} {typed:?}: {err}");
    }
    let none = service.suggest_meanings(id, &[]).await.unwrap();
    assert_eq!(none["heard_nothing"], true);
    assert_eq!(texts(&none).len(), 6);
    service.delete_everything(id).await.unwrap();
}

#[tokio::test]
async fn saying_no_gives_no_suggestions_until_it_is_turned_on() {
    let Some(pool) = pool().await else { return };
    let service = Service::new(pool.clone(), None).unwrap();
    let id = person(&pool).await;
    service.set_consent(id, true).await.unwrap();
    service.set_speech_support(id, false).await.unwrap();
    assert_eq!(service.suggest_meanings(id, &heard("hello", 0.5)).await.unwrap()["status"], "speech_support_off");
    service.set_speech_support(id, true).await.unwrap();
    assert_eq!(service.suggest_meanings(id, &heard("hello", 0.5)).await.unwrap()["status"], "ok");
    service.delete_everything(id).await.unwrap();
}

#[tokio::test]
async fn deleting_everything_leaves_nothing_of_the_person_and_idle_profiles_are_swept() {
    let Some(pool) = pool().await else { return };
    let service = Service::new(pool.clone(), None).unwrap();
    let id = person(&pool).await;
    ready(&service, id).await;
    let s = service.suggest_meanings(id, &heard("hello there", 0.5)).await.unwrap();
    service.confirm_meaning(id, s["utterance_id"].as_str().unwrap(), Some(0), None).await.unwrap();
    assert_eq!(service.delete_everything(id).await.unwrap(), json!({ "deleted": true }));
    assert!(matches!(service.get_status(id).await, Err(ServiceError::NotFound(_))));

    let idle = person(&pool).await;
    sqlx::query("UPDATE profiles SET last_seen_at = now() - interval '3 days' WHERE id = $1").bind(idle).execute(&pool).await.unwrap();
    assert!(service.sweep_idle_profiles(24).await.unwrap() >= 1);
    assert!(matches!(service.get_status(idle).await, Err(ServiceError::NotFound(_))));
}

async fn usage_outcomes(pool: &PgPool, id: Uuid) -> Vec<String> {
    sqlx::query_scalar("SELECT outcome FROM model_usage WHERE profile_id = $1 ORDER BY created_at, id").bind(id).fetch_all(pool).await.unwrap()
}

#[tokio::test]
async fn a_valid_order_from_the_model_is_used_and_its_cost_is_recorded() {
    let Some(pool) = pool().await else { return };
    let model = Arc::new(Scripted::new(vec![Scripted::reply(json!({ "choices": [{ "id": "b3" }, { "id": "b1" }] }))]));
    let service = Service::new(pool.clone(), None).unwrap().with_model(model.clone(), bedrock(20.0), fast());
    let id = person(&pool).await;
    ready(&service, id).await;

    let out = service.suggest_meanings(id, &heard("i want wa er", 0.4)).await.unwrap();
    assert_eq!((out["source"].as_str(), out["fallback_reason"].is_null()), (Some("agent"), true));
    assert_eq!(out["options"][0]["text"], alsxaplus_mcp::phrasebank::core_phrases()[2]);
    assert_eq!(model.calls(), 1);
    assert_eq!(usage_outcomes(&pool, id).await, ["ok"]);
    let cost: f64 = sqlx::query_scalar("SELECT estimated_usd::float8 FROM model_usage WHERE profile_id = $1").bind(id).fetch_one(&pool).await.unwrap();
    assert!((cost - (600.0 * 0.10 + 90.0 * 0.50) / 1_000_000.0).abs() < 1e-9, "cost {cost}");
    service.delete_everything(id).await.unwrap();
}

#[tokio::test]
async fn an_empty_answer_is_asked_for_once_more_and_then_the_rules_decide() {
    let Some(pool) = pool().await else { return };
    let id;
    {
        let model = Arc::new(Scripted::new(vec![Scripted::reply(json!({})), Scripted::reply(json!({ "choices": [{ "id": "b2" }] }))]));
        let service = Service::new(pool.clone(), None).unwrap().with_model(model.clone(), bedrock(20.0), fast());
        id = person(&pool).await;
        ready(&service, id).await;
        let out = service.suggest_meanings(id, &heard("tank oo", 0.4)).await.unwrap();
        assert_eq!(out["source"], "agent");
        assert_eq!(model.calls(), 2);
        assert_eq!(usage_outcomes(&pool, id).await, ["invalid_output", "ok"]);
    }
    let model = Arc::new(Scripted::new(vec![Scripted::reply(json!({})), Scripted::reply(json!({}))]));
    let service = Service::new(pool.clone(), None).unwrap().with_model(model.clone(), bedrock(20.0), fast());
    let out = service.suggest_meanings(id, &heard("tank oo", 0.4)).await.unwrap();
    assert_eq!(out["source"], "rule");
    assert!(out["fallback_reason"].as_str().unwrap().starts_with("policy_violation"));
    assert_eq!(texts(&out).len(), 6);
    service.delete_everything(id).await.unwrap();
}

#[tokio::test]
async fn an_order_that_breaks_the_policy_or_a_failing_model_falls_back_to_the_rules() {
    let Some(pool) = pool().await else { return };
    let id = person(&pool).await;
    for (reply, expect) in [
        (Scripted::reply(json!({ "choices": [{ "id": "zzz" }] })), "policy_violation"),
        (Err(ModelError::Permanent("HTTP 400".into())), "model_error"),
    ] {
        let model = Arc::new(Scripted::new(vec![reply]));
        let service = Service::new(pool.clone(), None).unwrap().with_model(model, bedrock(20.0), fast());
        ready(&service, id).await;
        let out = service.suggest_meanings(id, &heard("ah in pay", 0.4)).await.unwrap();
        assert_eq!(out["source"], "rule");
        assert!(out["fallback_reason"].as_str().unwrap().starts_with(expect), "{out}");
        assert_eq!(texts(&out).len(), 6);
    }
    assert_eq!(usage_outcomes(&pool, id).await, ["policy_violation", "error"]);
    Service::new(pool.clone(), None).unwrap().delete_everything(id).await.unwrap();
}

#[tokio::test]
async fn a_call_that_would_pass_the_monthly_limit_is_refused_before_it_is_made() {
    let Some(pool) = pool().await else { return };
    let model = Arc::new(Scripted::new(vec![Scripted::reply(json!({ "choices": [{ "id": "b1" }] }))]));
    let service = Service::new(pool.clone(), None).unwrap().with_model(model.clone(), bedrock(0.000_000_1), fast());
    let id = person(&pool).await;
    ready(&service, id).await;
    let out = service.suggest_meanings(id, &heard("tank oo", 0.4)).await.unwrap();
    assert_eq!(out["source"], "rule");
    assert!(out["fallback_reason"].as_str().unwrap().starts_with("budget_exceeded"), "{out}");
    assert_eq!(model.calls(), 0);
    service.delete_everything(id).await.unwrap();
}
