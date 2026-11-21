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
  await expect(assistant.locator("#microphone")).toHaveAttribute("aria-label", /.+/);
  await expect(assistant.locator("#voice-status")).toHaveAttribute("aria-live", "polite");
  await expect(assistant.locator("#assistant-announcer")).toHaveAttribute("role", "status");

  await assistant.evaluate((element) => element._setTranscript("This is the recognized transcript."));
  await expect(assistant.locator("#voice-transcript")).toBeVisible();
  await expect(assistant.locator("#voice-transcript-text")).toHaveText("This is the recognized transcript.");
  await expect(assistant.locator("#voice-captions")).toHaveAttribute("src", /^blob:/);
  await expect(assistant.locator("#assistant-announcer")).toContainText("Transcript");
});

test("keyboard flow exposes answer navigation, language direction, simple language, and text handoff", async ({ page }) => {
  await page.route("**/api/v1/config", (route) => route.fulfill({ json: { externalAiConsentRequired: false } }));
  await page.route("**/api/v1/ask", (route) => route.fulfill({
    json: {
      answer: "A detailed answer for the lesson.",
      simpleAnswer: "Short answer. One idea per line.",
      sources: [{ url: "/savanna/pages/concept-with-navigation.html#section", title: "Lesson 2, section Water cycle" }]
    }
  }));
  await page.route("**/api/v1/escalations", (route) => route.fulfill({ json: { ticketId: "ABC12345", accessToken: "test-token" }, status: 201 }));
  await page.goto("/demo/blank.html");
  const assistant = page.locator("db-assistant");
  await assistant.locator("#launcher").click();
  await expect(assistant.locator("#lesson-explore > summary")).toHaveAttribute("aria-expanded", "false");
  await assistant.locator("#lesson-explore > summary").press("Enter");
  await expect(assistant.locator("#lesson-explore > summary")).toHaveAttribute("aria-expanded", "true");
  await assistant.locator("#question").fill("What is in this lesson?");
  await assistant.locator("#send").click();
  await expect(assistant.locator("#assistant-announcer")).toContainText("Source: Lesson 2, section Water cycle");
  await expect(assistant.locator("#skip-answer")).toBeVisible();
  await expect(assistant.locator("#jump-sources")).toBeVisible();
  await expect(assistant.locator("#answer-sources")).toContainText("Sources");
  await expect(assistant.locator(".simple-language-toggle")).toBeVisible();
  await assistant.locator(".simple-language-toggle").click();
  await expect(assistant.locator(".message-assistant .message-body")).toHaveText("Short answer. One idea per line.");

  await assistant.locator("#person").click();
  await assistant.locator("#escalation-reason").selectOption("learner_requested_person");
  await assistant.locator("#consent").check();
  await assistant.locator("#send-escalation").click();
  await expect(assistant.locator("#escalation-status")).toContainText("ABC12345");
  await expect(assistant.locator("#tutor-status")).toContainText("Waiting");
  await expect(assistant.locator("#assistant-announcer")).toContainText("Tutor request sent, code ABC12345");
  await page.keyboard.press("Escape");
  await expect(assistant.locator("#person")).toBeFocused();

  await assistant.locator("#language-select").selectOption("ar");
  await expect(assistant.locator("#panel")).toHaveAttribute("dir", "rtl");
  await expect(assistant.locator("#question")).toHaveAttribute("lang", "ar");
});

test("voice guide is opt-in, persists, and captions every mocked utterance", async ({ page }) => {
  const assistant = page.locator("db-assistant");
  await assistant.locator("#launcher").click();
  await assistant.locator("#language-select").selectOption("en");
  await expect(assistant.locator("#panel")).toHaveAttribute("lang", "en");
  await expect(assistant.locator("#send")).toHaveText("Send");
  await assistant.evaluate((element) => {
    const spoken = [];
    let cancelCount = 0;
    const speech = {
      speaking: false, paused: false,
      getVoices: () => [{ name: "Test English", lang: "en-US" }],
      cancel: () => { cancelCount += 1; speech.speaking = false; },
      pause: () => { speech.paused = true; },
      resume: () => { speech.paused = false; },
      speak: (utterance) => { spoken.push(utterance.text); speech.speaking = true; }
    };
    Object.defineProperty(window, "speechSynthesis", { configurable: true, value: speech });
    window.SpeechSynthesisUtterance = function (text) { this.text = text; };
    window.__voiceGuideEvidence = { spoken, get cancelCount() { return cancelCount; } };
    element._toggleVoiceGuide(true);
  });
  await expect(assistant.locator("#voice-guide-toggle")).toHaveAttribute("aria-checked", "true");
  await expect(assistant.locator("#voice-guide-toggle")).toContainText("On");
  await assistant.locator("#send").focus();
  await expect.poll(() => assistant.evaluate(() => window.__voiceGuideEvidence.spoken.some((text) => text === "Send, button"))).toBe(true);
  await expect(assistant.locator("#voice-caption-text")).toContainText("Send, button");
  await expect.poll(() => assistant.evaluate(() => window.__voiceGuideEvidence.cancelCount)).toBeGreaterThan(0);
  await page.keyboard.press("Escape");
  await expect(assistant.locator("#panel")).toBeHidden();
  await expect.poll(() => assistant.evaluate(() => window.__voiceGuideEvidence.cancelCount)).toBeGreaterThan(1);

  await page.reload();
  const returned = page.locator("db-assistant");
  await expect(returned.locator("#launcher")).toBeEnabled();
  await returned.locator("#launcher").click();
  await expect(returned.locator("#voice-guide-toggle")).toHaveAttribute("aria-checked", "true");
  await returned.locator("#voice-guide-toggle").click();
  await expect(returned.locator("#voice-guide-toggle")).toHaveAttribute("aria-checked", "false");
  await expect(returned.locator("#voice-guide-helper")).toContainText("Alt+V");
});

test("voice guide shows a text fallback when the selected language has no voice", async ({ page }) => {
  const assistant = page.locator("db-assistant");
  await assistant.locator("#launcher").click();
  await assistant.locator("#language-select").selectOption("en");
  await expect(assistant.locator("#send")).toHaveText("Send");
  await assistant.evaluate((element) => {
    const speech = { speaking: false, paused: false, getVoices: () => [], cancel: () => {}, speak: () => {} };
    Object.defineProperty(window, "speechSynthesis", { configurable: true, value: speech });
    window.SpeechSynthesisUtterance = function (text) { this.text = text; };
    element._toggleVoiceGuide(true);
  });
  await expect(assistant.locator("#voice-caption-text")).toContainText("No English voice on this device");
  await expect(assistant.locator("#assistant-announcer")).toContainText("No English voice on this device");
});
