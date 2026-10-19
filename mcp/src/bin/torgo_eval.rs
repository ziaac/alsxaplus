//! Measures the sentence ordering on recordings of speakers with dysarthria from the TORGO database.
//!
//! For each speaker, in the order the recordings were made: three Deepgram recognisers write down what they hear, the
//! rules order the speaker's own prompts (a closed list, like a personal phrase book), and we check whether the sentence
//! that was really spoken is first, or among the first six. Then the sentence is "confirmed", so what the speaker's
//! sounds turned out to mean is learned and used for the next recordings. The same recordings are scored cold (the
//! first time a sentence is spoken) and warm (after it was confirmed before).
//!
//! The audio never leaves this machine except to the recognisers, is never copied into the repository, and only
//! aggregate numbers are reported. TORGO is free for academic and non-profit use and asks for citation:
//! Rudzicz, Namasivayam and Wolff (2012), Language Resources and Evaluation 46(4).
//!
//! Usage: torgo_eval <folder with manifest.json> [--per-speaker 80] [--speakers F01,M02] [--out data/torgo-results.json]
use std::collections::HashMap;
use std::path::{Path, PathBuf};

use alsxaplus_mcp::deepgram::Deepgram;
use alsxaplus_mcp::ranking::{Alias, Heard, PersonalPhrase, build_pool, fallback_rank};
use alsxaplus_mcp::text::normalize;
use anyhow::Context;
use serde::{Deserialize, Serialize};

#[derive(Clone, Deserialize)]
struct Item {
    speaker: String,
    file: String,
    prompt: String,
}

#[derive(Serialize)]
struct Row {
    speaker: String,
    prompt: String,
    words: usize,
    seen_before: bool,
    transcript_exact: bool,
    any_transcript_exact: bool,
    top1: bool,
    top6: bool,
}

fn flag(args: &[String], name: &str, fallback: &str) -> String {
    args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).cloned().unwrap_or_else(|| fallback.to_string())
}

async fn run_speaker(dg: Deepgram, root: PathBuf, speaker: String, mine: Vec<Item>, per_speaker: usize) -> Vec<Row> {
    // The closed list of this speaker's sentences, like a personal phrase book.
    let mut book: Vec<String> = Vec::new();
    for i in &mine {
        if !book.contains(&i.prompt) {
            book.push(i.prompt.clone());
        }
    }
    // Spread the recordings over all sessions so repeats and first times are both included.
    let step = (mine.len() / per_speaker).max(1);
    let chosen: Vec<&Item> = mine.iter().enumerate().filter(|(i, _)| i % step == 0).map(|(_, x)| x).take(per_speaker).collect();
    println!("{speaker}: {} recordings, a book of {} sentences", chosen.len(), book.len());

    let mut uses: Vec<(String, i64)> = Vec::new();
    let mut alias_map: HashMap<String, Vec<(String, i64)>> = HashMap::new();
    let mut rows = Vec::new();
    for item in chosen {
        let path = root.join(&item.file);
        let wav = match std::fs::read(&path) {
            Ok(w) => w,
            Err(e) => {
                eprintln!("  skipped {}: {e}", path.display());
                continue;
            }
        };
        let heard: Vec<Heard> = dg.ensemble(&wav).await;
        let mut personal: Vec<PersonalPhrase> = uses.iter().map(|(t, n)| PersonalPhrase { text: t.clone(), uses: *n }).collect();
        personal.sort_by(|a, b| b.uses.cmp(&a.uses));
        let mut aliases: Vec<Alias> = Vec::new();
        for h in &heard {
            let k = normalize(&h.text);
            for (text, n) in alias_map.get(&k).into_iter().flatten() {
                aliases.push(Alias { heard: k.clone(), text: text.clone(), uses: *n });
            }
        }
        let ranked: Vec<String> = fallback_rank(&build_pool(&heard, &personal, &aliases, &book), &heard, 6).iter().map(|c| normalize(&c.text)).collect();
        let want = normalize(&item.prompt);
        rows.push(Row {
            speaker: speaker.clone(),
            prompt: item.prompt.clone(),
            words: want.split(' ').count(),
            seen_before: uses.iter().any(|(t, _)| *t == item.prompt),
            transcript_exact: heard.first().is_some_and(|h| normalize(&h.text) == want),
            any_transcript_exact: heard.iter().any(|h| normalize(&h.text) == want),
            top1: ranked.first() == Some(&want),
            top6: ranked.contains(&want),
        });
        // The speaker confirms the sentence: it and the sounds that were written for it are learned.
        match uses.iter_mut().find(|(t, _)| *t == item.prompt) {
            Some(entry) => entry.1 += 1,
            None => uses.push((item.prompt.clone(), 1)),
        }
        for h in &heard {
            let k = normalize(&h.text);
            if k.is_empty() || k == want {
                continue;
            }
            let list = alias_map.entry(k).or_default();
            match list.iter_mut().find(|(t, _)| *t == item.prompt) {
                Some(entry) => entry.1 += 1,
                None => list.push((item.prompt.clone(), 1)),
            }
        }
    }
    rows
}

