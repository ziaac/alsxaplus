// Automatic accessibility checks (axe-core, WCAG 2.1 A and AA, including colour contrast) on every page and on each
// state of the simulation. They find about a third of real problems; they do not replace a test with a screen reader
// or with the people this is for.
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];

async function violations(page: Page): Promise<string[]> {
  const result = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  return result.violations.map((v) => `${v.id} (${v.impact}): ${v.help}. First: ${v.nodes[0]?.target.join(" ")} ${v.nodes[0]?.failureSummary?.split("\n")[1] ?? ""}`);
}

for (const path of ["/", "/guide", "/about", "/privacy", "/terms", "/sim"]) {
  test(`no automatic accessibility violations on ${path}`, async ({ page }) => {
    await page.goto(path);
    await page.waitForLoadState("networkidle");
    expect(await violations(page)).toEqual([]);
  });
}

test("no automatic accessibility violations in each step of the simulation", async ({ page }) => {
  await page.goto("/sim");
  await page.getByLabel(/I agree, or I am the carer/).check();
  await page.getByRole("button", { name: "Agree and start" }).click();
  await expect(page.locator("input#typed")).toBeVisible();
  expect(await violations(page), "ready").toEqual([]);

  await page.locator("input#typed").fill("pees hep me");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Do you have difficulty speaking?" })).toBeVisible();
  expect(await violations(page), "question").toEqual([]);

  await page.getByRole("button", { name: "Yes", exact: true }).click();
  await expect(page.locator("ol.options button.option")).toHaveCount(6);
  expect(await violations(page), "choices").toEqual([]);

  await page.getByText("Settings and my data").click();
  await page.getByLabel(/One-switch scanning/).check();
  expect(await violations(page), "scanning and settings").toEqual([]);

  await page.keyboard.press("2");
  await expect(page.locator(".said")).toBeVisible();
  expect(await violations(page), "said").toEqual([]);
});
