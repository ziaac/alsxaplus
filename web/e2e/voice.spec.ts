// The voice path with real recognisers: a fake microphone plays a synthetic voice saying "I need some water", the page
// records it, the server asks three recognisers, and the sentences come back. This calls Deepgram, so it runs only when
// DEEPGRAM_API_KEY is set for the test run (never printed, never saved).
import { chromium, expect, test } from "@playwright/test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const KEY = process.env.DEEPGRAM_API_KEY?.trim();
test.skip(!KEY, "DEEPGRAM_API_KEY is not set, so the voice path is not tested");

async function sayAsWav(text: string): Promise<string> {
  const res = await fetch("https://api.deepgram.com/v1/speak?model=aura-2-thalia-en&encoding=linear16&container=wav&mip_opt_out=true", {
    method: "POST",
    headers: { authorization: `Token ${KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) throw new Error(`could not make the test voice: HTTP ${res.status}`);
  const file = join(mkdtempSync(join(tmpdir(), "alsxaplus-voice-")), "voice.wav");
  writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  return file;
}

async function openWithVoice(text: string, before?: (page: import("@playwright/test").Page) => Promise<void>) {
  const wav = await sayAsWav(text);
  const browser = await chromium.launch({ args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${wav}%noloop`] });
  const page = await browser.newPage({ baseURL: "http://127.0.0.1:5299" });
  page.on("dialog", (dialog) => {
    throw new Error(`a browser dialog opened: ${dialog.type()} "${dialog.message()}"`);
  });
  await page.goto("/sim");
  await page.getByLabel(/I agree, or I am the carer/).check();
  await page.getByRole("button", { name: "Agree and start" }).click();
  await before?.(page);
  return { browser, page };
}

test("clear speech is simply understood: nothing is asked and nothing is assumed", async () => {
  const { browser, page } = await openWithVoice("I need some water");
  try {
    await page.getByRole("button", { name: "Speak", exact: true }).click();
    await expect(page.getByText(/I understood that, so I will carry on as usual/)).toBeVisible({ timeout: 40_000 });
    await expect(page.getByRole("heading", { name: "Do you have difficulty speaking?" })).toHaveCount(0);
    await expect(page.locator("ol.options button.option")).toHaveCount(0);
  } finally {
    await browser.close();
  }
});

test("a spoken phrase goes through the microphone and three recognisers and comes back as six sentences", async () => {
  // The person (or carer) has already said that speaking is difficult, in the settings, so the answer is on record.
  const { browser, page } = await openWithVoice("I need some water", async (p) => {
    await p.getByText("Settings and my data").click();
    await p.getByLabel(/I have difficulty speaking/).click();
    await expect(p.getByText("Speech support is on.")).toBeVisible();
  });
  try {
    await page.getByRole("button", { name: "Speak", exact: true }).click();
    await expect(page.locator("ol.options button.option")).toHaveCount(6, { timeout: 40_000 });
    await expect(page.locator(".line.you").last()).toContainText(/water/i);
    await expect(page.locator("ol.options button.option").first()).toContainText(/water/i);
  } finally {
    await browser.close();
  }
});