fn rate(rows: &[&Row], f: impl Fn(&Row) -> bool) -> String {
    if rows.is_empty() {
        return "n/a".into();
    }
    let n = rows.iter().filter(|r| f(r)).count();
    format!("{:.0}% ({n}/{})", 100.0 * n as f64 / rows.len() as f64, rows.len())
}

fn line(label: &str, rows: &[&Row]) -> String {
    format!("| {label} | {} | {} | {} | {} | {} |", rows.len(), rate(rows, |r| r.transcript_exact), rate(rows, |r| r.any_transcript_exact), rate(rows, |r| r.top1), rate(rows, |r| r.top6))
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let _ = dotenvy::from_path("../web/.env");
    let _ = dotenvy::dotenv();
    let args: Vec<String> = std::env::args().skip(1).collect();
    let root = PathBuf::from(args.iter().find(|a| !a.starts_with("--") && !a.chars().all(|c| c.is_ascii_digit())).context("Give the folder that holds manifest.json and the recordings.")?);
    let per_speaker: usize = flag(&args, "--per-speaker", "80").parse().context("--per-speaker must be a number")?;
    let only: Vec<String> = flag(&args, "--speakers", "").split(',').filter(|s| !s.is_empty()).map(str::to_owned).collect();
    let out = flag(&args, "--out", "data/torgo-results.json");

    let manifest = std::fs::read_to_string(root.join("manifest.json")).with_context(|| format!("no manifest.json in {}", root.display()))?;
    let items: Vec<Item> = serde_json::from_str(&manifest).context("manifest.json is not a list of recordings")?;
    let items: Vec<Item> = items.into_iter().filter(|i| only.is_empty() || only.contains(&i.speaker)).collect();
    let mut speakers: Vec<String> = Vec::new();
    for i in &items {
        if !speakers.contains(&i.speaker) {
            speakers.push(i.speaker.clone());
        }
    }
    anyhow::ensure!(!items.is_empty(), "No recordings with prompts were found.");
    println!("{} usable recordings from {} speaker(s): {}", items.len(), speakers.len(), speakers.join(", "));

    let dg = Deepgram::from_env()?;
    let mut tasks = Vec::new();
    for speaker in &speakers {
        let mine: Vec<Item> = items.iter().filter(|i| &i.speaker == speaker).cloned().collect();
        tasks.push(tokio::spawn(run_speaker(dg.clone(), root.clone(), speaker.clone(), mine, per_speaker)));
    }
    let mut results: Vec<Row> = Vec::new();
    for t in tasks {
        results.extend(t.await.context("a speaker's evaluation stopped")?);
    }

    let all: Vec<&Row> = results.iter().collect();
    let mut lines = vec![
        "| Recordings | n | Best transcript is exactly right | Any of the transcripts is exactly right | Right sentence first | Right sentence among the six |".to_string(),
        "|---|---|---|---|---|---|".to_string(),
        line("All", &all),
        line("First time this sentence is spoken (cold)", &results.iter().filter(|r| !r.seen_before).collect::<Vec<_>>()),
        line("Spoken and confirmed before (warm)", &results.iter().filter(|r| r.seen_before).collect::<Vec<_>>()),
        line("One word", &results.iter().filter(|r| r.words == 1).collect::<Vec<_>>()),
        line("Two or more words", &results.iter().filter(|r| r.words > 1).collect::<Vec<_>>()),
    ];
    for s in &speakers {
        lines.push(line(&format!("Speaker {s}"), &results.iter().filter(|r| &r.speaker == s).collect::<Vec<_>>()));
    }
    println!("\n{}", lines.join("\n"));
    if let Some(dir) = Path::new(&out).parent().filter(|d| !d.as_os_str().is_empty()) {
        std::fs::create_dir_all(dir)?;
    }
    std::fs::write(&out, serde_json::to_string_pretty(&serde_json::json!({ "results": results }))?)?;
    Ok(())
}
