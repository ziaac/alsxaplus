import type { Route } from "./+types/api.assistant";
import { McpError, callTool, rest } from "../server/mcp.server";
import { clearCookie, ensureSession, readToken, setCookie } from "../server/session.server";
import { VoiceError, checkLimits, clientId, voiceAvailable } from "../server/voice.server";

// One door for the page: POST /api/assistant { op, ... }. The visitor's token stays in the cookie.
//   status                      -> the profile's settings
//   consent { given }           -> the person (or carer) agrees or withdraws
//   speech_support { enabled }  -> the answer to "Do you have difficulty speaking?", asked once
//   suggest { heard }           -> one recommended sentence and five others
//   confirm { utterance_id, option | typed_text } -> save the choice; the sentence is what the person meant
//   phrases, forget { text }, delete

function reply(body: unknown, status: number, cookie?: string): Response {
  const headers = new Headers({ "cache-control": "no-store" });
  if (cookie) headers.append("set-cookie", cookie);
  return Response.json(body, { status, headers });
}

export async function action({ request }: Route.ActionArgs): Promise<Response> {
  if (request.method !== "POST") return reply({ error: "use POST" }, 405);
  // A JSON body cannot be sent by a plain cross-site form, which is part of how this door stays closed to other sites.
  if (!(request.headers.get("content-type") ?? "").includes("application/json")) return reply({ error: "send JSON" }, 415);
  let body: any;
  try {
    body = await request.json();
  } catch {
    return reply({ error: "the body must be JSON" }, 400);
  }
  const op = String(body?.op ?? "");
  try {
    checkLimits("assistant", clientId(request));
    let cookie: string | undefined;
    let token: string;
    if (op === "status") {
      const session = await ensureSession(request);
      token = session.token;
      if (session.fresh) cookie = setCookie(request, token);
    } else {
      const existing = readToken(request);
      if (!existing) return reply({ error: { code: "no_session", message: "The session has ended. Reload the page." } }, 401);
      token = existing;
    }

    switch (op) {
      case "status": {
        let status;
        try {
          status = await rest(token, "GET", "/api/me");
        } catch (error) {
          // The profile was deleted or expired: start a new one.
          if (!(error instanceof McpError) || error.status !== 401) throw error;
          const fresh = await ensureSession(new Request(request.url));
          token = fresh.token;
          cookie = setCookie(request, token);
          status = await rest(token, "GET", "/api/me");
        }
        return reply({ ...status, cloud_voice: voiceAvailable() }, 200, cookie);
      }
      case "consent":
        return reply(await rest(token, "POST", "/api/me/consent", { given: body.given === true }), 200);
      case "speech_support":
        return reply(await callTool(token, "set_speech_support", { enabled: body.enabled === true }), 200);
      case "suggest":
        return reply(await callTool(token, "suggest_meanings", { heard: Array.isArray(body.heard) ? body.heard : [] }), 200);
      case "confirm": {
        const args: Record<string, unknown> = { utterance_id: String(body.utterance_id ?? "") };
        if (Number.isInteger(body.option)) args.option = body.option;
        if (typeof body.typed_text === "string") args.typed_text = body.typed_text;
        return reply(await callTool(token, "confirm_meaning", args), 200);
      }
      case "phrases":
        return reply(await rest(token, "GET", "/api/me/phrases"), 200);
      case "forget":
        return reply(await rest(token, "DELETE", "/api/me/phrases", { text: String(body.text ?? "") }), 200);
      case "delete": {
        const out = await rest(token, "DELETE", "/api/me");
        return reply(out, 200, clearCookie(request));
      }
      default:
        return reply({ error: { code: "unknown_op", message: "Unknown request." } }, 400);
    }
  } catch (error) {
    if (error instanceof VoiceError) return reply({ error: { code: "rate_limited", message: error.message } }, error.status);
    if (error instanceof McpError) {
      const status = error.status >= 400 && error.status < 600 ? error.status : 502;
      return reply({ error: { code: error.code ?? "error", message: error.message } }, status, error.status === 401 ? clearCookie(request) : undefined);
    }
    console.error(`[api.assistant] ${op} failed:`, error);
    return reply({ error: { code: "server_error", message: "Something went wrong on our side." } }, 500);
  }
}
