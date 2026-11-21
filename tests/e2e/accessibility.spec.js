import { test, expect } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/savanna/pages/concept-with-navigation.html");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  const assistant = page.locator("db-assistant");
  await expect(assistant.locator("#launcher")).toBeEnabled();
});

test("keyboard users can open, traverse, and close the assistant dialog", async ({ page }) => {
  const assistant = page.locator("db-assistant");
  const launcher = assistant.locator("#launcher");

  await launcher.focus();
  await page.keyboard.press("Enter");
  await expect(assistant.locator("#panel")).toBeVisible();
  await expect(assistant.locator("#panel")).toHaveAttribute("aria-modal", "true");
  await expect(assistant.locator("#panel-title")).toBeFocused();

  const focusableIds = await assistant.evaluate((element) => {
    const root = element.shadowRoot;
    return [...root.querySelectorAll("#panel button:not([disabled]), #panel a[href], #panel input:not([disabled]), #panel select:not([disabled]), #panel textarea:not([disabled]), #panel summary")]
      .filter((node) => !node.hidden && !node.closest("[hidden]"))
      .map((node) => node.id || node.className);
  });
  expect(focusableIds.length).toBeGreaterThan(4);

  for (let index = 0; index < focusableIds.length + 2; index += 1) {
    await page.keyboard.press("Tab");
    const activeInsidePanel = await assistant.evaluate((element) => {
      const active = element.shadowRoot.activeElement;
      return Boolean(active && element.shadowRoot.getElementById("panel").contains(active));
    });
    expect(activeInsidePanel).toBe(true);
  }

  await page.keyboard.press("Escape");
  await expect(assistant.locator("#panel")).toBeHidden();
  await expect(launcher).toBeFocused();
});

test("keyboard-accessible visual preferences persist inside Shadow DOM", async ({ page }) => {
  const assistant = page.locator("db-assistant");
  await assistant.locator("#launcher").click();

  const contrast = assistant.locator("#contrast-toggle");
  await contrast.focus();
  await page.keyboard.press("Enter");
  await expect(contrast).toHaveAttribute("aria-pressed", "true");
  await expect(assistant).toHaveAttribute("contrast", "high");

  await assistant.locator("#text-increase").focus();
  await page.keyboard.press("Enter");
  await expect(assistant).toHaveAttribute("text-scale", "1.1");
  await expect.poll(() => assistant.evaluate((element) => element.style.getPropertyValue("--assistant-text-scale"))).toBe("1.1");

  await page.reload();
  const returnedAssistant = page.locator("db-assistant");
  await expect(returnedAssistant).toHaveAttribute("contrast", "high");
  await expect(returnedAssistant).toHaveAttribute("text-scale", "1.1");
});

test("screen-reader names, live announcements, and audio transcripts are exposed", async ({ page }) => {
  const assistant = page.locator("db-assistant");
  await assistant.locator("#launcher").click();

  await expect(assistant.locator("#panel")).toHaveAttribute("aria-describedby", "panel-instructions");
  await expect(assistant.locator("#panel-instructions")).not.toHaveText("");
  await expect(assistant.locator("#question")).toHaveAttribute("aria-describedby", "question-help");
  await expect(assistant.locator("#microphone")).toHaveAttribute("aria-label", /microphone/i);
  await expect(assistant.locator("#voice-status")).toHaveAttribute("aria-live", "polite");
  await expect(assistant.locator("#assistant-announcer")).toHaveAttribute("role", "status");

  await assistant.evaluate((element) => element._setTranscript("This is the recognized transcript."));
  await expect(assistant.locator("#voice-transcript")).toBeVisible();
  await expect(assistant.locator("#voice-transcript-text")).toHaveText("This is the recognized transcript.");
  await expect(assistant.locator("#voice-captions")).toHaveAttribute("src", /^blob:/);
  await expect(assistant.locator("#assistant-announcer")).toContainText("Transcript");
});
