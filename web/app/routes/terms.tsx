import type { Route } from "./+types/terms";
import { Page } from "../lib/page";

export function meta({}: Route.MetaArgs) {
  return [{ title: "Terms of use: ALSxaPlus" }, { name: "description", content: "The terms for using the ALSxaPlus prototype." }];
}

export default function Terms() {
  return (
    <Page current="Terms">
      <h1>Terms of use</h1>
      <p className="lead">ALSxaPlus is a prototype for the Amazon Developer Hackathon 2026. By using it you agree to these plain terms.</p>

      <section className="card" aria-labelledby="what">
        <h2 id="what">What it is, and what it is not</h2>
        <ul className="plain">
          <li>It suggests sentences for what a person may have meant. A suggestion can be wrong, so the person always chooses or types.</li>
          <li>
            <strong>It is not for emergencies.</strong> Never rely on it to ask for urgent help or to give medical information.
          </li>
          <li>It is not a medical device and not a replacement for a communication aid prescribed or recommended by a professional.</li>
          <li>The simulation stands in for a smart display. It is not an Amazon device and is not made or endorsed by Amazon.</li>
        </ul>
      </section>

      <section className="card" aria-labelledby="use">
        <h2 id="use">Using it</h2>
        <p>
          Use it only with the agreement of the person whose speech it is, or their carer. Please do not type real personal details into the public demo, and do not try to reach anyone else's data, overload the service
          or misuse the access keys.
        </p>
      </section>

      <section className="card" aria-labelledby="warranty">
        <h2 id="warranty">No warranty</h2>
        <p>The prototype is offered as it is. It may change, stop, or be reset without notice. The source code is under the MIT license in the project repository.</p>
      </section>

      <section className="card" aria-labelledby="contact">
        <h2 id="contact">Contact</h2>
        <p>
          Muhammad Zia ul Haq, <a href="mailto:zia@eziedutech.dev">zia@eziedutech.dev</a>.
        </p>
      </section>
    </Page>
  );
}
