// End to end: a real browser, this app, the real MCP server (rules only) and a real database.
import { expect, test, type Page } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  // The rules forbid the browser's own alert, confirm and prompt boxes.
  page.on("dialog", (dialog) => {
    throw new Error(`a browser dialog opened: ${dialog.type()} "${dialog.message()}"`);
  });
});

async function agree(page: Page): Promise<void> {
  await page.goto("/sim");
  await expect(page.getByRole("heading", { name: "Before we start" })).toBeVisible();
  const start = page.getByRole("button", { name: "Agree and start" });
  await expect(start).toBeDisabled();
  await page.getByLabel(/I agree, or I am the carer/).check();
  await start.click();
  await expect(page.getByRole("heading", { name: /Say something/ })).toBeVisible();
}

async function typeHeard(page: Page, text: string): Promise<void> {
  await page.locator("input#typed").fill(text);
  await page.getByRole("button", { name: "Send", exact: true }).click();
}

const options = (page: Page) => page.locator("ol.options button.option");

test("nothing is learned until the person or carer agrees", async ({ page }) => {
  await page.goto("/sim");
  await expect(page.getByRole("heading", { name: "Before we start" })).toBeVisible();
  await expect(page.locator("input#typed")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Agree and start" })).toBeDisabled();
});

test("the question about difficulty speaking is asked once, then the sentences are offered", async ({ page }) => {
  await agree(page);
  await typeHeard(page, "pees hep me");
  await expect(page.getByRole("heading", { name: "Do you have difficulty speaking?" })).toBeVisible();
  await page.getByRole("button", { name: "Yes", exact: true }).click();

  await expect(page.getByRole("heading", { name: "Did you mean:" })).toBeVisible();
  await expect(options(page)).toHaveCount(6);
  await expect(options(page).first()).toContainText("Recommended");
  await expect(page.getByText("Ordered by the plain rules.")).toBeVisible();

  // A new phrase later, even after reloading the page: no second question.
  await page.getByRole("button", { name: "Say it again" }).click();
  await page.reload();
  await typeHeard(page, "ah hun ry");
  await expect(page.getByRole("heading", { name: "Do you have difficulty speaking?" })).toHaveCount(0);
  await expect(options(page)).toHaveCount(6);
  await expect(options(page).first()).toBeFocused();
});

test("a chosen sentence is said, saved, and then comes first for the same sounds", async ({ page }) => {
  await agree(page);
  await typeHeard(page, "uh oh ee");
  await page.getByRole("button", { name: "Yes", exact: true }).click();
  await expect(options(page)).toHaveCount(6);

  // Press 3: the keyboard shortcut for the third sentence.
  const third = (await options(page).nth(2).innerText()).replace(/^\d\s*Yes:\s*/, "").replace(/\s*Recommended$/, "").trim();
  await page.keyboard.press("3");
  await expect(page.locator(".said")).toHaveText(third);
  await expect(page.getByText("Saved. Next time I will remember how you say this.")).toBeVisible();

  await page.getByRole("button", { name: "Say something else" }).click();
  await typeHeard(page, "uh oh ee");
  await expect(options(page)).toHaveCount(6);
  await expect(options(page).first()).toContainText(third);
  await expect(options(page).first()).toContainText("Recommended");

  // What was learned can be seen and forgotten.
  await page.getByText("Settings and my data").click();
  await page.getByRole("button", { name: "Show my sentences" }).click();
  await expect(page.locator("details ul.plain li").filter({ hasText: third })).toBeVisible();
  await page.getByRole("button", { name: `Forget: ${third}` }).click();
  await expect(page.getByText("Nothing saved yet.")).toBeVisible();
});

test("when none of the sentences is right, the person can type their own", async ({ page }) => {
  await agree(page);
  await typeHeard(page, "mm ah eh");
  await page.getByRole("button", { name: "Yes", exact: true }).click();
  await expect(options(page)).toHaveCount(6);
  await page.locator("input#none").fill("Please open the curtains");
  await page.getByRole("button", { name: "Use my words" }).click();
  await expect(page.locator(".said")).toHaveText("Please open the curtains");
});

test("one-switch scanning lights the choices in turn and a single key picks the lit one", async ({ page }) => {
  await agree(page);
  await typeHeard(page, "gu mawnin");
  await page.getByRole("button", { name: "Yes", exact: true }).click();
  await expect(options(page)).toHaveCount(6);

  await page.getByText("Settings and my data").click();
  await page.getByLabel(/One-switch scanning/).check();
  // The second choice lights up after one step.
  const second = page.locator("ol.options button.option.scanning").nth(0);
  await expect(options(page).nth(1)).toHaveClass(/scanning/, { timeout: 8_000 });
  const lit = (await options(page).nth(1).innerText()).replace(/^\d\s*Yes:\s*/, "").trim();
  void second;
  await page.keyboard.press("Space");
  await expect(page.locator(".said")).toHaveText(lit);
});

test("everything about the person can be deleted, after asking twice", async ({ page }) => {
  await agree(page);
  await page.getByText("Settings and my data").click();
  await page.getByRole("button", { name: "Delete my data" }).click();
  await expect(page.getByRole("alert")).toContainText("cannot be undone");
  await page.getByRole("button", { name: "Keep" }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await page.getByRole("button", { name: "Delete my data" }).click();
  await page.getByRole("button", { name: "Yes, delete everything" }).click();
  await expect(page.getByRole("heading", { name: "Before we start" })).toBeVisible();
});

test("the conversation can be copied as plain text", async ({ page }) => {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await agree(page);
  await typeHeard(page, "hel o");
  await page.getByRole("button", { name: "Yes", exact: true }).click();
  await expect(options(page)).toHaveCount(6);
  await page.getByRole("button", { name: "Copy conversation" }).click();
  await expect(page.getByText("Copied. You can paste it into a message.")).toBeVisible();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toContain("You: hel o");
  expect(copied).toContain("Assistant: ");
});

test("a phone-sized screen has no sideways scrolling", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  for (const path of ["/", "/sim", "/guide", "/about", "/privacy", "/terms"]) {
    await page.goto(path);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, path).toBeLessThanOrEqual(0);
  }
});
