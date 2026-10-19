# ALSxaPlus

> When speech is unclear, a voice assistant often gives up. People whose speech is changed by ALS, cerebral palsy, Parkinson's disease, a stroke or another condition are misheard again and again. ALSxaPlus notices when it had trouble understanding, asks the person once whether speaking is difficult for them, shows the sentences they may have meant, says the one they choose aloud in a clear voice, and learns how *they* sound. It never decides by itself that someone has a disability: only the person (or their carer) answers.
>
> The help is meant for today and for later. As speech changes, the same profile keeps learning from every sentence the person confirms, and the choices can also be made by touch, keys or a single switch when speech is no longer possible.

![Rust 1.99](https://img.shields.io/badge/Rust-1.99-B7410E)
![Node.js 24](https://img.shields.io/badge/Node.js-24-5FA04E)
![React Router 8.4](https://img.shields.io/badge/React%20Router-8.4-CA4245)
![PostgreSQL 18](https://img.shields.io/badge/PostgreSQL-18-336791)
![MCP 2025-11-25](https://img.shields.io/badge/MCP-2025--11--25-1F2A44)

Built for the **Amazon Developer Hackathon 2026** (Devpost), Alexa+ track, with the AWS Builder mini challenge through Amazon Bedrock. It is an idea for an Alexa+ add-on for people with speech disabilities, starting with ALS, shown through a web simulation of a smart display that talks to a real MCP server.

Live demo: **https://alsxa.eziedutech.dev/sim** (a profile is deleted after a day without use).

## Table of Contents

- [What it is](#what-it-is)
- [How it works](#how-it-works)
- [How to test](#how-to-test)
- [Architecture](#architecture)
- [Running locally](#running-locally)
- [Configuration](#configuration)
- [Results](#results)
- [What it does not claim](#what-it-does-not-claim)
- [Credits and licenses](#credits-and-licenses)
- [How this was built](#how-this-was-built)
- [License](#license)

## What it is

Voice assistants are built for typical speech. But a recogniser's mistakes for one person are usually *consistent*: the same sounds are written down the same wrong way. That is a pattern a system can learn.

ALSxaPlus does four things:

1. **Estimates, then asks once.** When what it heard was hard to understand (low confidence, or the recognisers disagree), it asks "Do you have difficulty speaking?" and remembers the answer. Clear speech is simply understood and nothing is asked. The estimate is never stored as a conclusion and never switches anything on: only the answer does. It can be wrong in both directions, so the help can also be turned on in the settings.
2. **Offers sentences instead of guessing.** It shows one recommended sentence and five others, best first. The person picks by touch, with keys 1 to 6, or with one switch, or types their own words, or says it again. A guess never acts on its own.
3. **Speaks for the person.** The chosen sentence is said aloud in a clear voice.
4. **Learns.** The sentence the person chose, and the way the recogniser wrote the sounds, are saved together, so the next time those sounds come first.

### Built today

- **An MCP server** written in Rust (the official `rmcp` SDK, protocol 2025-11-25, Streamable HTTP) with five tools: `get_status`, `set_speech_support`, `suggest_meanings`, `confirm_meaning`, `list_my_phrases`. Consent and deleting data are *not* tools: a voice assistant must never be able to agree for someone or erase their data. They are buttons for the person.
- **An ordering that a model proposes and code checks.** Claude Haiku on Amazon Bedrock may order the candidate sentences. Only an answer that passes the rules is used: ids that were offered, no repeats, and at most two "corrections" that stay close to what was heard and use only words that already appear in the candidates or in what was heard. If the model is missing, over budget, empty or breaks a rule, plain rules (letter and consonant similarity, plus what was learned) order the sentences, and the stored record says which one decided and why.
- **Per-person learning.** What a person confirmed, and the sounds that went with it, are stored per profile and ranked first the next time.
- **Three recognisers for one phrase.** Deepgram's Nova-3, Nova-2 and base models listen to the same recording and write it down differently. All the distinct guesses are used as evidence.
- **A simulated smart display** (`web`): consent first, large targets, strong contrast, keyboard shortcuts, and **one-switch scanning** (the choices light up in turn and a single key picks the lit one).
- **A spending limit enforced in code.** Every model call is recorded with its cost, and a call is refused when the month's spending plus its worst case would pass the limit.
- **Your data is yours.** Settings show every learned sentence, let you forget any, or delete everything. The public demo also deletes a profile idle for a day.
- **Pages:** how to use, about, privacy and terms.

### Planned, not built

- A card shown through MCP Apps on a real Alexa+ screen. The simulation draws the choices itself.
- Recognising a returning speaker by voice. Today a profile belongs to a browser session.
- A trained detector of speech disability from audio. It would need work with clinicians and with people who live with these conditions.
- Real use by, and design with, people who live with speech disabilities.

## How it works

![How ALSxaPlus works: the person speaks, three recognisers write down what they heard, suggest_meanings orders six sentences with a model on Amazon Bedrock that code checks, the person chooses, confirm_meaning says the sentence aloud and saves it with the sounds in PostgreSQL.](assets/architecture.svg)

## How to test

Open the live demo at https://alsxa.eziedutech.dev/sim, agree, type or say something unclear such as "ah wan bed", and choose a sentence. To run the checks on your own machine, see [Running locally](#running-locally).

1. `cd mcp && cargo test`: 24 tests (9 of them need `TEST_DATABASE_URL`). Then `cd mcp/conformance && npm install && npm test`: 8 tests that start the built server and talk to it with the **official MCP TypeScript client**.
2. `cd web && npm run e2e`: 17 browser tests, including automatic accessibility checks (axe-core, WCAG 2.1 A and AA) in every step, one-switch scanning, deleting data, and, when `DEEPGRAM_API_KEY` is set, a fake microphone that plays a synthetic voice through the three recognisers.
3. `cd mcp && cargo run --bin probe` sends 20 damaged transcripts to the real model through the real code and reports how often its order passed the rules. It spends a little money.
4. `cd mcp && cargo run --release --bin torgo_eval -- <folder>` and `cargo run --release --bin torgo_clarity -- <folder> <controls folder>` measure the ordering and the estimate on TORGO recordings (see [Results](#results)). `scripts/extract_torgo_subset.py` copies a subset of the recordings into a folder.

## Architecture

```
mcp/   Rust MCP server: tools, ranking and policy, learning, Bedrock, spending limit, PostgreSQL
web/   React Router 8 app: the simulated display, a door to the server for the page, the speech routes
```

- **The model proposes, code decides.** The tool schema lists only the ids that were offered. The checking code (`mcp/src/ranking.rs`) rejects anything else.
- **No audio is stored.** The web server passes a short recording to Deepgram and keeps nothing. The database holds text only.
- **Each person has their own profile**, opened by the web app and held in an httpOnly cookie. A token opens one profile, and a tool can only see that profile's data.
- **Settings come from the environment.** Model id, region, prices and the monthly limit are variables, never code.

## Running locally

Requires Rust 1.99, Node.js 24 (22.22 or newer works) for the web app, PostgreSQL 18, and optionally a Deepgram key and a Bedrock key.

```bash
cd mcp && cp .env.example .env                  # fill in DATABASE_URL and SERVICE_KEY
cargo run --bin alsxaplus-mcp                   # the MCP server on port 8081
```

```bash
cd web && npm install && cp .env.example .env   # MCP_URL, the same SERVICE_KEY, optionally DEEPGRAM_API_KEY
npm run dev                                     # the simulation at http://localhost:5273/sim
```

Without a Bedrock key the rules order the sentences. Without a Deepgram key the page still works by typing what the recogniser might have written.

## Configuration

| Setting | Where | Purpose |
|---|---|---|
| `DATABASE_URL`, `PORT` | mcp | PostgreSQL connection and listening port |
| `SERVICE_KEY` | mcp, web | a shared secret that lets the web app open a profile for a visitor |
| `PROFILE_TTL_HOURS` | mcp | a profile idle this long is deleted (default 24) |
| `ALLOWED_HOSTS` | mcp | host names the `/mcp` endpoint answers to |
| `AWS_BEARER_TOKEN_BEDROCK` | mcp | Bedrock API key; without it the rules order the sentences |
| `AWS_REGION`, `BEDROCK_MODEL_ID` | mcp | region and model (an inference profile id such as `us.anthropic.claude-haiku-5-5`) |
| `BEDROCK_PRICE_INPUT_USD_PER_MTOK`, `BEDROCK_PRICE_OUTPUT_USD_PER_MTOK`, `BEDROCK_MONTHLY_LIMIT_USD` | mcp | prices and the monthly limit that stops model calls |
| `MCP_URL` | web | where the MCP server listens |
| `DEEPGRAM_API_KEY` | web | optional speech; the key stays on the server and never reaches a browser |

## Results

Every number below can be reproduced with the checks in [How to test](#how-to-test).

### Tests

| Suite | Result |
|---|---|
| Rust unit tests, and the ordering rules, model policy and estimate compared with recorded answers | 15 passed |
| Rust service against PostgreSQL with a scripted model (consent, clear speech not questioned, the question asked once, learning, isolation between people, deleting, an empty model answer asked again, a policy violation, a failing model, the spending limit) | 9 passed |
| The built server through the official MCP TypeScript client against PostgreSQL (protocol version, tool list, learning, deleting, no consent or delete tool, 401 and host checks) | 8 passed |
| Browser tests in Chromium (consent gate, question once, choosing by key, learning, typing, one-switch scanning, deleting, copying the conversation, phone-sized screen, accessibility in every step, voice with a fake microphone) | 17 passed |

### The model on damaged transcripts

`mcp/src/bin/probe.rs`: 20 invented transcripts such as "ah wan bed" (meant "I want to go to bed"), real model calls through the real code. Cost is figured with 0.10 USD per million input tokens and 0.50 per million output tokens, as given by the author.

| | |
|---|---|
| Model order used (it passed the rules) | 19 of 20 (the other one was replaced by the rules) |
| The meant sentence first | 18 of 20 |
| The meant sentence among the six | 18 of 20 |
| Median time of a call | 1.5 s |
| Cost of the 20 calls | about 0.009 USD |

These transcripts were written by hand to look like unclear speech. They show that the format, the policy and the ordering work; they say nothing about real speech.

### Recordings of speakers with dysarthria (TORGO)

TORGO holds recordings of speakers with dysarthria (ALS, cerebral palsy) reading words and sentences. Here, 80 recordings from each of 8 speakers (640 in all: 499 single words and 141 sentences of two or more words) were run through the three Deepgram recognisers on a local machine. No audio is in this repository. The ordering below uses the plain rules only, with no language model.

**How good is the order of the six sentences?** Each speaker has a list of their own prompts (68 to 79 entries) that always contains the right sentence, like a personal list of favourite phrases. We check whether the sentence that was really spoken is first.

| Recordings | n | Best transcript is exactly right | Right sentence first | Right sentence among the six |
|---|---|---|---|---|
| All | 640 | 42% (268/640) | 62% (399/640) | 75% (481/640) |
| One word | 499 | 44% | 55% (273/499) | 70% (348/499) |
| Two or more words | 141 | 33% (47/141) | 89% (126/141) | 94% (133/141) |
| Speaker F01 (hardest) | 80 | 18% | 32% (26/80) | 54% (43/80) |
| Speaker M03 (easiest) | 80 | 83% | 94% (75/80) | 98% (78/80) |

Offering the person's own sentences raises how often the right one is first from 42% to 62%, and it helps most for sentences. Speakers differ a lot. What this does **not** show: the lists already contain the answer, which is much easier than free speech; the learning effect is not measured (only 36 recordings repeated a sentence); and the recordings are read prompts in a lab.

**When would the question be asked?** The same recordings, plus 280 recordings from 7 TORGO speakers without dysarthria, through the estimate.

| Recordings | n | Would be asked | Low confidence | Recognisers disagree |
|---|---|---|---|---|
| Speakers with dysarthria | 320 | 73% (232/320) | 48% | 50% |
| Speakers without dysarthria | 280 | 36% (100/280) | 17% | 25% |

The estimate tells the groups apart: about twice as many recordings from speakers with dysarthria look unclear. For a single person's first sentences it is a weak signal: all 8 speakers with dysarthria would have been asked within their first 3 recordings, and so would 6 of the 7 without it (most recordings are single words, which recognisers find hard for anyone). That is acceptable only because the question is asked once, costs one tap, and "No" leaves the assistant as usual. It is not a diagnosis. A better trigger, such as several unclear sentences in a row, is future work.

## What it does not claim

- **No person with a speech disability has used it, and it was not designed with one.** That has to happen before anyone relies on it.
- **It is not a medical device and not for emergencies.**
- **It has not run on Alexa+.** Alexa+ tool access is limited, so the experience is a web simulation that calls a real MCP server (checked with the official MCP client). The simulation is not an Amazon product.
- **Speech data is sensitive.** The privacy page says what is kept and what goes to Deepgram and Amazon Bedrock. It has not had legal review.
- **The tests used synthetic voices, invented transcripts, and a research database,** not people living with these conditions.
- English only.

## Credits and licenses

- **Amazon Bedrock** (Converse API, Claude Haiku 5.5 from Anthropic) to order the sentences.
- **Deepgram** (Nova-3, Nova-2, base, and Aura 2) for speech to text and text to speech.
- **TORGO database** (University of Toronto), free for academic and non-profit use, cited as: Rudzicz, F., Namasivayam, A. K., and Wolff, T. (2012). The TORGO database of acoustic and articulatory speech from speakers with dysarthria. Language Resources and Evaluation, 46(4). The recordings are not part of this repository.
- **rmcp** (the Rust MCP SDK), **axum**, **sqlx**, **tokio**, **reqwest** (MIT or Apache-2.0); the official MCP TypeScript SDK (MIT) for the conformance tests; **React**, **React Router**, **Vite**, **Playwright**, **axe-core** (MIT or MPL-2.0); **PostgreSQL**.

## How this was built

Claude Code with Claude Sonnet 5.5 on Amazon Bedrock was used as a Code Assistant to accelerate development and debugging, under the direction and review of the author. Problems met on the way are in [FRICTION-LOG.md](FRICTION-LOG.md).

## License

MIT, see [LICENSE](LICENSE).
