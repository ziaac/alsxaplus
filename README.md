# ALSxaPlus

> When speech is unclear, a voice assistant often gives up. People whose speech is changed by ALS, cerebral palsy, Parkinson's disease, stroke or another condition are misheard again and again, and are left repeating themselves. ALSxaPlus estimates, from how sure and how consistent the recognisers are, when what it heard was hard to understand. It does not conclude anything from that: it asks the person once whether speaking is difficult for them, and remembers the answer. Then it shows the sentences they may have meant, says the one they choose aloud in a clear voice, and learns how *they* sound, so the next guess is better. It never decides by itself that someone has a disability, because unclear speech has many causes: the estimate only decides *whether to ask*, and only the person (or their carer) answers.
>
> It offers help for today and for the years ahead. Today, a person who is already hard to understand gets choices instead of "Sorry, I didn't get that". Later, as a condition such as ALS progresses and speech changes, the same profile keeps learning from every sentence the person confirms, so the help follows the voice as it changes instead of needing to be set up again. The choices can also be made by touch, keys or a single switch, so the help does not depend on speech at all when speech is no longer possible.

![Node.js 24](https://img.shields.io/badge/Node.js-24-5FA04E)
![React Router 8.4](https://img.shields.io/badge/React%20Router-8.4-CA4245)
![PostgreSQL 18](https://img.shields.io/badge/PostgreSQL-18-336791)
![MCP 2025-11-25](https://img.shields.io/badge/MCP-2025--11--25-1F2A44)

Built for the **Amazon Developer Hackathon 2026** (Devpost), Alexa+ track, with the AWS Builder mini challenge through Amazon Bedrock. It is an idea for an Alexa+ add-on for people with speech disabilities, starting with ALS, shown through a web simulation of a smart display that talks to a real MCP server.

Live demo: **https://alsxa.eziedutech.dev/sim** (a read-only copy: profiles are deleted after a day idle).

Status: **early build, deployed as a web simulation.** The MCP server, the simulated display, the speech path and the tests work. Each section below says which is which.

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

1. **Estimates, then asks once.** When what it heard was hard to understand (low confidence, or the recognisers disagree), it asks "Do you have difficulty speaking?" and remembers the answer. Clear speech is simply understood and nothing is asked. The estimate is never stored as a conclusion and never switches anything on: only the answer does. The question is not asked again unless the person changes it in the settings.
2. **Offers sentences instead of guessing.** For what was heard it shows one recommended sentence and five others, best first. The person picks by touch, with keys 1 to 6, or with one switch, or types their own words, or says it again. A guess never acts on its own.
3. **Speaks for the person.** The chosen sentence is said aloud in a clear voice.
4. **Learns.** The sentence the person chose, and the way the recogniser wrote the sounds, are saved together, so the next time those sounds come first.

What this means today: the first time something is hard to understand, the assistant asks the one question and remembers the answer (yes turns the help on, no leaves the assistant as usual, and it can be changed at any time). The estimate uses only the recognisers' confidence and whether they agree, so it can be wrong in both directions: a noisy room can trigger the question, and a mild impairment that the recognisers still understand will not, which is why the help can also be turned on in the settings. It does not judge a voice or a medical condition. Recognising a returning speaker by their sounds (not by a voiceprint) works through the learned sounds-to-sentence pairs of each profile. A trained detector of speech disability from the audio itself is **planned, not built**, and would need work with clinicians and with people who live with these conditions.

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

Open the live demo at https://alsxa.eziedutech.dev/sim, agree, type or say something unclear such as "ah wan bed", and choose a sentence. To run the checks on your own machine, see [Running locally](#running-locally).

1. `cd mcp && npm test`: 31 tests, 23 of the ordering rules, the estimate and the model policy, 8 through the **official MCP client** against a real database (needs `TEST_DATABASE_URL`).
2. `cd web && npm run e2e`: 17 browser tests, including automatic accessibility checks (axe-core, WCAG 2.1 A and AA) in every step, one-switch scanning, deleting data, and, when `DEEPGRAM_API_KEY` is set, a fake microphone that plays a synthetic voice through the three recognisers.
3. `cd mcp && npx tsx scripts/probe.ts` sends 20 damaged transcripts to the real model through the real code and reports how often its order passed the rules. It spends a little money.
4. `cd mcp && npx tsx scripts/torgo-eval.ts <folder>` and `npx tsx scripts/torgo-clarity.ts <folder> <controls folder>` measure the ordering and the estimate on TORGO recordings (see [Results](#results)).

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
| Ordering rules, the clarity estimate, model policy and text helpers | 23 passed |
| MCP server through the official TypeScript client against PostgreSQL (consent, clear speech not questioned, the question asked once, learning, isolation between people, deleting, no consent or delete tool, 401 and host checks) | 8 passed |
| Browser tests in Chromium (consent gate, question once, choosing by key, learning, typing, one-switch scanning, deleting, copying the conversation, phone-sized screen, accessibility in every step, voice with a fake microphone) | 17 passed |

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

TORGO holds recordings of 8 speakers with dysarthria (ALS, cerebral palsy) reading words and sentences. Used here only to measure, on this machine, with the three Deepgram recognisers; no audio is in this repository, and the recordings are not played in the demo video. 80 recordings per speaker, spread over their sessions, 640 in all (499 single words, 141 sentences of two or more words). The ordering below uses the plain rules only, with no language model.

**How good is the order of the six sentences?** Each speaker has a list of their own prompts (a phrase book of 68 to 79 entries) that the correct sentence is always part of, like a personal list of favourite phrases. We check whether the sentence that was really spoken is first.

| Recordings | n | Best transcript is exactly right | Right sentence first | Right sentence among the six |
|---|---|---|---|---|
| All | 640 | 42% (268/640) | 62% (399/640) | 75% (481/640) |
| One word | 499 | 44% | 55% (273/499) | 70% (348/499) |
| Two or more words | 141 | 33% (47/141) | 89% (126/141) | 94% (133/141) |
| Speaker F01 (hardest) | 80 | 18% | 33% (26/80) | 54% (43/80) |
| Speaker M03 (easiest) | 80 | 83% | 94% (75/80) | 98% (78/80) |

Offering a list of the person's own sentences raises how often the right sentence is first from 42% (the recogniser's best transcript, exactly right) to 62%, and it helps most for sentences. Speakers differ a lot, and for the speaker whom the recognisers understand least, the right sentence is among the six only 54% of the time. What this does **not** show: these are *closed* lists that already contain the answer, which is much easier than free speech; the "learned" effect is not measured fairly (only 36 recordings repeated a sentence, too few to say anything); and the recordings are read prompts in a lab. Per-speaker numbers are in the table the script prints.

**When would the question be asked?** The same recordings, plus recordings from 7 TORGO speakers without dysarthria (280 recordings), through the estimate described above.

| Recordings | n | Would be asked | Low confidence | Recognisers disagree |
|---|---|---|---|---|
| Speakers with dysarthria | 320 | 73% (232/320) | 48% | 50% |
| Speakers without dysarthria | 280 | 36% (100/280) | 17% | 25% |

The estimate does tell the groups apart: about twice as many recordings from speakers with dysarthria look unclear. But it is a weak signal for a person's first sentences: all 8 speakers with dysarthria would have been asked within their first 3 recordings, and so would 6 of the 7 speakers without it (most of the recordings are single words, which recognisers find hard for anyone). That is acceptable only because the question is asked once, costs one tap, and "No" leaves the assistant as usual; it would not be acceptable as a diagnosis, and it is not used as one. A better trigger (several unclear sentences in a row, or a trained model) is future work. Reproduce with `mcp/scripts/torgo-eval.ts` and `mcp/scripts/torgo-clarity.ts` after copying a subset with `scripts/extract_torgo_subset.py`.

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
