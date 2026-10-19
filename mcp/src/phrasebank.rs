//! Everyday sentences that people who use communication aids often need. They are a starting point: the sentences a
//! person confirms are learned and ranked above these. They are plain statements and requests, not medical advice.
use std::sync::OnceLock;

static BANK: OnceLock<Vec<String>> = OnceLock::new();

pub fn core_phrases() -> &'static [String] {
    BANK.get_or_init(|| serde_json::from_str(include_str!("phrasebank.json")).expect("phrasebank.json is a list of sentences"))
}
