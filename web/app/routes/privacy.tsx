import type { Route } from "./+types/privacy";
import { Page } from "../lib/page";

export function meta({}: Route.MetaArgs) {
  return [{ title: "Privacy: ALSxaPlus" }, { name: "description", content: "What ALSxaPlus keeps about a person, what it sends to other services, and how to delete it." }];
}

export default function Privacy() {
  return (
    <Page current="Privacy">
      <h1>Privacy</h1>
      <p className="lead">
        How a person speaks is sensitive information. This page says plainly what ALSxaPlus keeps, what it sends to other services, and how to remove it. It is a hackathon prototype, it is not legal advice, and it has not
        been reviewed by a lawyer. Please do not type real personal details into the public demo.
      </p>

      <section className="card" aria-labelledby="kept">
        <h2 id="kept">What is kept, and only after you agree</h2>
        <ul className="plain">
          <li>A random profile number, when you agreed, and your answer to "Do you have difficulty speaking?".</li>
          <li>Each phrase that was heard (the recogniser's text, never the audio), the sentences that were offered, and the one you chose or typed.</li>
          <li>The sentences you confirmed, how often, and the ways the recogniser wrote the sounds that went with them. This is what makes later guesses fit you.</li>
          <li>Records of each call to the language model: how many tokens, the cost and the time. They hold no text.</li>
          <li>A session cookie that holds a random key to your profile. It is needed for the page to work and is not used for tracking. There are no advertising or analytics trackers.</li>
        </ul>
      </section>

      <section className="card" aria-labelledby="notkept">
        <h2 id="notkept">What is not kept</h2>
        <p>Recordings. The server receives a short recording only to turn it into text, passes it on, and does not write it to disk or to the database.</p>
      </section>

      <section className="card" aria-labelledby="others">
        <h2 id="others">What goes to other services</h2>
        <ul className="plain">
          <li>
            <strong>Deepgram</strong> (deepgram.com) turns the recording into text with three recognisers, and turns the chosen sentence into speech. Every request asks Deepgram not to use it to improve its models. Its own privacy
            terms apply to what it handles.
          </li>
          <li>
            <strong>Amazon Bedrock</strong> (a language model) receives the text that was heard and the list of sentences to order, which includes sentences you have saved before. It sends back an order. It never receives
            audio or your profile number. Amazon's terms for Bedrock apply.
          </li>
          <li>If a model or service is not available, simple rules order the sentences on our own server instead.</li>
        </ul>
      </section>

      <section className="card" aria-labelledby="control">
        <h2 id="control">Your control</h2>
        <ul className="plain">
          <li>Nothing is learned until you (or your carer) agree. You can see every sentence that was learned in Settings, forget any of them, or delete everything.</li>
          <li>Consent and deleting are buttons for you. An assistant has no tool to give consent for you or to erase your data.</li>
          <li>The public demo deletes a profile that has not been used for a day.</li>
        </ul>
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
