//! Which sentences to offer. The model may propose an order; this file decides what is allowed and what is used.
//! Whatever the model says, only an answer that passes `apply_model_output` is shown. `fallback_rank` needs no model.
use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::text::{edit_ratio, locale_cmp, normalize, similarity, words};

/// One recommended sentence and five others.
pub const MAX_OPTIONS: usize = 6;
const MAX_PERSONAL: usize = 40;
/// The whole bank is only a few hundred tokens, and the right sentence must never be hidden from the model.
const MAX_SHOWN_TO_MODEL: usize = 120;
const MAX_CORRECTIONS: usize = 2;
const MAX_CORRECTION_CHARS: usize = 120;
const MAX_CORRECTION_WORDS: usize = 14;
/// A correction may differ from what was heard by at most this share of its letters.
const MAX_CORRECTION_EDIT: f64 = 0.5;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Heard {
    pub text: String,
    pub confidence: f64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Origin {
    Learned,
    Personal,
    Heard,
    Bank,
    Correction,
}

impl Origin {
    pub fn as_str(self) -> &'static str {
        match self {
            Origin::Learned => "learned",
            Origin::Personal => "personal",
            Origin::Heard => "heard",
            Origin::Bank => "bank",
            Origin::Correction => "correction",
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Candidate {
    pub id: String,
    pub text: String,
    pub origin: Origin,
    /// How often the person has confirmed this sentence.
    pub uses: i64,
    /// How often the person has confirmed this sentence after the recogniser heard something like what it heard now.
    pub alias_uses: i64,
}

#[derive(Clone, Debug)]
pub struct PersonalPhrase {
    pub text: String,
    pub uses: i64,
}

/// A sound-alike the person has already settled: "wa er" was confirmed as "I need water".
#[derive(Clone, Debug)]
pub struct Alias {
    pub heard: String,
    pub text: String,
    pub uses: i64,
}

#[derive(Debug, thiserror::Error)]
#[error("{0}")]
pub struct PolicyViolation(pub String);

fn violation<T>(message: impl Into<String>) -> Result<T, PolicyViolation> {
    Err(PolicyViolation(message.into()))
}

fn clamp01(x: f64) -> f64 {
    x.clamp(0.0, 1.0)
}

fn sentence(text: &str) -> String {
    let t = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut chars = t.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().chain(chars).collect(),
        None => String::new(),
    }
}

/// Collects everything that could be offered, once each. Earlier sources win when the same sentence appears twice.
pub fn build_pool(heard: &[Heard], personal: &[PersonalPhrase], aliases: &[Alias], bank: &[String]) -> Vec<Candidate> {
    let mut seen: HashSet<String> = HashSet::new();
    let mut pool: Vec<Candidate> = Vec::new();
    let mut add = |id: String, text: &str, origin: Origin, uses: i64, alias_uses: i64| {
        let key = normalize(text);
        if key.is_empty() || !seen.insert(key) {
            return;
        }
        pool.push(Candidate { id, text: sentence(text), origin, uses, alias_uses });
    };
    let alias_uses_for = |text: &str| -> i64 {
        let key = normalize(text);
        aliases.iter().filter(|a| normalize(&a.text) == key).map(|a| a.uses).sum()
    };

    for (i, a) in aliases.iter().enumerate() {
        let key = normalize(&a.text);
        let uses = personal.iter().find(|p| normalize(&p.text) == key).map_or(0, |p| p.uses);
        add(format!("l{}", i + 1), &a.text, Origin::Learned, uses, alias_uses_for(&a.text));
    }
    for (i, p) in personal.iter().take(MAX_PERSONAL).enumerate() {
        add(format!("p{}", i + 1), &p.text, Origin::Personal, p.uses, alias_uses_for(&p.text));
    }
    for (i, b) in bank.iter().enumerate() {
        add(format!("b{}", i + 1), b, Origin::Bank, 0, 0);
    }
    // What was heard stays a choice, so the person is never denied their own words, unless a known sentence is the same.
    for (i, h) in heard.iter().enumerate() {
        add(format!("h{}", i + 1), &h.text, Origin::Heard, 0, 0);
    }
    pool
}

/// Higher is more likely to be what the person meant.
pub fn score(candidate: &Candidate, heard: &[Heard]) -> f64 {
    // The recogniser's own text is a fallback choice, not a good guess: it matches itself perfectly, so it is scored
    // by how sure the recogniser was and kept below a real sentence that sounds like it.
    if candidate.origin == Origin::Heard {
        let key = normalize(&candidate.text);
        let own = heard.iter().find(|h| normalize(&h.text) == key);
        return 0.15 + 0.15 * clamp01(own.map_or(0.0, |h| h.confidence));
    }
    let mut best = 0.0_f64;
    for h in heard {
        let weight = 0.6 + 0.4 * clamp01(h.confidence);
        best = best.max(similarity(&candidate.text, &h.text) * weight);
    }
    // A sound-alike the person has settled before is the strongest sign. Frequent use is a weaker one.
    let learned = if candidate.alias_uses > 0 { 1.0 + 0.1 * (1.0 + candidate.alias_uses as f64).log2() } else { 0.0 };
    let familiar = if candidate.uses > 0 { (0.1 + 0.05 * (1.0 + candidate.uses as f64).log2()).min(0.3) } else { 0.0 };
    best + learned + familiar
}

/// The order the rules would choose with no model. Ties go to sentences used more, then to alphabetical order.
pub fn fallback_rank(pool: &[Candidate], heard: &[Heard], limit: usize) -> Vec<Candidate> {
    let mut scored: Vec<(&Candidate, f64)> = pool.iter().map(|c| (c, score(c, heard))).collect();
    scored.sort_by(|a, b| {
        b.1.partial_cmp(&a.1)
            .unwrap_or(Ordering::Equal)
            .then_with(|| b.0.uses.cmp(&a.0.uses))
            .then_with(|| locale_cmp(&a.0.text, &b.0.text))
    });
    scored.into_iter().take(limit).map(|(c, _)| c.clone()).collect()
}

/// What the model is shown: nearly everything, with the best by the rules first.
pub fn shown_to_model(pool: &[Candidate], heard: &[Heard]) -> Vec<Candidate> {
    fallback_rank(pool, heard, MAX_SHOWN_TO_MODEL)
}

fn js_type(v: Option<&Value>) -> &'static str {
    match v {
        None => "undefined",
        Some(Value::String(_)) => "string",
        Some(Value::Number(_)) => "number",
        Some(Value::Bool(_)) => "boolean",
        Some(_) => "object",
    }
}

fn non_empty_str<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key).and_then(Value::as_str).filter(|s| !s.is_empty())
}

