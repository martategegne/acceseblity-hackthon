import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";

const sections = JSON.parse(await readFile(new URL("../../demo/data/content.json", import.meta.url), "utf8"));

test("learner feedback is visible to helpers without storing the question", async ({ page, request }) => {
  const feedbackSection = sections[1];

  await page.goto("/demo/blank.html");
  const assistant = page.locator("db-assistant");
  await expect(assistant.locator("#launcher")).toBeEnabled();
  await assistant.evaluate((element) => element.setAttribute("lang", "en"));
  await assistant.locator("#launcher").click();
  await assistant.locator("#question").fill(feedbackSection.text.en);
  await assistant.locator("#send").click();
  const answer = assistant.locator("#messages .message-assistant").last();
  await expect(answer.locator("a.course-link")).toHaveAttribute("href", feedbackSection.url);
  await answer.getByRole("button", { name: "Flag as incorrect" }).click();
  await expect(answer.locator(".voice-controls [role='status']")).toContainText("without your question text");

  await page.goto("/helper");
  await page.locator("#token").fill("e2e-helper-token");
  await page.getByRole("button", { name: "Review answer feedback" }).click();
  const feedback = page.locator("#feedback-list li").filter({ hasText: feedbackSection.url });
  await expect(feedback).toContainText("incorrect (source)");
  await feedback.getByRole("button", { name: "Mark reviewed" }).click();
  await expect(page.locator("#status")).toContainText("0 unreviewed feedback");
  await expect(feedback).toContainText("Reviewed");
});
