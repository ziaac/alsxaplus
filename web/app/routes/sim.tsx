import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import type { Route } from "./+types/sim";
import { recordUtterance, speakCloud, stopSpeaking, transcribe, type Heard, type Utterance } from "../lib/mic";

export function meta({}: Route.MetaArgs) {
  return [{ title: "Simulation: ALSxaPlus" }, { name: "description", content: "A simulated smart display that offers sentences for what a person with unclear speech said." }];
}

type Phase = "loading" | "consent" | "idle" | "listening" | "thinking" | "ask_support" | "choose" | "said";

interface Status {
  consent: boolean;
  speech_support: boolean | null;
  phrases: number;
  learned_sounds: number;
  cloud_voice: boolean;
}

interface Option {
  rank: number;
  text: string;
  origin: string;
}

interface Suggestion {
  utterance_id: string;
  options: Option[];
  source: "agent" | "rule";
  heard_nothing: boolean;
}

interface Line {
  id: number;
  who: "you" | "assistant";
  text: string;
}

class ApiError extends Error {
  constructor(
    message: string,
    readonly code?: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

async function assistant(body: Record<string, unknown>): Promise<any> {
  const res = await fetch("/api/assistant", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(json?.error?.message ?? `the server answered HTTP ${res.status}`, json?.error?.code, res.status);
  return json;
}

function speakBrowser(text: string): void {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(new SpeechSynthesisUtterance(text));
}

const SCAN_MS = 2400;

export default function Sim() {
  const [phase, setPhase] = useState<Phase>("loading");
  const [status, setStatus] = useState<Status | null>(null);
  const [suggestion, setSuggestion] = useState<Suggestion | null>(null);
  const [heard, setHeard] = useState<Heard[]>([]);
  const [said, setSaid] = useState("");
  const [lines, setLines] = useState<Line[]>([]);
  const [notice, setNotice] = useState("");
  const [typed, setTyped] = useState("");
  const [none, setNone] = useState("");
  const [agree, setAgree] = useState(false);
  const [readAloud, setReadAloud] = useState(true);
  const [scan, setScan] = useState(false);
  const [scanAt, setScanAt] = useState(0);
  const [phrases, setPhrases] = useState<{ text: string; uses: number }[] | null>(null);
  const [armed, setArmed] = useState(false);
  const [copyNote, setCopyNote] = useState("");
  const nextLine = useRef(1);
  const pending = useRef<Heard[] | null>(null);
  const recording = useRef<Utterance | null>(null);
  const firstOption = useRef<HTMLButtonElement>(null);
  const sayAgainButton = useRef<HTMLButtonElement>(null);
  const flags = useRef({ readAloud: true, cloud: false });

  useEffect(() => {
    flags.current.readAloud = readAloud;
    if (!readAloud) {
      stopSpeaking();
      if (typeof window !== "undefined" && "speechSynthesis" in window) window.speechSynthesis.cancel();
    }
  }, [readAloud]);

  const say = useCallback((who: Line["who"], text: string, aloud = false) => {
    if (!text) return;
    setLines((l) => [...l, { id: nextLine.current++, who, text }]);
    if (aloud && flags.current.readAloud) {
      if (flags.current.cloud) void speakCloud(text).then((ok) => ok || speakBrowser(text));
      else speakBrowser(text);
    }
  }, []);

  const fail = useCallback((error: unknown, what: string) => {
    console.error(`[sim] ${what}:`, error);
    setNotice(error instanceof Error ? error.message : "Something went wrong.");
  }, []);

  const loadStatus = useCallback(async () => {
    try {
      const s: Status = await assistant({ op: "status" });
      flags.current.cloud = s.cloud_voice;
      setStatus(s);
      setPhase(s.consent ? "idle" : "consent");
    } catch (error) {
      fail(error, "loading the status");
      setPhase("idle");
    }
  }, [fail]);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  // ---------- the flow ----------

  const suggest = useCallback(
    async (alternatives: Heard[]) => {
      setPhase("thinking");
      try {
        const res = await assistant({ op: "suggest", heard: alternatives.map((h) => ({ text: h.text, confidence: h.confidence })) });
        if (res.status === "needs_speech_support_answer") {
          pending.current = alternatives;
          setPhase("ask_support");
          say("assistant", res.spoken, true);
          return;
        }
        if (res.status === "no_help_needed") {
          setPhase("idle");
          say("assistant", res.spoken, true);
          return;
        }
        if (res.status === "speech_support_off") {
          setPhase("idle");
          setNotice("Speech support is off. Turn it on in the settings to get suggestions.");
          return;
        }
        setSuggestion(res);
        setPhase("choose");
        say("assistant", res.spoken, false);
        const first = res.options?.[0]?.text;
        if (first) say("assistant", `Did you mean: ${first}`, true);
      } catch (error) {
        fail(error, "asking for suggestions");
        setPhase("idle");
      }
    },
    [fail, say],
  );

  const onHeard = useCallback(
    async (alternatives: Heard[]) => {
      setNotice("");
      setHeard(alternatives);
      say("you", alternatives[0]?.text ? alternatives[0].text : "(nothing was recognised)");
      await suggest(alternatives);
    },
    [say, suggest],
  );

  const answerSupport = async (enabled: boolean) => {
    try {
      const res = await assistant({ op: "speech_support", enabled });
      setStatus((s) => (s ? { ...s, speech_support: res.speech_support, phrases: res.phrases, learned_sounds: res.learned_sounds } : s));
      say("assistant", res.spoken, true);
      const waiting = pending.current;
      pending.current = null;
      if (enabled && waiting) await suggest(waiting);
      else setPhase("idle");
    } catch (error) {
      fail(error, "saving the answer");
    }
  };

  const confirm = useCallback(
    async (body: { option?: number; typed_text?: string }) => {
      if (!suggestion) return;
      try {
        const res = await assistant({ op: "confirm", utterance_id: suggestion.utterance_id, ...body });
        setStatus((s) => (s ? { ...s, learned_sounds: res.learned_sounds, phrases: Math.max(s.phrases, 1) } : s));
        setSaid(res.text);
        setPhase("said");
        say("assistant", `Saying: ${res.text}`, false);
        if (flags.current.readAloud) {
          if (flags.current.cloud) void speakCloud(res.text).then((ok) => ok || speakBrowser(res.text));
          else speakBrowser(res.text);
        }
        setPhrases(null);
      } catch (error) {
        fail(error, "saving the choice");
      }
    },
    [fail, say, suggestion],
  );

  const sayAgain = () => {
    stopSpeaking();
    setSuggestion(null);
    setNone("");
    setPhase("idle");
  };

  const giveConsent = async () => {
    try {
      const s = await assistant({ op: "consent", given: true });
      setStatus((old) => ({ ...(old as Status), ...s }));
      setPhase("idle");
    } catch (error) {
      fail(error, "saving consent");
    }
  };

  // ---------- microphone ----------

  const listen = async () => {
    if (recording.current) {
      recording.current.stop();
      return;
    }
    try {
      stopSpeaking();
      setNotice("");
      const utterance = await recordUtterance();
      recording.current = utterance;
      setPhase("listening");
      const blob = await utterance.blob;
      recording.current = null;
      if (!blob) {
        setPhase("idle");
        setNotice("I did not hear anything. Try again, or type it.");
        return;
      }
      setPhase("thinking");
      const alternatives = await transcribe(blob);
      await onHeard(alternatives);
    } catch (error) {
      recording.current = null;
      const denied = error instanceof DOMException && (error.name === "NotAllowedError" || error.name === "NotFoundError");
      console.error("[sim] listening failed:", error);
      setNotice(denied ? "I cannot use the microphone. Allow it in the browser, or type instead." : "I could not hear that. You can type instead.");
      setPhase("idle");
    }
  };

  // ---------- keyboard and one-switch scanning ----------

  const optionCount = suggestion?.options.length ?? 0;
  const targets = optionCount + 1; // the options, then "Say it again"

  useEffect(() => {
    if (phase !== "choose") return;
    setScanAt(0);
    firstOption.current?.focus();
  }, [phase, suggestion]);

  useEffect(() => {
    if (phase !== "choose" || !scan) return;
    const id = setInterval(() => setScanAt((i) => (i + 1) % targets), SCAN_MS);
    return () => clearInterval(id);
  }, [phase, scan, targets]);

  const selectScanned = useCallback(() => {
    if (scanAt < optionCount) void confirm({ option: scanAt });
    else sayAgain();
  }, [confirm, optionCount, scanAt]);

  useEffect(() => {
    if (phase !== "choose") return;
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      // Only a box where letters are typed keeps the keys for itself; a check box or a button does not.
      const typing = el && (el.tagName === "TEXTAREA" || (el.tagName === "INPUT" && ["text", "search", "email", "url", "tel", "password"].includes((el as HTMLInputElement).type)));
      if (typing) return;
      if (scan && (e.key === " " || e.key === "Enter")) {
        e.preventDefault();
        selectScanned();
        return;
      }
      const n = Number(e.key);
      if (Number.isInteger(n) && n >= 1 && n <= optionCount) {
        e.preventDefault();
        void confirm({ option: n - 1 });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [phase, scan, optionCount, confirm, selectScanned]);

  // ---------- settings ----------

  const toggleSupport = async (enabled: boolean) => {
    try {
      const res = await assistant({ op: "speech_support", enabled });
      setStatus((s) => (s ? { ...s, speech_support: res.speech_support } : s));
      setNotice(enabled ? "Speech support is on." : "Speech support is off.");
    } catch (error) {
      fail(error, "changing speech support");
    }
  };

  const loadPhrases = async () => {
    try {
      setPhrases((await assistant({ op: "phrases" })).phrases);
    } catch (error) {
      fail(error, "loading the saved sentences");
    }
  };

  const forget = async (text: string) => {
    try {
      await assistant({ op: "forget", text });
      await loadPhrases();
      setStatus((s) => (s ? { ...s, phrases: Math.max(0, s.phrases - 1) } : s));
    } catch (error) {
      fail(error, "forgetting a sentence");
    }
  };

  const deleteAll = async () => {
    try {
      await assistant({ op: "delete" });
      setArmed(false);
      setLines([]);
      setSuggestion(null);
      setPhrases(null);
      setNotice("Everything about you was deleted.");
      setPhase("loading");
      await loadStatus();
    } catch (error) {
      fail(error, "deleting the data");
    }
  };

  const copyConversation = async () => {
    const text = lines.map((l) => `${l.who === "you" ? "You" : "Assistant"}: ${l.text}`).join("\n");
    try {
      await navigator.clipboard.writeText(text);
      setCopyNote("Copied. You can paste it into a message.");
    } catch (error) {
      console.warn("[sim] could not copy the conversation:", error);
      setCopyNote("Your browser did not allow copying.");
    }
  };

  const submitTyped = (event: React.FormEvent) => {
    event.preventDefault();
    const text = typed.trim();
    if (!text) return;
    setTyped("");
    void onHeard([{ text, confidence: 0.5 }]);
  };

  const submitNone = (event: React.FormEvent) => {
    event.preventDefault();
    const text = none.trim();
    if (!text) return;
    setNone("");
    void confirm({ typed_text: text });
  };

  const busy = phase === "loading" || phase === "thinking";

  return (
    <main id="main" className="page">
      <header className="site-head">
        <nav aria-label="Breadcrumb" className="crumbs">
          <Link to="/">Home</Link>
          <span aria-hidden="true">/</span>
          <span aria-current="page">Simulation</span>
        </nav>
        <p className="badge">Simulation: a stand-in for a smart display, not a real device</p>
      </header>

      <div className="sim-body">
        <section className="screen" aria-label="Display" aria-busy={busy}>
          {notice ? (
            <p className="notice" role="status">
              {notice}
            </p>
          ) : null}

          {phase === "loading" || phase === "thinking" ? (
            <div className="skeleton" aria-label={phase === "loading" ? "Loading" : "Working out what you meant"}>
              <p className="prompt">{phase === "thinking" ? "Working out what you meant…" : "Loading…"}</p>
              <div className="sk" />
              <div className="sk" />
              <div className="sk" />
            </div>
          ) : null}

          {phase === "consent" ? (
            <div>
              <h1>Before we start</h1>
              <p>
                ALSxaPlus helps when speech is unclear. It keeps the sentences you choose, and the way they were written down by the recogniser, so its next guesses fit you better. It never keeps recordings. You can
                see what it has learned and delete everything at any time. A carer may agree for you. <Link to="/privacy">Read the privacy page</Link>.
              </p>
              <label className="toggle">
                <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} />
                <span>I agree, or I am the carer and I agree for this person.</span>
              </label>
              <p className="row" style={{ marginTop: 16 }}>
                <button className="big primary" type="button" disabled={!agree} onClick={() => void giveConsent()}>
                  Agree and start
                </button>
              </p>
            </div>
          ) : null}

          {phase === "idle" || phase === "listening" ? (
            <div>
              <h1 className="prompt">{phase === "listening" ? "Listening. Say it, then pause." : "Say something. I will help with what you mean."}</h1>
              <div className="row" style={{ marginBottom: 14 }}>
                {status?.cloud_voice ? (
                  <button className="big primary" type="button" onClick={() => void listen()} aria-pressed={phase === "listening"}>
                    {phase === "listening" ? (
                      <>
                        <span className="pulse" aria-hidden="true" /> Stop
                      </>
                    ) : (
                      "Speak"
                    )}
                  </button>
                ) : null}
                {status?.speech_support === false ? (
                  <button className="big" type="button" onClick={() => void toggleSupport(true)}>
                    Turn speech support on
                  </button>
                ) : null}
              </div>
              <form className="type-form" onSubmit={submitTyped}>
                <label htmlFor="typed" className="sr-only">
                  Type what you said, as the recogniser might write it
                </label>
                <input id="typed" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="Type what you said, for example: ah wan wa er" autoComplete="off" />
                <button className="big" type="submit" disabled={!typed.trim() || phase === "listening"}>
                  Send
                </button>
              </form>
              <p className="heard">Typing stands in for the microphone, so the simulation also works without one.</p>
            </div>
          ) : null}

          {phase === "ask_support" ? (
            <div>
              <h1 className="prompt">Do you have difficulty speaking?</h1>
              <p>I had some trouble understanding that. That can have many causes, so I am asking instead of assuming. I will only ask once. If you say yes, I will offer sentences for what you say. You can change this in the settings.</p>
              <div className="row">
                <button className="big primary" type="button" onClick={() => void answerSupport(true)} autoFocus>
                  Yes
                </button>
                <button className="big" type="button" onClick={() => void answerSupport(false)}>
                  No
                </button>
              </div>
            </div>
          ) : null}

          {phase === "choose" && suggestion ? (
            <div>
              <p className="heard">
                I heard: <strong>{heard[0]?.text || "nothing clear"}</strong>
                {heard.length > 1 ? ` (and ${heard.length - 1} other way${heard.length > 2 ? "s" : ""} of writing it)` : ""}
              </p>
              <h1 className="prompt">Did you mean:</h1>
              <ol className="options">
                {suggestion.options.map((o, i) => (
                  <li key={o.rank}>
                    <button
                      ref={i === 0 ? firstOption : undefined}
                      type="button"
                      className={`option${i === 0 ? " recommended" : ""}${scan && scanAt === i ? " scanning" : ""}`}
                      onClick={() => void confirm({ option: i })}
                    >
                      <span className="num" aria-hidden="true">
                        {i + 1}
                      </span>
                      <span>Yes: {o.text}</span>
                      {i === 0 ? <span className="tag">Recommended</span> : null}
                    </button>
                  </li>
                ))}
              </ol>
              <form className="type-form" onSubmit={submitNone}>
                <label htmlFor="none" className="sr-only">
                  None of these. Type what you meant
                </label>
                <input id="none" value={none} onChange={(e) => setNone(e.target.value)} placeholder="None of these? Type what you meant" autoComplete="off" />
                <button className="big" type="submit" disabled={!none.trim()}>
                  Use my words
                </button>
              </form>
              <div className="row">
                <button ref={sayAgainButton} type="button" className={`big${scan && scanAt === optionCount ? " scanning" : ""}`} onClick={sayAgain}>
                  Say it again
                </button>
                {scan ? (
                  <button type="button" className="big primary" onClick={selectScanned}>
                    Select the highlighted one
                  </button>
                ) : null}
              </div>
              <p className="heard">Press 1 to {optionCount}, or tap. {suggestion.source === "agent" ? "Ordered with help from a language model; the rules check it." : "Ordered by the plain rules."}</p>
            </div>
          ) : null}

          {phase === "said" ? (
            <div>
              <p className="prompt">You said:</p>
              <p className="said" role="status">
                {said}
              </p>
              <p style={{ marginTop: 14 }}>Saved. Next time I will remember how you say this.</p>
              <p className="row">
                <button className="big primary" type="button" onClick={sayAgain} autoFocus>
                  Say something else
                </button>
                <button className="big" type="button" onClick={() => (flags.current.cloud ? void speakCloud(said).then((ok) => ok || speakBrowser(said)) : speakBrowser(said))}>
                  Say it aloud again
                </button>
              </p>
            </div>
          ) : null}
        </section>

        <aside className="talk" aria-label="Conversation and settings">
          <div role="log" aria-live="polite" aria-label="Conversation">
            <ol className="log" tabIndex={0} aria-label="Conversation messages">
              {lines.length === 0 ? <li className="line assistant">The conversation will appear here.</li> : null}
              {lines.map((l) => (
                <li key={l.id} className={`line ${l.who}`}>
                  <span className="who">{l.who === "you" ? "You" : "Assistant"}</span>
                  <span>{l.text}</span>
                </li>
              ))}
            </ol>
          </div>
          <p className="row" style={{ margin: 0 }}>
            <button className="soft" type="button" onClick={() => void copyConversation()} disabled={lines.length === 0}>
              Copy conversation
            </button>
            <span role="status" aria-live="polite">
              {copyNote}
            </span>
          </p>

          <details className="card">
            <summary>Settings and my data</summary>
            <div style={{ display: "grid", gap: 14, marginTop: 14 }}>
              {status?.consent ? (
                <label className="toggle">
                  <input type="checkbox" checked={status.speech_support === true} onChange={(e) => void toggleSupport(e.target.checked)} />
                  <span>I have difficulty speaking: offer sentences for what I say</span>
                </label>
              ) : null}
              <label className="toggle">
                <input type="checkbox" checked={readAloud} onChange={(e) => setReadAloud(e.target.checked)} />
                <span>Say sentences aloud</span>
              </label>
              <label className="toggle">
                <input type="checkbox" checked={scan} onChange={(e) => setScan(e.target.checked)} />
                <span>One-switch scanning: the choices light up in turn, press Space, Enter, or the big button to pick</span>
              </label>

              {status?.consent ? (
                <div>
                  <h2>What I have learned</h2>
                  <p>
                    {status.phrases} sentence{status.phrases === 1 ? "" : "s"}, {status.learned_sounds} way{status.learned_sounds === 1 ? "" : "s"} you sound.
                  </p>
                  {phrases === null ? (
                    <button className="soft" type="button" onClick={() => void loadPhrases()}>
                      Show my sentences
                    </button>
                  ) : phrases.length === 0 ? (
                    <p>Nothing saved yet.</p>
                  ) : (
                    <ul className="plain">
                      {phrases.map((p) => (
                        <li key={p.text}>
                          {p.text} ({p.uses}){" "}
                          <button className="soft" type="button" onClick={() => void forget(p.text)} aria-label={`Forget: ${p.text}`}>
                            Forget
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ) : null}

              {status?.consent ? (
                <div>
                  <h2>Delete everything</h2>
                  {armed ? (
                    <div role="alert">
                      <p>This deletes your sentences, your sounds and your agreement. It cannot be undone.</p>
                      <p className="row">
                        <button className="danger" type="button" onClick={() => void deleteAll()}>
                          Yes, delete everything
                        </button>
                        <button className="soft" type="button" onClick={() => setArmed(false)}>
                          Keep
                        </button>
                      </p>
                    </div>
                  ) : (
                    <button className="soft" type="button" onClick={() => setArmed(true)}>
                      Delete my data
                    </button>
                  )}
                </div>
              ) : null}
            </div>
          </details>
        </aside>
      </div>

      <footer className="site-foot">
        <Link to="/guide">How to use</Link>
        <Link to="/about">About</Link>
        <Link to="/privacy">Privacy</Link>
        <Link to="/terms">Terms</Link>
      </footer>
    </main>
  );
}
