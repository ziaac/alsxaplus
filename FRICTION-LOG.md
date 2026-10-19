# Friction log: ALSxaPlus

Notes taken while building ALSxaPlus for the Amazon Developer Hackathon 2026, in the format the rules ask for: task, steps, expected, actual, severity, workaround, suggestion. Only things that really happened are listed. It was kept during the build, not written at the end.

## F1. Alexa+ developer tools cannot be installed from the public npm registry

- Task: try the Alexa+ MCP add-on tools (`alexa-ai` CLI, Local Inspector, web simulator) as a hackathon entrant with a developer account.
- Steps: read "Set Up Your Development Environment" and the MCP Toolkit quickstart, then looked for the packages on npm.
- Expected: `npm install -g @alexa-ai/cli` works, as the page suggests.
- Actual: `@alexa-ai/cli` and `@alexa-ai/addon-local-inspector` return 404 on the public registry. The setup page installs them through AWS CodeArtifact from Amazon's account, after the entrant gives an AWS account ID to an Alexa Solutions Architect. The pages describe no application form, no hackathon channel, and no way for an entrant to be assigned a Solutions Architect.
- Severity: high for an entrant without an existing contact at Amazon.
- Workaround: none from our side. The server was checked with the official MCP TypeScript SDK client instead, and the experience is a web simulation, which the rules allow.
- Suggestion: add an access request link to the Alexa+ docs and the hackathon resources page, and say how long it takes.

## F2. Deepgram Nova models return only one transcript

- Task: get several different guesses for the same unclear speech, so a person can be shown several sentences.
- Steps: asked `listen` for `alternatives=3` with `nova-3` and `nova-2`.
- Expected: up to three alternative transcripts, as the parameter name suggests.
- Actual: HTTP 400, "Nova-3 models do not support more than one alternative" (and the same for Nova-2). Only the older `base` model returned three.
- Severity: medium: it removes the cheapest source of diversity exactly for the use case where the first guess is most often wrong.
- Workaround: ask three models in parallel (`nova-3`, `nova-2`, and `base` with three alternatives) and keep the distinct transcripts. They fail in different ways, which is useful evidence.
- Suggestion: return n-best alternatives (or word-level alternatives) for the current models, and list in the docs which models accept `alternatives`.

## F3. A model that is forced to call a tool still sometimes returns nothing, or adds fields

- Task: have Claude Haiku order a list of candidate sentences by calling one tool.
- Steps: forced the tool with `toolChoice`, with a schema that had `choices: [{ id | text }]`.
- Expected: always an object that matches the schema.
- Actual: in a first probe the model wrote both `id` and `text` for each choice (copying the sentence beside its id); about one call in ten came back as an empty object `{}` despite `required: ["choices"]`.
- Severity: low once handled, high if the answer is used without checking.
- Workaround: the checking code accepts an id with the same sentence beside it and rejects a different one; an empty answer is asked for once more, then the rules decide; the ids the model may use are listed as an `enum` in the schema.
- Suggestion: say in the Converse documentation that `required` is not enforced for forced tool calls, and offer a strict mode.

## F4. The Alexa+ MCP documentation assumes the server receives what the user said, but not the audio

- Task: design an add-on that helps when speech is unclear.
- Steps: read the MCP Toolkit overview and design guide.
- Expected: a way for an add-on to receive the recognised alternatives, or the audio, of an utterance.
- Actual: the add-on receives tool calls with text chosen by Alexa+ itself, so the recogniser's mistakes are invisible to the server. An add-on cannot see what was really heard, only what Alexa+ decided to pass on.
- Severity: high for accessibility use cases.
- Workaround: the simulation does its own recognition (three Deepgram models) and passes every alternative to the server's `suggest_meanings` tool, which a real Alexa+ model could do if it were allowed to pass the n-best list.
- Suggestion: let a tool declare that it wants the speech recogniser's n-best list, with confidences, for the utterance that triggered it.

## F5. The Rust MCP SDK rejects a tool call that comes without a handshake, and the switch for it is named "legacy session mode"

- Task: serve the MCP tools from Rust with `rmcp` 3.5.1, without keeping a session, because every request carries its own bearer token.
- Steps: built the Streamable HTTP service with the default configuration, then called `tools/call` directly, as the web simulation does.
- Expected: a stateless server answers the call, as the TypeScript SDK's stateless mode does.
- Actual: HTTP 422, "Unexpected message, expect initialize request". The default keeps a session per client, and nothing in the error says how to turn that off.
- Severity: low once known, but it cost a test run.
- Workaround: `StreamableHttpServerConfig::default().with_legacy_session_mode(false)`. The server then answers direct calls and still completes the normal handshake for the official client (checked with the official TypeScript client).
- Suggestion: name the stateless option `stateless` in the docs and the builder, and mention it in the error text.
