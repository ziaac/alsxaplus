import type { Route } from "./+types/api.voice";
import { VoiceError, checkLimits, clientId, speak, transcribe, voiceAvailable } from "../server/voice.server";

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });

// GET /api/voice: is cloud speech set up on this server?
export async function loader(): Promise<Response> {
  return json({ available: voiceAvailable() });
}

// POST /api/voice?op=transcribe (audio body) -> { heard: [{ text, confidence, model }] }
// POST /api/voice?op=speak ({ text }) -> audio/mpeg
export async function action({ request }: Route.ActionArgs): Promise<Response> {
  if (request.method !== "POST") return json({ error: "use POST" }, 405);
  const op = new URL(request.url).searchParams.get("op");
  try {
    if (op === "transcribe") {
      checkLimits("transcribe", clientId(request));
      const heard = await transcribe(await request.arrayBuffer(), request.headers.get("content-type") ?? "");
      return json({ heard });
    }
    if (op === "speak") {
      checkLimits("speak", clientId(request));
      let body: any;
      try {
        body = await request.json();
      } catch {
        return json({ error: "the body must be JSON" }, 400);
      }
      const audio = await speak(typeof body?.text === "string" ? body.text : "");
      return new Response(audio, { headers: { "content-type": "audio/mpeg", "cache-control": "no-store" } });
    }
    return json({ error: "unknown op" }, 400);
  } catch (error) {
    if (error instanceof VoiceError) return json({ error: error.message }, error.status);
    console.error(`[api.voice] ${op} failed:`, error);
    return json({ error: "The voice service failed." }, 500);
  }
}
