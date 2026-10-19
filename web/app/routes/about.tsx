import type { Route } from "./+types/about";
import { Page } from "../lib/page";

export function meta({}: Route.MetaArgs) {
  return [{ title: "About ALSxaPlus" }, { name: "description", content: "Why a voice assistant that learns unclear speech matters, what is different, and what is not claimed." }];
}

const READING = [
  "Rudzicz, F., Namasivayam, A. K., and Wolff, T. (2012). The TORGO database of acoustic and articulatory speech from speakers with dysarthria. Language Resources and Evaluation, 46(4).",
  "Rudzicz, F. (2012). Using articulatory likelihoods in the recognition of dysarthric speech. Speech Communication, 54(3).",
  "Beukelman, D. R. and Light, J. C. (2020). Augmentative and Alternative Communication: Supporting Children and Adults with Complex Communication Needs (5th ed.). Paul H. Brookes.",
];

export default function About() {
  return (
    <Page current="About">
      <h1>About ALSxaPlus</h1>
      <p className="lead">
        ALSxaPlus is an idea for an Alexa+ add-on: when a person's speech is unclear, the assistant offers likely sentences on the screen, speaks the chosen one aloud, and learns how that person sounds.
      </p>

      <section className="card" aria-labelledby="why">
        <h2 id="why">Why this matters</h2>
        <ul className="plain">
          <li>
            <strong>Voice assistants are built for typical speech.</strong> People whose speech is changed by conditions such as ALS, cerebral palsy or stroke are often misheard again and again, and then lose the
            lights, the calls and the music that a voice makes easy for everyone else.
          </li>
          <li>
            <strong>Unclear is not random.</strong> A recogniser often writes the same sounds the same wrong way. That is a pattern a system can learn, one person at a time.
          </li>
          <li>
            <strong>A guess should never act alone.</strong> Showing the options and letting the person choose or type keeps control with the person, and a wrong guess costs one tap instead of a wrong action.
          </li>
          <li>
            <strong>Being heard is the point.</strong> Saying the chosen sentence aloud in a clear voice turns the assistant into a way to talk to the people in the room, not only a way to run devices.
          </li>
        </ul>
      </section>

      <section className="card" aria-labelledby="diff">
        <h2 id="diff">What is different</h2>
        <ul className="plain">
          <li>
            <strong>Asked once, and only after something was hard to understand.</strong> When the recognisers are unsure or disagree, the assistant asks "Do you have difficulty speaking?" one time and remembers the answer. The estimate is never a verdict: unclear speech has many causes, so nothing is switched on until the person, or their carer, says yes.
          </li>
          <li>
            <strong>One recommended sentence and five others,</strong> best first, with a way to type your own and a way to say it again.
          </li>
          <li>
            <strong>Several recognisers, one list.</strong> Three recognisers listen to the same phrase, and the different ways they write it are all used as evidence.
          </li>
          <li>
            <strong>The model proposes, code decides.</strong> A language model orders the sentences, but only choices from the offered list, or small corrections that stay close to what was heard, pass the rules. If it fails
            or breaks a rule, plain rules decide.
          </li>
          <li>
            <strong>It learns how you sound,</strong> not only what you say: the sounds and the sentence you meant are saved together.
          </li>
          <li>
            <strong>Made to be reached:</strong> large targets, keys 1 to 6, one-switch scanning, strong contrast and no moving parts unless asked.
          </li>
          <li>
            <strong>Your data is yours:</strong> see what was learned, forget a sentence, or delete everything. Consent and deletion are buttons for the person, never tools for an assistant.
          </li>
        </ul>
      </section>

      <section className="card" aria-labelledby="built">
        <h2 id="built">How it was built</h2>
        <p>
          Made for the Amazon Developer Hackathon 2026 (Alexa+ track, with Amazon Bedrock for the AWS Builder challenge). The server is an MCP server written in Rust (protocol 2025-11-25, Streamable HTTP, the official rmcp SDK) with
          tools to suggest and confirm meanings; the page is a web simulation of a smart display that calls it. Speech is turned into text and back by Deepgram. Claude Code with Claude Sonnet 5.5 on Amazon Bedrock was used as a Code Assistant to speed up
          development and debugging, under the author's direction and review. The source code is open under the MIT license.
        </p>
      </section>

      <section className="card" aria-labelledby="not">
        <h2 id="not">What is not claimed</h2>
        <ul className="plain">
          <li>No person with a speech disability has used it, and it was not designed with one. That has to happen before anyone relies on it.</li>
          <li>Tests used synthetic voices and a research database of dysarthric speech, not people living with these conditions.</li>
          <li>It has not run on a real Alexa+ device. The simulation stands in for a smart display and is not an Amazon product.</li>
          <li>It is not a medical device and is not for emergencies.</li>
        </ul>
      </section>

      <section className="card" aria-labelledby="read">
        <h2 id="read">Works it started from</h2>
        <p>These shaped the idea and the way it was tested. They are starting points, not proof that ALSxaPlus works.</p>
        <ul className="plain">
          {READING.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      </section>

      <section className="card" aria-labelledby="who">
        <h2 id="who">Who made it</h2>
        <p>
          Muhammad Zia ul Haq, <a href="mailto:zia@eziedutech.dev">zia@eziedutech.dev</a>. Source code: <a href="https://github.com/ziaac/alsxaplus">github.com/ziaac/alsxaplus</a>.
        </p>
      </section>
    </Page>
  );
}
