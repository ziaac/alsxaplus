import { Link } from "react-router";
import type { Route } from "./+types/home";

export function meta({}: Route.MetaArgs) {
  return [
    { title: "ALSxaPlus" },
    { name: "description", content: "When speech is unclear, an assistant that shows the sentences you may have meant, says yours aloud, and learns how you sound." },
  ];
}

export default function Home() {
  return (
    <main id="main" className="page">
      <section className="hero">
        <p className="badge" style={{ display: "inline-block" }}>
          Simulation of an Alexa+ add-on idea
        </p>
        <h1 style={{ marginTop: 16 }}>ALSxaPlus</h1>
        <p className="lead">
          When speech is unclear, a voice assistant often gives up. People whose speech is changed by ALS, cerebral palsy, Parkinson's disease, a stroke or another condition are misheard again and again.
          ALSxaPlus does not give up. It shows the sentences you may have meant, you choose one or type your own, it says your sentence aloud in a clear voice, and it learns how <em>you</em> sound, so the next
          guess is better.
        </p>
        <p>
          It offers help for today and for the years ahead: as speech changes, the same profile keeps learning from every sentence you confirm. It never decides by itself that you have a disability. When what it
          heard is hard to understand, it asks, and only your answer, or your carer's, turns the help on.
        </p>
        <p className="row">
          <Link className="button primary" to="/sim">
            Open the simulation
          </Link>
          <Link className="button" to="/guide">
            How to use it
          </Link>
          <Link className="button" to="/about">
            Why it matters
          </Link>
        </p>
      </section>

      <section className="card" aria-labelledby="how">
        <h2 id="how">How it works</h2>
        <ol className="plain">
          <li>You speak. A recogniser writes down what it heard. For unclear speech that is often wrong, but it is wrong in the same way each time.</li>
          <li>
            If what it heard is hard to understand, the assistant asks once whether you have difficulty speaking. Clear speech is simply understood and nothing is asked. It never asks again, unless you change
            it in the settings.
          </li>
          <li>It shows one recommended sentence and five others. You pick one by touch, by key, or with a single switch, or you type your own.</li>
          <li>It says the sentence aloud. The sounds and the sentence are saved together, so next time that sentence comes first.</li>
        </ol>
      </section>

      <section className="card" aria-labelledby="not">
        <h2 id="not">What it is not</h2>
        <p>
          It is a simulation for the Amazon Developer Hackathon 2026, not a real Alexa+ device and not an Amazon product. It is not a medical device, it is not for emergencies, and no person with a speech
          disability has used it yet.
        </p>
      </section>

      <footer className="site-foot">
        <Link to="/about">About</Link>
        <Link to="/privacy">Privacy</Link>
        <Link to="/terms">Terms</Link>
      </footer>
    </main>
  );
}