/// Turns the model's answer into the list that is shown. Fails with a PolicyViolation if the answer breaks a rule:
/// an id that was not offered, a repeat, or a "correction" that is longer than allowed, too far from what was heard,
/// or made of words that nobody in the conversation has used.
pub fn apply_model_output(output: &Value, shown: &[Candidate], pool: &[Candidate], heard: &[Heard]) -> Result<Vec<Candidate>, PolicyViolation> {
    let choices = match output.get("choices") {
        Some(Value::Array(list)) if !list.is_empty() => list,
        other => {
            let shape = match other {
                Some(Value::Array(_)) => "an empty list",
                x => js_type(x),
            };
            let seen: String = serde_json::to_string(output).unwrap_or_default().chars().take(120).collect();
            return violation(format!("choices must be a list with at least one item, not {shape}; the answer was {seen}"));
        }
    };
    // Only the first eight are read: six are shown, and a model that lists more has still put its best first.
    let by_id: HashMap<&str, &Candidate> = shown.iter().map(|c| (c.id.as_str(), c)).collect();
    let mut vocabulary: HashSet<String> = HashSet::new();
    for c in pool {
        vocabulary.extend(words(&c.text));
    }
    for h in heard {
        vocabulary.extend(words(&h.text));
    }

    let mut chosen: Vec<Candidate> = Vec::new();
    let mut used: HashSet<String> = HashSet::new();
    let mut corrections = 0usize;
    for raw in choices.iter().take(8) {
        let id = non_empty_str(raw, "id");
        let text = non_empty_str(raw, "text");
        if id.is_none() && text.is_none() {
            return violation("each choice needs an id or a text");
        }
        let candidate = if let Some(id) = id {
            let Some(found) = by_id.get(id) else {
                return violation(format!("id {id} was not offered"));
            };
            // Models often copy the sentence next to its id. That is fine as long as the two agree.
            if let Some(t) = text {
                if normalize(t) != normalize(&found.text) {
                    return violation("a choice has an id and a different text");
                }
            }
            (*found).clone()
        } else {
            let text = sentence(text.unwrap_or_default());
            corrections += 1;
            if corrections > MAX_CORRECTIONS {
                return violation("too many corrected sentences");
            }
            if text.encode_utf16().count() > MAX_CORRECTION_CHARS || words(&text).len() > MAX_CORRECTION_WORDS {
                return violation("a corrected sentence is too long");
            }
            if !text.chars().all(|c| (' '..='~').contains(&c)) {
                return violation("a corrected sentence holds a character that is not plain text");
            }
            if heard.is_empty() {
                return violation("nothing was heard, so nothing can be corrected");
            }
            let closest = heard.iter().map(|h| edit_ratio(&text, &h.text)).fold(f64::INFINITY, f64::min);
            if closest > MAX_CORRECTION_EDIT {
                return violation("a corrected sentence is too far from what was heard");
            }
            if let Some(unknown) = words(&text).into_iter().find(|w| !vocabulary.contains(w)) {
                return violation(format!("a corrected sentence uses a word nobody has used: {unknown}"));
            }
            Candidate { id: format!("c{corrections}"), text, origin: Origin::Correction, uses: 0, alias_uses: 0 }
        };
        if !used.insert(normalize(&candidate.text)) {
            return violation("a sentence was offered twice");
        }
        chosen.push(candidate);
    }
    chosen.truncate(MAX_OPTIONS);
    Ok(fill_up(chosen, pool, heard))
}

/// If fewer than six were chosen, the rules add the next best, so the person always has five other choices.
pub fn fill_up(mut chosen: Vec<Candidate>, pool: &[Candidate], heard: &[Heard]) -> Vec<Candidate> {
    let mut used: HashSet<String> = chosen.iter().map(|c| normalize(&c.text)).collect();
    for c in fallback_rank(pool, heard, pool.len()) {
        if chosen.len() >= MAX_OPTIONS {
            break;
        }
        if used.insert(normalize(&c.text)) {
            chosen.push(c);
        }
    }
    chosen
}
