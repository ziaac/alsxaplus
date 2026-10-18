// Speech for the simulation, through Deepgram. The key lives only in this server process: the browser sends short audio
// here and gets words back, and sends a sentence here and gets audio back. Nothing is stored. Every request asks Deepgram
// not to use the audio for model improvement (mip_opt_out). Limits keep a public demo from running up the bill.
import { env } from "./env.server";

const DEEPGRAM = "https://api.deepgram.com/v1";
const MAX_AUDIO_BYTES = 600_000;
const MAX_TEXT_CHARS = 300;
const MAX_ATTEMPTS = 3;
const BACKOFF_MS = 400;
const LIMITS = {
  transcribe: { perMinute: 12, perDay: 1500 },
  speak: { perMinute: 40, perDay: 4000 },
  assistant: { perMinute: 60, perDay: 20000 },
} as const;

export type LimitKind = keyof typeof LIMITS;

export class VoiceError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

const apiKey = () => env("DEEPGRAM_API_KEY") ?? null;
export const voiceAvailable = () => apiKey() !== null;

// ---- limits (in memory; they start again when the server restarts) ----

const recent = new Map<string, number[]>();
const daily = { day: "", counts: { transcribe: 0, speak: 0, assistant: 0 } };

export function clientId(request: Request): string {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
}

/** Throws a 429 when this client or the whole demo has used too much. */
export function checkLimits(kind: LimitKind, client: string): void {
  // Only the automatic tests switch the limits off, because they make far more requests than a person would.
  if (env("DISABLE_LIMITS") === "true") return;
  const now = Date.now();
  const today = new Date(now).toISOString().slice(0, 10);
  if (daily.day !== today) {
    daily.day = today;
    daily.counts = { transcribe: 0, speak: 0, assistant: 0 };
  }
  if (daily.counts[kind] >= LIMITS[kind].perDay) {
    console.warn(`[limits] daily limit for ${kind} reached`);
    throw new VoiceError("The demo has reached its limit for today. Typing and tapping still work.", 429);
  }
  const key = `${kind}:${client}`;
  const times = (recent.get(key) ?? []).filter((t) => now - t < 60_000);
  if (times.length >= LIMITS[kind].perMinute) {
    console.warn(`[limits] ${kind}: client ${client} is over ${LIMITS[kind].perMinute} a minute`);
    throw new VoiceError("That was a lot of requests. Please wait a moment.", 429);
  }
  times.push(now);
  recent.set(key, times);
  daily.counts[kind] += 1;
  if (recent.size > 2000) recent.clear();
}

// ---- Deepgram calls ----

async function deepgram(path: string, init: RequestInit, what: string): Promise<Response> {
  const key = apiKey();
  if (!key) throw new VoiceError("Voice is not set up on this server.", 503);
  let lastError = "";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(`${DEEPGRAM}${path}`, {
        ...init,
        headers: { ...(init.headers as Record<string, string>), authorization: `Token ${key}` },
        signal: AbortSignal.timeout(15_000),
      });
      if ([429, 502, 503, 504].includes(res.status) && attempt < MAX_ATTEMPTS) {
        console.warn(`[voice] ${what}: HTTP ${res.status}, retry ${attempt}/${MAX_ATTEMPTS - 1} after ${BACKOFF_MS * attempt} ms`);
        await new Promise((r) => setTimeout(r, BACKOFF_MS * attempt));
        continue;
      }
      if (!res.ok) {
        // The body of an error holds a code and a message, never the key. Audio is never logged.
        console.error(`[voice] ${what} failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
        throw new VoiceError("The voice service could not do that right now.", 502);
      }
      return res;
    } catch (error) {
      if (error instanceof VoiceError) throw error;
      lastError = (error as Error).message;
      console.warn(`[voice] ${what}: request failed (${lastError}), attempt ${attempt}/${MAX_ATTEMPTS}`);
      if (attempt < MAX_ATTEMPTS) await new Promise((r) => setTimeout(r, BACKOFF_MS * attempt));
    }
  }
  console.error(`[voice] ${what}: giving up: ${lastError}`);
  throw new VoiceError("The voice service could not be reached.", 502);
}

export interface Heard {
  text: string;
  confidence: number;
  model: string;
}

// Nova-3 and Nova-2 return one transcript each, the older base model can return several. Asking all of them gives
// different guesses for the same sounds, which is exactly what unclear speech needs.
const ENSEMBLE: { model: string; alternatives: number }[] = [
  { model: "nova-3", alternatives: 1 },
  { model: "nova-2", alternatives: 1 },
  { model: "base", alternatives: 3 },
];

const clean = (text: string) => text.replace(/[\s.,!?;:]+$|^[\s.,!?;:]+/g, "").replace(/\s+/g, " ").trim();

export async function transcribe(audio: ArrayBuffer, contentType: string): Promise<Heard[]> {
  if (audio.byteLength === 0) throw new VoiceError("No audio was received.", 400);
  if (audio.byteLength > MAX_AUDIO_BYTES) throw new VoiceError("That recording is too long. A short phrase is enough.", 413);
  if (!/^audio\/|^video\/webm/.test(contentType)) throw new VoiceError("That is not an audio recording.", 415);

  const results = await Promise.allSettled(
    ENSEMBLE.map(async ({ model, alternatives }) => {
      const params = new URLSearchParams({ model, language: "en", alternatives: String(alternatives), mip_opt_out: "true" });
      const res = await deepgram(`/listen?${params}`, { method: "POST", headers: { "content-type": contentType }, body: audio }, `transcribe ${model}`);
      const json: any = await res.json();
      const alts: any[] = json?.results?.channels?.[0]?.alternatives ?? [];
      return alts.map((a) => ({ text: clean(String(a?.transcript ?? "")), confidence: Number(a?.confidence ?? 0), model }));
    }),
  );
  const heard: Heard[] = [];
  const seen = new Set<string>();
  let failures = 0;
  for (const r of results) {
    if (r.status === "rejected") {
      failures++;
      continue;
    }
    for (const h of r.value) {
      const key = h.text.toLowerCase();
      if (h.text && !seen.has(key)) {
        seen.add(key);
        heard.push(h);
      }
    }
  }
  if (failures === results.length) throw new VoiceError("The voice service could not be reached.", 502);
  if (failures > 0) console.warn(`[voice] ${failures} of ${results.length} recognisers failed; using the others`);
  return heard.sort((a, b) => b.confidence - a.confidence).slice(0, 5);
}

const speechCache = new Map<string, ArrayBuffer>();

export async function speak(text: string): Promise<ArrayBuffer> {
  const sentence = text.replace(/\s+/g, " ").trim();
  if (!sentence) throw new VoiceError("There is nothing to say.", 400);
  if (sentence.length > MAX_TEXT_CHARS) throw new VoiceError("That text is too long to read aloud.", 413);
  const cached = speechCache.get(sentence);
  if (cached) return cached;
  const params = new URLSearchParams({ model: "aura-2-thalia-en", mip_opt_out: "true" });
  const res = await deepgram(`/speak?${params}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: sentence }) }, "speak");
  const audio = await res.arrayBuffer();
  if (speechCache.size >= 100) speechCache.delete(speechCache.keys().next().value as string);
  speechCache.set(sentence, audio);
  return audio;
}
