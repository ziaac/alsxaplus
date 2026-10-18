// The MCP tools. One server object is made per request and is bound to the person whose token opened it,
// so a tool can only ever see that person's data. Consent and deleting data are not tools on purpose: a voice
// assistant must never be able to give consent for someone or erase their data. Those are plain app actions.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { confirmMeaning, type Deps, getStatus, listPhrases, ServiceError, setSpeechSupport, suggestMeanings } from "./service.js";

type Structured = Record<string, unknown>;

function ok(out: Structured) {
  return { content: [{ type: "text" as const, text: String(out.spoken ?? "Done.") }], structuredContent: out };
}

function failure(code: string, message: string) {
  return { isError: true, content: [{ type: "text" as const, text: message }], structuredContent: { error: { code, message } } };
}

async function run(tool: string, fn: () => Promise<Structured>) {
  try {
    return ok(await fn());
  } catch (error) {
    if (error instanceof ServiceError) {
      console.info(`[mcp] ${tool} rejected the request: ${error.code}`);
      return failure(error.code, error.message);
    }
    console.error(`[mcp] ${tool} failed:`, error);
    return failure("server_error", "Something went wrong on our side. Please try again in a moment.");
  }
}

export function createMcpServer(deps: Deps, profileId: string): McpServer {
  const server = new McpServer({ name: "alsxaplus", version: "0.1.0" });

  server.registerTool(
    "get_status",
    {
      title: "Get status",
      description:
        "Tell whether the person has agreed to use ALSxaPlus and whether the question about difficulty speaking has been answered. Use it first in a conversation.",
    },
    async () => run("get_status", async () => ({ ...(await getStatus(deps.db, profileId)), spoken: "Here is the current setting." })),
  );

  server.registerTool(
    "set_speech_support",
    {
      title: "Set speech support",
      description:
        "Record the person's answer to 'Do you have difficulty speaking?'. Ask it only once, the first time, and never again unless the person asks to change it. enabled=true turns suggestions on for every later utterance.",
      inputSchema: { enabled: z.boolean().describe("true if the person said they have difficulty speaking and want suggestions") },
    },
    async ({ enabled }) =>
      run("set_speech_support", async () => ({
        ...(await setSpeechSupport(deps.db, profileId, enabled)),
        spoken: enabled ? "Thank you. From now on I will offer sentences for what you say." : "Okay. I will listen as usual. You can change this at any time.",
      })),
  );

  server.registerTool(
    "suggest_meanings",
    {
      title: "Suggest what the person meant",
      description:
        "Use this when a person who has difficulty speaking has said something. Pass every transcript alternative you have for what was heard, even if it looks wrong. Returns one recommended sentence and five others to show on the screen, best first. Read 'spoken' aloud, show the options, and let the person choose or type. Never act on a suggestion before the person confirms it.",
      inputSchema: {
        heard: z
          .array(
            z.object({
              text: z.string().max(200).describe("one transcript alternative, exactly as written by the recognizer"),
              confidence: z.number().min(0).max(1).optional().describe("recognizer confidence from 0 to 1, if known"),
            }),
          )
          .max(5)
          .describe("what the recognizer heard, best first; may be empty if nothing was recognised"),
      },
    },
    async ({ heard }) => run("suggest_meanings", async () => (await suggestMeanings(deps, profileId, heard)) as unknown as Structured),
  );

  server.registerTool(
    "confirm_meaning",
    {
      title: "Confirm what the person meant",
      description:
        "Call this after the person chose one of the options (give option 0 to 5, where 0 is the recommended sentence) or typed their own sentence (give typed_text). The choice is saved so later suggestions fit this person better. Read 'spoken' aloud: it is the sentence the person meant to say.",
      inputSchema: {
        utterance_id: z.string().describe("the id that suggest_meanings returned"),
        option: z.number().int().min(0).max(5).optional().describe("the position of the chosen option, 0 for the recommended sentence"),
        typed_text: z.string().max(200).optional().describe("the sentence the person typed, if none of the options was right"),
      },
    },
    async ({ utterance_id, option, typed_text }) =>
      run("confirm_meaning", async () => ({ ...(await confirmMeaning(deps.db, profileId, { utteranceId: utterance_id, option, typedText: typed_text })) })),
  );

  server.registerTool(
    "list_my_phrases",
    {
      title: "List the person's own sentences",
      description: "List the sentences this person has confirmed, most used first. Use it when the person asks what has been learned.",
      inputSchema: { limit: z.number().int().min(1).max(50).optional() },
    },
    async ({ limit }) =>
      run("list_my_phrases", async () => {
        const phrases = await listPhrases(deps.db, profileId, limit ?? 20);
        return { phrases, spoken: phrases.length ? `You have ${phrases.length} saved sentences. The most used is: ${phrases[0]?.text}.` : "Nothing has been saved yet." };
      }),
  );

  return server;
}
