//! An estimate of whether what was just heard was hard to understand. It decides only one thing: whether the assistant
//! should ASK "Do you have difficulty speaking?". It never decides the answer. Unclear speech has many causes (a noisy
//! room, a cold, an accent, a child), so the estimate is never stored as a conclusion about the person and never switches
//! anything on by itself. Only the person's own answer, or their carer's, changes the profile.
use serde::Serialize;

use crate::ranking::Heard;
use crate::text::{normalize, similarity};

/// Below this confidence from the best recogniser, the words are treated as uncertain.
pub const LOW_CONFIDENCE: f64 = 0.85;
/// Two recognisers that write the same sounds this differently are treated as disagreeing.
pub const DISAGREEMENT: f64 = 0.75;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum UnclearReason {
    NothingHeard,
    LowConfidence,
    RecognisersDisagree,
}

#[derive(Clone, Debug)]
pub struct Clarity {
    pub unclear: bool,
    pub reasons: Vec<UnclearReason>,
}

pub fn assess_clarity(heard: &[Heard]) -> Clarity {
    let Some(first) = heard.first() else {
        return Clarity { unclear: true, reasons: vec![UnclearReason::NothingHeard] };
    };
    let mut reasons = Vec::new();
    let top = heard.iter().map(|h| h.confidence).fold(f64::NEG_INFINITY, f64::max);
    if top < LOW_CONFIDENCE {
        reasons.push(UnclearReason::LowConfidence);
    }
    // Different recognisers writing different words for the same recording is itself a sign of unclear speech.
    let best = heard.iter().fold(first, |a, b| if b.confidence > a.confidence { b } else { a });
    let key = normalize(&best.text);
    if heard.iter().any(|h| normalize(&h.text) != key && similarity(&best.text, &h.text) < DISAGREEMENT) {
        reasons.push(UnclearReason::RecognisersDisagree);
    }
    Clarity { unclear: !reasons.is_empty(), reasons }
}
