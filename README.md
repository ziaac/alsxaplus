# ALSxaPlus

> When speech is unclear, a voice assistant often gives up. ALSxaPlus shows the sentences you may have meant, says the one you choose aloud in a clear voice, and learns how *you* sound, so the next guess is better.

![Node.js 24](https://img.shields.io/badge/Node.js-24-5FA04E)
![React Router 8.4](https://img.shields.io/badge/React%20Router-8.4-CA4245)
![PostgreSQL 18](https://img.shields.io/badge/PostgreSQL-18-336791)
![MCP 2025-11-25](https://img.shields.io/badge/MCP-2025--11--25-1F2A44)

Built for the **Amazon Developer Hackathon 2026** (Devpost), Alexa+ track, with the AWS Builder mini challenge through Amazon Bedrock. It is an idea for an Alexa+ add-on for people with speech disabilities, starting with ALS, shown through a web simulation of a smart display that talks to a real MCP server.

Status: **early build, not deployed yet.** The MCP server, the simulated display, the speech path and the tests work. Each section below says which is which.

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

Voice assistants are built for typical speech. People whose speech is changed by ALS, cerebral palsy or stroke are often misheard again and again. But a recogniser's mistakes for one person are usually *consistent*: the same sounds are written down the same wrong way. That is a pattern a system can learn.

ALSxaPlus does four things:

1. **Asks once.** The first time, it asks "Do you have difficulty speaking?" and remembers the answer. It never asks again unless the person changes it.
2. **Offers sentences instead of guessing.** For what was heard it shows one recommended sentence and five others, best first. The person picks by touch, with keys 1 to 6, or with one switch, or types their own words, or says it again. A guess never acts on its own.
3. **Speaks for the person.** The chosen sentence is said aloud in a clear voice.
4. **Learns.** The sentence the person chose, and the way the recogniser wrote the sounds, are saved together, so the next time those sounds come first.

### Built today

- **An MCP server** (official TypeScript SDK, protocol 2025-11-25, Streamable HTTP) with five tools: `get_status`, `set_speech_support`, `suggest_meanings`, `confirm_meaning`, `list_my_phrases`. Consent and deleting data are *not* tools: a voice assistant must never be able to agree for someone or erase their data. They are buttons for the person.
- **An ordering that a model proposes and code checks.** Claude Haiku on Amazon Bedrock may order the candidate sentences. Only an answer that passes the rules is used: ids that were offered, no repeats, and at most two "corrections" that stay within half of the letters of what was heard, are short plain text, and use only words that already appear in the candidates or in what was heard. If the model is missing, over budget, empty or breaks a rule, plain rules (letter and consonant similarity, plus what was learned) order the sentences, and the stored record says which one decided and why.
- **Per-person learning.** What a person confirmed, and the sounds that went with it, are stored per profile and ranked first the next time.
- **Three recognisers for one phrase.** Deepgram's Nova-3, Nova-2 and base models listen to the same recording and write it down differently. All the distinct guesses are used as evidence.
- **A simulated smart display** (`web`): consent first, then the screen described above. Large targets, strong contrast, keyboard shortcuts, and **one-switch scanning** (the choices light up in turn and a single key picks the lit one). Nothing moves unless asked.
- **A spending limit enforced in code.** Every model call is recorded with its cost, and a call is refused when the month's spending plus its worst case would pass the limit.
- **Your data is yours.** Settings show every learned sentence, let you forget any, or delete everything after a second confirmation. The public demo also deletes a profile idle for a day.
- **Pages:** how to use, about, privacy and terms.

### Planned, not built

- Deployment of a hosted copy (the files are written).
- A card shown through MCP Apps on a real Alexa+ screen. The simulation draws the choices itself.
- Real use by, and design with, people who live with speech disabilities.

## How it works

```
person speaks ──> three recognisers (Deepgram) ──> several guesses ("wa er", "water", ...)
                                                        |
                                                        v
        suggest_meanings (MCP tool) <── what this person has confirmed before
           |  model orders the candidates; code checks; rules if the model fails
           v
   one recommended sentence + five others ──> the person chooses or types
                                                        |
                                                        v
                  confirm_meaning (MCP tool) ──> the sentence is said aloud
                  and saved with the sounds, so next time it comes first
```

## How to test

There is no hosted version yet. Run the checks on your own machine (see [Running locally](#running-locally)).

1. `cd mcp && npm test`: 29 tests, 21 of the ordering rules and the model policy, 8 through the **official MCP client** against a real database (needs `TEST_DATABASE_URL`).
2. `cd web && npm run e2e`: 16 browser tests, including automatic accessibility checks (axe-core, WCAG 2.1 A and AA) in every step, one-switch scanning, deleting data, and, when `DEEPGRAM_API_KEY` is set, a fake microphone that plays a synthetic voice through the three recognisers.
3. `cd mcp && npx tsx scripts/probe.ts` sends 20 damaged transcripts to the real model through the real code and reports how often its order passed the rules. It spends a little money.
4. `cd mcp && npx tsx scripts/torgo-eval.ts <TORGO folder>` measures the ordering on recordings of speakers with dysarthria (see [Results](#results)).

## Architecture

```
mcp/   Node.js MCP server: tools, ranking and policy, learning, Bedrock, spending limit, PostgreSQL
web/   React Router 8 app: the simulated display, a door to the server for the page, the speech routes
```

Choices worth knowing:

- **The model proposes, code decides.** The tool schema lists only the ids that were offered. The checking code (`mcp/src/ranking.ts`) rejects anything else.
- **No audio is stored.** The web server passes a short recording to Deepgram and keeps nothing. The database holds text only.
- **Each person has their own profile**, opened by the web app and held in an httpOnly cookie. A token opens one profile, and a tool can only see that profile's data.
- **Settings come from the environment.** Model id, region, prices and the monthly limit are variables, never code.

## Running locally

Requires Node.js 24 (22.22 or newer works), PostgreSQL 18, and optionally a Deepgram key and a Bedrock key.

```bash
cd mcp && npm install && cp .env.example .env   # fill in DATABASE_URL and SERVICE_KEY
npm run dev                                     # the MCP server on port 8081
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

Measured, not claimed. Everything below is reproducible with the commands above.

### Tests

| Suite | Result |
|---|---|
| Ordering rules, model policy and text helpers | 21 passed |
| MCP server through the official TypeScript client against PostgreSQL (consent, the question asked once, learning, isolation between people, deleting, no consent or delete tool, 401 and host checks) | 8 passed |
| Browser tests in Chromium (consent gate, question once, choosing by key, learning, typing, one-switch scanning, deleting, copying the conversation, phone-sized screen, accessibility in every step, voice with a fake microphone) | 16 passed |

### The model on damaged transcripts

`mcp/scripts/probe.ts`, 20 invented transcripts such as "ah wan bed" (meant "I want to go to bed"), real model calls through the real code. Prices used for cost: 0.10 USD per million input tokens and 0.50 per million output tokens, given by the author, not from a price list we could read.

| | |
|---|---|
| Model order used (it passed the rules) | 19 of 20 (the other one was replaced by the rules) |
| The meant sentence first | 17 of 20 |
| The meant sentence among the six | 18 of 20 |
| Median time of a call | 1.6 s |
| Cost of the 20 calls | about 0.011 USD |

These transcripts were written by hand to look like unclear speech. They show that the format, the policy and the ordering work; they say nothing about real speech.

### Recordings of speakers with dysarthria (TORGO)

To be filled in with the measured numbers when the evaluation has run.

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
- **Model Context Protocol** TypeScript SDK, **Express**, **pg**, **zod** (MIT); **React**, **React Router**, **Vite**, **Playwright**, **axe-core** (MIT or MPL-2.0); **PostgreSQL**.

## How this was built

A coding assistant was used as a Code Assistant to accelerate development and debugging, under the direction and review of the author. The numbers in this README come from the commands above. Problems met on the way are in [FRICTION-LOG.md](FRICTION-LOG.md).

## License

MIT, see [LICENSE](LICENSE).
