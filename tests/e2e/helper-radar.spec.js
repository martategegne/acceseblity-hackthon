import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";

const sections = JSON.parse(await readFile(new URL("../../demo/data/content.json", import.meta.url), "utf8"));

test("teacher course gap radar requires helper auth and renders real grouped outcomes", async ({ page, request }) => {
  const helperHeaders = { "X-Helper-Token": "e2e-helper-token" };
  const unauthorized = await request.get("/api/v1/helper/course-gap-radar");
  expect(unauthorized.status()).toBe(401);

  const question = sections[0].titles.en;
  for (let index = 0; index < 3; index += 1) {
    const answer = await request.post("/api/v1/ask", { data: { question, language: "en" } });
    expect(answer.status()).toBe(200);
    expect((await answer.json()).answerStatus).toBe("answered");
  }

  const reportResponse = await request.get("/api/v1/helper/course-gap-radar", { headers: helperHeaders });
  expect(reportResponse.status()).toBe(200);
  const report = await reportResponse.json();
  expect(report.byLanguage.map((row) => row.language)).toEqual(["en", "am", "ti", "om", "so"]);
  expect(report.topAnsweredTopics).toContainEqual({
    topicId: sections[0].id,
    title: sections[0].titles.en,
    count: expect.any(Number)
  });

  await page.goto("/helper");
  await expect(page.getByRole("heading", { name: "Teacher Course Gap Radar" })).toBeVisible();
  await expect(page.locator("#radar-results")).toBeHidden();
  await page.locator("#token").fill("e2e-helper-token");
  await page.getByRole("button", { name: "Load course gap report" }).click();
  await expect(page.locator("#radar-results")).toBeVisible();
  await expect(page.locator("#radar-language-body")).toContainText("English");
  await expect(page.locator("#radar-topics-body")).toContainText(sections[0].titles.en);
  await expect(page.locator("#radar-status")).toContainText("report loaded");
});
