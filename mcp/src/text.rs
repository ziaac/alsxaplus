//! Small, exact text helpers. No model is involved: these decide how close two sentences are.
use std::collections::{HashMap, HashSet};

use unicode_normalization::UnicodeNormalization;

/// Lower case, letters and digits and apostrophes only, single spaces.
pub fn normalize(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut after_space = true;
    for c in text.to_lowercase().nfkd() {
        // Accents split off by the decomposition are dropped, so "café" becomes "cafe".
        if ('\u{300}'..='\u{36f}').contains(&c) {
            continue;
        }
        if c.is_ascii_lowercase() || c.is_ascii_digit() || c == '\'' {
            out.push(c);
            after_space = false;
        } else if !after_space {
            out.push(' ');
            after_space = true;
        }
    }
    if out.ends_with(' ') {
        out.pop();
    }
    out
}

pub fn words(text: &str) -> Vec<String> {
    let n = normalize(text);
    if n.is_empty() {
        Vec::new()
    } else {
        n.split(' ').map(str::to_owned).collect()
    }
}

fn bigrams(s: &str) -> HashMap<[u8; 2], usize> {
    let flat: Vec<u8> = s.bytes().filter(|b| *b != b' ').collect();
    let mut out = HashMap::new();
    if flat.len() == 1 {
        out.insert([flat[0], 0], 1);
    }
    for pair in flat.windows(2) {
        *out.entry([pair[0], pair[1]]).or_insert(0) += 1;
    }
    out
}

/// Dice coefficient on letter pairs: 1 for the same letters in the same order, 0 for nothing shared.
pub fn dice(a: &str, b: &str) -> f64 {
    let x = bigrams(&normalize(a));
    let y = bigrams(&normalize(b));
    let size_x: usize = x.values().sum();
    let size_y: usize = y.values().sum();
    if size_x == 0 || size_y == 0 {
        return 0.0;
    }
    let shared: usize = x.iter().map(|(g, n)| (*n).min(y.get(g).copied().unwrap_or(0))).sum();
    (2 * shared) as f64 / (size_x + size_y) as f64
}

pub fn jaccard(a: &[String], b: &[String]) -> f64 {
    let x: HashSet<&String> = a.iter().collect();
    let y: HashSet<&String> = b.iter().collect();
    if x.is_empty() || y.is_empty() {
        return 0.0;
    }
    let shared = x.iter().filter(|w| y.contains(**w)).count();
    shared as f64 / (x.len() + y.len() - shared) as f64
}

pub fn levenshtein(a: &str, b: &str) -> usize {
    if a == b {
        return 0;
    }
    let a: Vec<char> = a.chars().collect();
    let b: Vec<char> = b.chars().collect();
    if a.is_empty() {
        return b.len();
    }
    if b.is_empty() {
        return a.len();
    }
    let mut prev: Vec<usize> = (0..=b.len()).collect();
    for i in 1..=a.len() {
        let mut row = vec![i];
        for j in 1..=b.len() {
            let cost = usize::from(a[i - 1] != b[j - 1]);
            row.push((prev[j] + 1).min(row[j - 1] + 1).min(prev[j - 1] + cost));
        }
        prev = row;
    }
    prev[b.len()]
}

/// Edits needed to turn one sentence into the other, as a share of the longer one. 0 is the same, 1 is nothing alike.
pub fn edit_ratio(a: &str, b: &str) -> f64 {
    let x = normalize(a);
    let y = normalize(b);
    let longest = x.chars().count().max(y.chars().count()).max(1);
    levenshtein(&x, &y) as f64 / longest as f64
}

/// Consonants only, repeats squeezed: speech that loses or bends vowels still keeps most of its consonants.
pub fn skeleton(text: &str) -> String {
    let mut out = String::new();
    for c in normalize(text).chars() {
        if matches!(c, 'a' | 'e' | 'i' | 'o' | 'u' | 'y') || out.ends_with(c) {
            continue;
        }
        out.push(c);
    }
    out
}

/// 0 to 1: how much two sentences look and sound alike on paper.
pub fn similarity(a: &str, b: &str) -> f64 {
    0.4 * dice(a, b) + 0.4 * dice(&skeleton(a), &skeleton(b)) + 0.2 * jaccard(&words(a), &words(b))
}

/// The order a person would expect when two sentences are otherwise tied: letters without regard to case, and a
/// lower case letter before its capital.
pub fn locale_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    let (la, lb) = (a.to_lowercase(), b.to_lowercase());
    la.cmp(&lb).then_with(|| {
        for (x, y) in a.chars().zip(b.chars()) {
            if x != y {
                return if x.is_lowercase() { std::cmp::Ordering::Less } else { std::cmp::Ordering::Greater };
            }
        }
        std::cmp::Ordering::Equal
    })
}
