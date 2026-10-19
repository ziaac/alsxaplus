//! Measures the estimate that decides when the assistant asks "Do you have difficulty speaking?".
//!
//! The same three recognisers listen to recordings of speakers with dysarthria and to recordings of speakers without it
//! (the TORGO control speakers). For each recording the code decides "ask" or "do not ask". We report how often each
//! group would be asked, and how soon a speaker would be asked within a first run of recordings. A control speaker who
//! is asked is a false alarm (harmless, the answer is "no"); a speaker with dysarthria who is not asked can still turn
//! the help on in the settings. Only aggregate numbers are reported and the audio stays on this machine.
//!
//! Usage: torgo_clarity <dysarthria folder> <controls folder> [--per-speaker 40]
use std::path::PathBuf;

use alsxaplus_mcp::clarity::{DISAGREEMENT, LOW_CONFIDENCE, UnclearReason, assess_clarity};
use alsxaplus_mcp::deepgram::Deepgram;
use alsxaplus_mcp::ranking::Heard;
use anyhow::Context;
use serde::Deserialize;

#[derive(Clone, Deserialize)]
struct Item {
    speaker: String,
    file: String,
}

struct Row {
    group: &'static str,
    speaker: String,
    heard: Vec<Heard>,
}

async fn run_group(dg: Deepgram, folder: PathBuf, group: &'static str, per_speaker: usize) -> anyhow::Result<Vec<Row>> {
    let manifest = std::fs::read_to_string(folder.join("manifest.json")).with_context(|| format!("no manifest.json in {}", folder.display()))?;
    let items: Vec<Item> = serde_json::from_str(&manifest)?;
    let mut speakers: Vec<String> = Vec::new();
    for i in &items {
        if !speakers.contains(&i.speaker) {
            speakers.push(i.speaker.clone());
        }
    }
    let mut tasks = Vec::new();
    for speaker in speakers {
        let mine: Vec<Item> = items.iter().filter(|i| i.speaker == speaker).cloned().collect();
        let (dg, folder) = (dg.clone(), folder.clone());
        tasks.push(tokio::spawn(async move {
            let step = (mine.len() / per_speaker).max(1);
            let chosen: Vec<&Item> = mine.iter().enumerate().filter(|(i, _)| i % step == 0).map(|(_, x)| x).take(per_speaker).collect();
            println!("{group} {speaker}: {} recordings", chosen.len());
            let mut rows = Vec::new();
            for item in chosen {
                match std::fs::read(folder.join(&item.file)) {
                    Ok(wav) => rows.push(Row { group, speaker: speaker.clone(), heard: dg.ensemble(&wav).await }),
                    Err(e) => eprintln!("  skipped {}: {e}", item.file),
                }
            }
            rows
        }));
    }
    let mut rows = Vec::new();
    for t in tasks {
        rows.extend(t.await?);
    }
    Ok(rows)
}

fn pct(n: usize, d: usize) -> String {
    if d == 0 { "n/a".into() } else { format!("{:.0}% ({n}/{d})", 100.0 * n as f64 / d as f64) }
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let _ = dotenvy::from_path("../web/.env");
    let _ = dotenvy::dotenv();
    let args: Vec<String> = std::env::args().skip(1).collect();
    let folders: Vec<&String> = args.iter().filter(|a| !a.starts_with("--") && !a.chars().all(|c| c.is_ascii_digit())).collect();
    anyhow::ensure!(folders.len() >= 2, "Give the dysarthria folder and the controls folder, each with a manifest.json.");
    let per_speaker: usize = args.iter().position(|a| a == "--per-speaker").and_then(|i| args.get(i + 1)).map_or(40, |v| v.parse().unwrap_or(40));

    let dg = Deepgram::from_env()?;
    let (a, b) = tokio::join!(
        run_group(dg.clone(), PathBuf::from(folders[0]), "dysarthria", per_speaker),
        run_group(dg.clone(), PathBuf::from(folders[1]), "control", per_speaker)
    );
    let mut rows = a?;
    rows.extend(b?);

    println!("\nConfidence threshold {LOW_CONFIDENCE}, disagreement threshold {DISAGREEMENT}");
    println!("| Recordings | n | Would be asked (this setting) | Asked because of low confidence | Asked because the recognisers disagree |\n|---|---|---|---|---|");
    for (group, label) in [("dysarthria", "Speakers with dysarthria"), ("control", "Speakers without dysarthria (controls)")] {
        let g: Vec<&Row> = rows.iter().filter(|r| r.group == group).collect();
        let why = |reason: UnclearReason| g.iter().filter(|r| assess_clarity(&r.heard).reasons.contains(&reason)).count();
        println!(
            "| {label} | {} | {} | {} | {} |",
            g.len(),
            pct(g.iter().filter(|r| assess_clarity(&r.heard).unclear).count(), g.len()),
            pct(why(UnclearReason::LowConfidence), g.len()),
            pct(why(UnclearReason::RecognisersDisagree), g.len())
        );
    }

    // How soon would a speaker be asked, going through their recordings in order?
    for group in ["dysarthria", "control"] {
        let mut speakers: Vec<&str> = Vec::new();
        for r in rows.iter().filter(|r| r.group == group) {
            if !speakers.contains(&r.speaker.as_str()) {
                speakers.push(&r.speaker);
            }
        }
        let firsts: Vec<Option<usize>> = speakers.iter().map(|s| rows.iter().filter(|r| r.group == group && r.speaker == *s).position(|r| assess_clarity(&r.heard).unclear).map(|i| i + 1)).collect();
        let within3 = firsts.iter().filter(|f| f.is_some_and(|n| n <= 3)).count();
        let list: Vec<String> = firsts.iter().map(|f| f.map_or("never".into(), |n| n.to_string())).collect();
        println!("{group}: speakers asked within their first 3 recordings: {}; first asked at recording {}", pct(within3, speakers.len()), list.join(", "));
    }

    // The same rule at other confidence thresholds, to show the trade-off.
    println!("\nOther confidence thresholds (disagreement rule unchanged):");
    for t in [0.7, 0.8, 0.85, 0.9, 0.95] {
        let asked = |r: &Row| r.heard.is_empty() || r.heard.iter().map(|h| h.confidence).fold(f64::NEG_INFINITY, f64::max) < t || assess_clarity(&r.heard).reasons.contains(&UnclearReason::RecognisersDisagree);
        let d: Vec<&Row> = rows.iter().filter(|r| r.group == "dysarthria").collect();
        let c: Vec<&Row> = rows.iter().filter(|r| r.group == "control").collect();
        println!("  {t}: dysarthria asked {}, controls asked {}", pct(d.iter().filter(|r| asked(r)).count(), d.len()), pct(c.iter().filter(|r| asked(r)).count(), c.len()));
    }
    Ok(())
}
