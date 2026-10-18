import { Link } from "react-router";
import type { Route } from "./+types/guide";
import { Page } from "../lib/page";

export function meta({}: Route.MetaArgs) {
  return [{ title: "How to use ALSxaPlus" }, { name: "description", content: "Step by step: agree, speak or type, choose a sentence, and what is learned." }];
}

export default function Guide() {
  return (
    <Page current="How to use">
      <h1>How to use ALSxaPlus</h1>
      <p className="lead">The simulation stands in for an Alexa+ smart display. Everything works with touch, a keyboard, or one switch.</p>

      <section className="card" aria-labelledby="steps">
        <h2 id="steps">Step by step</h2>
        <ol className="plain">
          <li>
            <strong>Agree.</strong> The first time, you (or your carer) agree to what is kept. No agreement, nothing is saved.
          </li>
          <li>
            <strong>Speak, or type.</strong> Press <strong>Speak</strong>, say a short phrase, then pause. Without a microphone, type the words as a recogniser might write them, for example "ah wan wa er".
          </li>
          <li>
            <strong>Answer the question, once.</strong> The first time only, you are asked "Do you have difficulty speaking?" Say or press Yes to get suggestions. It is never asked again, and you can change it in the settings.
          </li>
          <li>
            <strong>Choose.</strong> You see one recommended sentence and five others. Tap one, press the key 1 to 6, or use one-switch scanning. If none is right, type your own words. If you want to try again, choose "Say it again".
          </li>
          <li>
            <strong>It speaks and learns.</strong> The sentence you chose is said aloud. The sounds that were heard and the sentence are saved together, so next time that sentence comes first.
          </li>
        </ol>
      </section>

      <section className="card" aria-labelledby="access">
        <h2 id="access">Ways to choose</h2>
        <ul className="plain">
          <li>
            <strong>Touch or mouse:</strong> the buttons are large.
          </li>
          <li>
            <strong>Keyboard:</strong> Tab to move, Enter to choose, or press 1 to 6 for the sentence you want.
          </li>
          <li>
            <strong>One switch:</strong> turn on scanning in the settings. The choices light up in turn. Press Space, Enter, or the big button when the right one is lit.
          </li>
          <li>
            <strong>Reduced motion:</strong> nothing moves on its own except the scanning highlight, and the page respects the system setting to reduce motion.
          </li>
        </ul>
      </section>

      <section className="card" aria-labelledby="data">
        <h2 id="data">Your data</h2>
        <p>
          Open <strong>Settings and my data</strong> to see every sentence that was learned, forget any of them, or delete everything. Recordings are never kept. Read the <Link to="/privacy">privacy page</Link>.
        </p>
      </section>

      <section className="card" aria-labelledby="warn">
        <h2 id="warn">Please remember</h2>
        <p>ALSxaPlus is a simulation made for a hackathon. It is not for emergencies, and it is not a medical device. Never rely on it to ask for urgent help.</p>
      </section>
    </Page>
  );
}
