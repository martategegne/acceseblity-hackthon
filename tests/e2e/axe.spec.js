import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const pages = [
  ["blank demo", "/demo/blank.html"],
  ["paced homepage", "/savanna/pages/homepage-v1-paced.html"],
  ["self-paced homepage", "/savanna/pages/homepage-v1-self-paced.html"],
  ["course navigation page", "/savanna/pages/concept-with-navigation.html"]
];

for (const [name, route] of pages) {
  test(`axe: ${name}, assistant panel open`, async ({ page }) => {
    const response = await page.goto(route);
    expect(response?.ok(), `Could not load ${route}; check that the page exists and is served.`).toBeTruthy();
    const assistant = page.locator("db-assistant");
    await expect(assistant).toHaveCount(1);
    const launcher = assistant.locator("#launcher");
    await expect(launcher).toBeEnabled();
    await launcher.click();
    await assistant.locator("#lesson-explore > summary").click();
    await expect(assistant.locator('[role="dialog"]')).toBeVisible();

    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
      .analyze();
    const severe = results.violations.filter((violation) => ["critical", "serious"].includes(violation.impact));
    const report = severe.map((violation) => ({
      id: violation.id,
      impact: violation.impact,
      help: violation.help,
      nodes: violation.nodes.map((node) => ({ target: node.target, summary: node.failureSummary }))
    }));
    expect(severe, JSON.stringify(report, null, 2)).toEqual([]);
  });
}

test("axe: answer actions and lesson citation", async ({ page }) => {
  await page.route("**/api/v1/config", (route) => route.fulfill({ json: { externalAiConsentRequired: false } }));
  await page.route("**/api/v1/ask", (route) => route.fulfill({
    json: {
      answer: "A grounded answer for this lesson section.",
      sources: [{ url: "/savanna/pages/concept-with-navigation.html#what-is-shaping-the-future-of-va-work", title: "What is Shaping the Future" }]
    }
  }));
  await page.goto("/savanna/pages/concept-with-navigation.html");
  const assistant = page.locator("db-assistant");
  await expect(assistant.locator("#launcher")).toBeEnabled();
  await assistant.evaluate((element) => element.setAttribute("lang", "en"));
  await expect(assistant.locator("#language-select")).toHaveValue("en");
  await assistant.locator("#launcher").click();
  await assistant.locator("#lesson-explore > summary").click();
  await assistant.locator("#question").fill("What does this lesson say?");
  await assistant.locator("#send").click();
  const answer = assistant.locator("#messages .message-assistant").last();
  await expect(answer.locator(".copy-answer")).toBeVisible();
  await expect(answer.locator(".listen-button")).toBeVisible();
  await expect(answer.locator(".course-link")).toBeVisible();

  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  const severe = results.violations.filter((violation) => ["critical", "serious"].includes(violation.impact));
  const report = severe.map((violation) => ({
    id: violation.id,
    impact: violation.impact,
    help: violation.help,
    nodes: violation.nodes.map((node) => ({ target: node.target, summary: node.failureSummary }))
  }));
  expect(severe, JSON.stringify(report, null, 2)).toEqual([]);
});

test("axe: queued-question controls", async ({ page, context }) => {
  await page.goto("/demo/blank.html");
  const assistant = page.locator("db-assistant");
  await expect(assistant.locator("#launcher")).toBeEnabled();
  await assistant.evaluate((element) => element.setAttribute("lang", "en"));
  await page.waitForFunction(() => document.querySelector("db-assistant")?._sections?.length > 0);
  await assistant.locator("#launcher").click();
  await context.setOffline(true);
  try {
    await assistant.locator("#question").fill("How does the course describe virtual assistant work?");
    await assistant.locator("#send").click();
    await expect(assistant.locator("#offline-queue")).toBeVisible();
    await assistant.locator("#offline-queue").getByRole("button", { name: "Edit" }).click();

    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
      .analyze();
    const severe = results.violations.filter((violation) => ["critical", "serious"].includes(violation.impact));
    const report = severe.map((violation) => ({
      id: violation.id,
      impact: violation.impact,
      help: violation.help,
      nodes: violation.nodes.map((node) => ({ target: node.target, summary: node.failureSummary }))
    }));
    expect(severe, JSON.stringify(report, null, 2)).toEqual([]);
  } finally {
    await context.setOffline(false);
  }
});
