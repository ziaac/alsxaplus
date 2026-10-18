// Records one short phrase from the microphone and sends it to this app's own server for transcription.
// The recording starts at once, ends about a second after the child stops talking (or after 10 seconds, or when stop()
// is called), is sent once, and is never kept by the page.

const SPEECH_LEVEL = 0.035; // how loud counts as talking, on a scale from 0 to 1
const SILENCE_MS = 1600; // how long a pause ends the phrase (longer than usual: people with unclear speech pause more)
const MAX_MS = 12_000;
const GIVE_UP_IF_SILENT_MS = 8_000;

export interface Utterance {
  /** Ends the recording now. */
  stop: () => void;
  /** The recording, or null if nobody spoke. */
  blob: Promise<Blob | null>;
}

function pickMime(): string | undefined {
  for (const m of ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"]) {
    if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(m)) return m;
  }
  return undefined;
}

export async function recordUtterance(): Promise<Utterance> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  const mime = pickMime();
  const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  const chunks: Blob[] = [];
  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  };

  const audioContext = new AudioContext();
  const analyser = audioContext.createAnalyser();
  analyser.fftSize = 1024;
  audioContext.createMediaStreamSource(stream).connect(analyser);
  const samples = new Uint8Array(analyser.fftSize);

  const started = performance.now();
  let lastVoice = started;
  let heard = false;

  const blob = new Promise<Blob | null>((resolve) => {
    recorder.onstop = () => {
      clearInterval(timer);
      stream.getTracks().forEach((t) => t.stop());
      void audioContext.close();
      resolve(heard && chunks.length > 0 ? new Blob(chunks, { type: recorder.mimeType || mime || "audio/webm" }) : null);
    };
  });

  const stop = () => {
    if (recorder.state !== "inactive") recorder.stop();
  };

  const timer = setInterval(() => {
    analyser.getByteTimeDomainData(samples);
    let sum = 0;
    for (const v of samples) sum += ((v - 128) / 128) ** 2;
    const level = Math.sqrt(sum / samples.length);
    const now = performance.now();
    if (level > SPEECH_LEVEL) {
      heard = true;
      lastVoice = now;
    }
    if (heard && now - lastVoice > SILENCE_MS) stop();
    else if (now - started > MAX_MS) stop();
    else if (!heard && now - started > GIVE_UP_IF_SILENT_MS) stop();
  }, 100);

  recorder.start(250);
  return { stop, blob };
}

export interface Heard {
  text: string;
  confidence: number;
  model?: string;
}

/** Sends a recording to the server and returns what several recognisers heard, best first. */
export async function transcribe(blob: Blob): Promise<Heard[]> {
  const res = await fetch("/api/voice?op=transcribe", { method: "POST", headers: { "content-type": blob.type || "audio/webm" }, body: blob });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json?.error ?? `the voice service answered HTTP ${res.status}`);
  return Array.isArray(json.heard) ? json.heard : [];
}

let current: HTMLAudioElement | null = null;

export function stopSpeaking(): void {
  current?.pause();
  current = null;
}

/** Reads a sentence aloud with the server's voice. Returns false if it could not, so the caller can use the browser's voice. */
export async function speakCloud(text: string): Promise<boolean> {
  try {
    const res = await fetch("/api/voice?op=speak", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) });
    if (!res.ok) {
      console.warn(`[voice] speaking failed: HTTP ${res.status}`);
      return false;
    }
    const url = URL.createObjectURL(await res.blob());
    stopSpeaking();
    const audio = new Audio(url);
    current = audio;
    audio.onended = () => URL.revokeObjectURL(url);
    await audio.play();
    return true;
  } catch (error) {
    // A newer sentence cut this one short on purpose: that is not a failure.
    if (error instanceof DOMException && error.name === "AbortError") return true;
    console.warn("[voice] speaking failed:", error);
    return false;
  }
}
