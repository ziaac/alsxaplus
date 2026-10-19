//! The ordering code gives exactly the answers that were recorded for it in tests/fixtures/parity.json:
//! text helpers, the pool and its order, the policy for a model's answer, and the estimate of whether to ask.
use alsxaplus_mcp::clarity::{UnclearReason, assess_clarity};
use alsxaplus_mcp::phrasebank::core_phrases;
use alsxaplus_mcp::ranking::{Alias, Heard, PersonalPhrase, apply_model_output, build_pool, fallback_rank, score, shown_to_model};
use alsxaplus_mcp::text::{dice, edit_ratio, jaccard, levenshtein, normalize, similarity, skeleton, words};
use serde_json::Value;

fn fixtures() -> Value {
    serde_json::from_str(include_str!("fixtures/parity.json")).expect("parity.json is valid")
}

fn close(a: f64, b: f64) -> bool {
    (a - b).abs() < 1e-9
}

fn heard_of(v: &Value) -> Vec<Heard> {
    v.as_array().unwrap().iter().map(|h| Heard { text: h["text"].as_str().unwrap().to_string(), confidence: h["confidence"].as_f64().unwrap() }).collect()
}

#[test]
fn text_helpers_agree() {
    let f = fixtures();
    for row in f["text"]["normalize"].as_array().unwrap() {
        let t = row["in"].as_str().unwrap();
        assert_eq!(normalize(t), row["out"].as_str().unwrap(), "normalize {t:?}");
        let w: Vec<String> = row["words"].as_array().unwrap().iter().map(|x| x.as_str().unwrap().to_string()).collect();
        assert_eq!(words(t), w, "words {t:?}");
        assert_eq!(skeleton(t), row["skeleton"].as_str().unwrap(), "skeleton {t:?}");
    }
    for row in f["text"]["pairs"].as_array().unwrap() {
        let (a, b) = (row["a"].as_str().unwrap(), row["b"].as_str().unwrap());
        assert!(close(dice(a, b), row["dice"].as_f64().unwrap()), "dice {a:?} {b:?}");
        assert!(close(jaccard(&words(a), &words(b)), row["jaccard"].as_f64().unwrap()), "jaccard {a:?} {b:?}");
        assert_eq!(levenshtein(&normalize(a), &normalize(b)) as u64, row["levenshtein"].as_u64().unwrap(), "levenshtein {a:?} {b:?}");
        assert!(close(edit_ratio(a, b), row["editRatio"].as_f64().unwrap()), "editRatio {a:?} {b:?}");
        assert!(close(similarity(a, b), row["similarity"].as_f64().unwrap()), "similarity {a:?} {b:?}");
    }
}

#[test]
fn the_pool_and_its_order_agree() {
    let f = fixtures();
    for (n, s) in f["ranking"].as_array().unwrap().iter().enumerate() {
        let heard = heard_of(&s["heard"]);
        let personal: Vec<PersonalPhrase> = s["personal"].as_array().unwrap().iter().map(|p| PersonalPhrase { text: p["text"].as_str().unwrap().into(), uses: p["uses"].as_i64().unwrap() }).collect();
        let aliases: Vec<Alias> = s["aliases"].as_array().unwrap().iter().map(|a| Alias { heard: a["heard"].as_str().unwrap().into(), text: a["text"].as_str().unwrap().into(), uses: a["uses"].as_i64().unwrap() }).collect();
        let pool = build_pool(&heard, &personal, &aliases, core_phrases());
        assert_eq!(pool.len() as u64, s["poolSize"].as_u64().unwrap(), "scenario {n}: pool size");
        for (c, want) in pool.iter().zip(s["pool"].as_array().unwrap()) {
            assert_eq!(c.id, want["id"].as_str().unwrap(), "scenario {n}");
            assert_eq!(c.text, want["text"].as_str().unwrap(), "scenario {n}");
            assert_eq!(c.origin.as_str(), want["origin"].as_str().unwrap(), "scenario {n}: {}", c.text);
            assert_eq!(c.uses, want["uses"].as_i64().unwrap(), "scenario {n}: {}", c.text);
            assert_eq!(c.alias_uses, want["aliasUses"].as_i64().unwrap(), "scenario {n}: {}", c.text);
        }
        for (c, want) in pool.iter().zip(s["scores"].as_array().unwrap()) {
            assert!(close(score(c, &heard), want.as_f64().unwrap()), "scenario {n}: score of {}", c.text);
        }
        let ranked: Vec<String> = fallback_rank(&pool, &heard, 6).into_iter().map(|c| c.id).collect();
        let want: Vec<String> = s["ranked"].as_array().unwrap().iter().map(|x| x.as_str().unwrap().to_string()).collect();
        assert_eq!(ranked, want, "scenario {n}: order for {:?}", s["heard"]);
        let shown: Vec<String> = shown_to_model(&pool, &heard).into_iter().map(|c| c.id).collect();
        let want_shown: Vec<String> = s["shownIds"].as_array().unwrap().iter().map(|x| x.as_str().unwrap().to_string()).collect();
        assert_eq!(shown, want_shown, "scenario {n}: what the model is shown");
    }
}

#[test]
fn the_policy_agrees() {
    let f = fixtures();
    for case in f["policy"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let heard = heard_of(&case["heard"]);
        let pool = build_pool(&heard, &[], &[], core_phrases());
        let shown = shown_to_model(&pool, &heard);
        let got = apply_model_output(&case["output"], &shown, &pool, &heard);
        if case["ok"].as_bool().unwrap() {
            let got = got.unwrap_or_else(|e| panic!("{name}: unexpected violation: {e}"));
            let texts: Vec<&str> = got.iter().map(|c| c.text.as_str()).collect();
            let want: Vec<&str> = case["texts"].as_array().unwrap().iter().map(|x| x.as_str().unwrap()).collect();
            assert_eq!(texts, want, "{name}");
            let origins: Vec<&str> = got.iter().map(|c| c.origin.as_str()).collect();
            let want: Vec<&str> = case["origins"].as_array().unwrap().iter().map(|x| x.as_str().unwrap()).collect();
            assert_eq!(origins, want, "{name}: origins");
        } else {
            let err = got.expect_err(name);
            assert_eq!(err.0, case["message"].as_str().unwrap(), "{name}");
        }
    }
}

#[test]
fn the_estimate_of_whether_to_ask_agrees() {
    let f = fixtures();
    for case in f["clarity"].as_array().unwrap() {
        let c = assess_clarity(&heard_of(&case["heard"]));
        assert_eq!(c.unclear, case["unclear"].as_bool().unwrap(), "{:?}", case["heard"]);
        let reasons: Vec<&str> = c
            .reasons
            .iter()
            .map(|r| match r {
                UnclearReason::NothingHeard => "nothing_heard",
                UnclearReason::LowConfidence => "low_confidence",
                UnclearReason::RecognisersDisagree => "recognisers_disagree",
            })
            .collect();
        let want: Vec<&str> = case["reasons"].as_array().unwrap().iter().map(|x| x.as_str().unwrap()).collect();
        assert_eq!(reasons, want, "{:?}", case["heard"]);
    }
}
