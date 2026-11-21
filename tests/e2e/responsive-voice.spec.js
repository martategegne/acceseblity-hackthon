import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";

test.use({ serviceWorkers: "block" });

const sections = JSON.parse(await readFile(new URL("../../demo/data/content.json", import.meta.url), "utf8"));
const amStrings = JSON.parse(await readFile(new URL("../../module/i18n/am.json", import.meta.url), "utf8")).strings;
const englishQuestion = sections[1].text.en;
const amharicQuestion = sections[1].text.am;

async function stubAssistantApi(page) {
  const languages = [];
  await page.route("**/api/v1/config", (route) => route.fulfill({ json: { externalAiConsentRequired: false } }));
  await page.route("**/api/v1/ask", async (route) => {
    const { language } = route.request().postDataJSON();
    languages.push(language);
    await route.fulfill({
      json: {
        answer: language === "am" ? sections[1].text.am : sections[1].text.en,
        sources: [{ url: "https://example.test/course#section", title: "Course section" }]
      }
    });
  });
  return languages;
}

test("assistant stays within narrow viewports and page controls remain keyboard reachable", async ({ page }) => {
  for (const viewport of [{ width: 640, height: 800 }, { width: 320, height: 720 }]) {
    await page.setViewportSize(viewport);
    await page.goto("/demo/blank.html");
    const assistant = page.locator("db-assistant");
    await expect(assistant.locator("#launcher")).toBeEnabled();
    await assistant.evaluate((element) => {
      const control = document.createElement("button");
      control.id = "page-control";
      control.textContent = "Page control";
      control.style.cssText = "position:fixed;inset:8px auto auto 8px;z-index:2147483647;min-height:44px";
      control.addEventListener("click", () => control.dataset.activated = "true");
      element.after(control);
    });
    await assistant.locator("#launcher").click();

    const panelBox = await assistant.locator("#panel").boundingBox();
    const controlBox = await page.locator("#page-control").boundingBox();
    expect(panelBox.width).toBe(viewport.width);
    expect(panelBox.height).toBeLessThanOrEqual(Math.ceil(viewport.height * 0.74));
    expect(panelBox.y + panelBox.height).toBeLessThanOrEqual(viewport.height);
    expect(controlBox.y + controlBox.height).toBeLessThanOrEqual(panelBox.y);

    let pageControlFocused = false;
    for (let tab = 0; tab < 24; tab++) {
      pageControlFocused = await page.evaluate(() => document.activeElement?.id === "page-control");
      if (pageControlFocused) break;
      await page.keyboard.press("Tab");
    }
    expect(pageControlFocused).toBeTruthy();
    await page.keyboard.press("Enter");
    await expect(page.locator("#page-control")).toHaveAttribute("data-activated", "true");
  }
});

test("keyboard-only lesson flow reaches language, answer citation, and tutor request", async ({ page }) => {
  await page.goto("/savanna/pages/concept-with-navigation.html");
  const assistant = page.locator("db-assistant");
  const launcher = assistant.locator("#launcher");
  await expect(launcher).toBeEnabled();

  let launcherFocused = false;
  for (let tab = 0; tab < 80; tab++) {
    await page.keyboard.press("Tab");
    launcherFocused = await assistant.evaluate((element) => element.shadowRoot.activeElement?.id === "launcher");
    if (launcherFocused) break;
  }
  expect(launcherFocused).toBeTruthy();
  await page.keyboard.press("Enter");
  await expect(assistant.locator("#panel-title")).toBeFocused();

  const languageSelect = assistant.locator("#language-select");
  let languageFocused = false;
  for (let tab = 0; tab < 6; tab++) {
    await page.keyboard.press("Tab");
    languageFocused = await assistant.evaluate((element) => element.shadowRoot.activeElement?.id === "language-select");
    if (languageFocused) break;
  }
  expect(languageFocused).toBeTruthy();
  await expect(languageSelect).toBeFocused();
  await page.keyboard.press("Home");
  await page.keyboard.press("ArrowDown");
  await expect.poll(() => assistant.evaluate((element) => element._pack?.lang)).toBe("am");
  await expect(assistant.locator("#lesson-explore-list button").first()).toHaveAttribute("lang", "am");
  await page.keyboard.press("Tab");
  const exploreSummary = assistant.locator("#lesson-explore > summary");
  await expect(exploreSummary).toBeFocused();
  await page.keyboard.press("Enter");
  await expect.poll(() => assistant.locator("#lesson-explore").evaluate((element) => element.open)).toBe(true);
  await page.keyboard.press("Enter");
  await expect.poll(() => assistant.locator("#lesson-explore").evaluate((element) => element.open)).toBe(false);
  await page.keyboard.press("Enter");
  await expect.poll(() => assistant.locator("#lesson-explore").evaluate((element) => element.open)).toBe(true);
  await page.keyboard.press("Tab");
  const firstSuggestion = assistant.locator("#lesson-explore-list button").first();
  await expect(firstSuggestion).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(assistant.locator("#question")).toBeFocused();
  await expect(assistant.locator("#question")).toHaveValue(await firstSuggestion.getAttribute("data-question"));

  await page.keyboard.press("Control+A");
  await page.keyboard.press("Backspace");
  await page.keyboard.type(amharicQuestion);
  await page.keyboard.press("Enter");
  const answer = assistant.locator("#messages .message-assistant").last();
  await expect(answer).toContainText(amharicQuestion.slice(0, 32));
  const citation = answer.locator("a.course-link");
  await expect(citation).toHaveAttribute("href", /concept-with-navigation\.html#/);

  let citationFocused = await citation.evaluate((element) => element.getRootNode().activeElement === element);
  for (let tab = 0; tab < 24 && !citationFocused; tab++) {
    await page.keyboard.press("Shift+Tab");
    citationFocused = await citation.evaluate((element) => element.getRootNode().activeElement === element);
  }
  expect(citationFocused).toBeTruthy();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/#artificial-intelligence-and-the-future-of-va-work/);

  await page.keyboard.press("Escape");
  await expect(launcher).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(assistant.locator("#panel-title")).toBeFocused();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await expect(assistant.locator("#person")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(assistant.locator("#escalation-reason")).toBeFocused();
});

test("launcher stays in document flow at compact zoom-like viewport widths", async ({ page }) => {
  await page.setViewportSize({ width: 640, height: 800 });
  await page.goto("/demo/blank.html");
  const assistant = page.locator("db-assistant");
  await expect(assistant.locator("#launcher")).toBeEnabled();
  await assistant.evaluate((element) => {
    const control = document.createElement("button");
    control.id = "page-control";
    control.textContent = "Page control";
    element.before(control);
  });

  expect(await assistant.locator("#launcher").evaluate((element) => getComputedStyle(element).position)).toBe("static");
  const controlBox = await page.locator("#page-control").boundingBox();
  const launcherBox = await assistant.locator("#launcher").boundingBox();
  expect(controlBox.y + controlBox.height).toBeLessThanOrEqual(launcherBox.y);
});

test("assistant reflows without horizontal overflow across mobile, tablet, and desktop widths", async ({ page }) => {
  for (const viewport of [
    { width: 320, height: 720 },
    { width: 390, height: 844 },
    { width: 768, height: 900 },
    { width: 1024, height: 768 },
    { width: 1440, height: 900 }
  ]) {
    await page.setViewportSize(viewport);
    await page.goto("/demo/blank.html");
    const assistant = page.locator("db-assistant");
    await expect(assistant.locator("#launcher")).toBeEnabled();
    await assistant.locator("#launcher").click();

    const panelBox = await assistant.locator("#panel").boundingBox();
    const pageMetrics = await page.evaluate(() => ({
      width: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth
    }));
    expect(panelBox.x).toBeGreaterThanOrEqual(0);
    expect(panelBox.x + panelBox.width).toBeLessThanOrEqual(viewport.width);
    expect(panelBox.y + panelBox.height).toBeLessThanOrEqual(viewport.height);
    expect(pageMetrics.scrollWidth).toBeLessThanOrEqual(pageMetrics.width);
  }
});

test("blank-host Bootstrap variables theme the isolated widget", async ({ page }) => {
  await page.goto("/demo/blank.html");
  const assistant = page.locator("db-assistant");
  await expect(assistant.locator("#launcher")).toBeEnabled();
  await assistant.evaluate((element) => {
    element.style.setProperty("--bs-primary", "#0047ab");
    element.style.setProperty("--bs-body-font-family", "Arial, sans-serif");
    element.style.setProperty("--bs-body-color", "#102030");
    element.style.setProperty("--bs-body-bg", "#ffffff");
  });
  await expect.poll(() => assistant.locator("#launcher").evaluate(
    (element) => getComputedStyle(element).backgroundColor
  )).toBe("rgb(0, 71, 171)");
  const styles = await assistant.evaluate((element) => ({
    fontFamily: getComputedStyle(element).fontFamily,
    bodyColor: getComputedStyle(element).color
  }));
  expect(styles.fontFamily).toContain("Arial");
  expect(styles.bodyColor).toBe("rgb(16, 32, 48)");
});

test("speech recognition fills the question for review without sending it", async ({ page }) => {
  await page.addInitScript(() => {
    class FakeSpeechRecognition {
      start() {
        window.__recognizedLanguage = this.lang;
        setTimeout(() => this.onresult?.({ results: [[{ transcript: "recognized test words" }]] }), 0);
      }
      stop() {}
    }
    Object.defineProperty(window, "SpeechRecognition", { value: FakeSpeechRecognition, configurable: true });
  });
  await page.goto("/demo/blank.html");
  const assistant = page.locator("db-assistant");
  await expect(assistant.locator("#launcher")).toBeEnabled();
  await assistant.evaluate((element) => element.setAttribute("lang", "en"));
  await assistant.locator("#launcher").click();
  await assistant.locator("#microphone").click();

  await expect(assistant.locator("#question")).toHaveValue("recognized test words");
  await expect(assistant.locator("#voice-status")).toContainText("Review it before sending");
  expect(await page.evaluate(() => window.__recognizedLanguage)).toBe("en-US");
  await expect(assistant.locator("#messages .message-user")).toHaveCount(0);

  await assistant.evaluate((element) => element.setAttribute("lang", "am"));
  await expect(assistant.locator("#language-select")).toHaveValue("am");
  await assistant.locator("#microphone").click();
  await expect(assistant.locator("#question")).toHaveValue("recognized test words");
  expect(await page.evaluate(() => window.__recognizedLanguage)).toBe("am-ET");
  await expect(assistant.locator("#messages .message-user")).toHaveCount(0);

  for (const [language, tag] of [["ti", "ti-ET"], ["om", "om-ET"], ["so", "so-SO"], ["ar", "ar-SA"]]) {
    await assistant.locator("#language-select").selectOption(language);
    await expect.poll(() => assistant.evaluate((element) => element._pack?.lang)).toBe(language);
    await assistant.locator("#microphone").click();
    await expect(assistant.locator("#question")).toHaveValue("recognized test words");
    expect(await page.evaluate(() => window.__recognizedLanguage)).toBe(tag);
    await expect(assistant.locator("#messages .message-user")).toHaveCount(0);
  }
});

test("microphone permission denial is explicit and does not request access twice", async ({ page }) => {
  await page.addInitScript(() => {
    window.__microphoneRequests = 0;
    class DeniedSpeechRecognition {
      start() {
        setTimeout(() => this.onerror?.({ error: "not-allowed" }), 0);
      }
      stop() {}
    }
    Object.defineProperty(window, "SpeechRecognition", { value: DeniedSpeechRecognition, configurable: true });
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: async () => {
          window.__microphoneRequests++;
          throw new DOMException("Permission denied", "NotAllowedError");
        }
      }
    });
  });
  await page.goto("/demo/blank.html");
  const assistant = page.locator("db-assistant");
  await expect(assistant.locator("#launcher")).toBeEnabled();
  await assistant.evaluate((element) => element.setAttribute("lang", "en"));
  await assistant.locator("#launcher").click();
  await assistant.locator("#microphone").click();

  await expect(assistant.locator("#voice-status")).toContainText("Microphone access was not allowed");
  expect(await page.evaluate(() => window.__microphoneRequests)).toBe(0);
  await expect(assistant.locator("#microphone")).toHaveAttribute("aria-pressed", "false");
  await expect(assistant.locator("#messages .message-user")).toHaveCount(0);
});

test("spoken task records and reports unavailable offline transcription clearly", async ({ page }) => {
  await page.addInitScript(() => {
    window.__recordingStarts = 0;
    window.__recordingStops = 0;
    class FakeMediaRecorder {
      constructor() { this.handlers = {}; this.state = "inactive"; this.mimeType = "audio/webm"; }
      addEventListener(name, callback) { this.handlers[name] = callback; }
      start() { this.state = "recording"; window.__recordingStarts++; }
      stop() {
        this.state = "inactive";
        window.__recordingStops++;
        this.handlers.dataavailable?.({ data: new Blob(["voice-task-test"], { type: this.mimeType }) });
        this.handlers.stop?.();
      }
    }
    Object.defineProperty(window, "MediaRecorder", { value: FakeMediaRecorder, configurable: true });
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) }
    });
  });
  await page.goto("/demo/blank.html");
  const assistant = page.locator("db-assistant");
  await expect(assistant.locator("#launcher")).toBeEnabled();
  await assistant.evaluate((element) => element.setAttribute("lang", "en"));
  await assistant.locator("#launcher").click();
  await assistant.locator("#voice-command").click();
  await expect(assistant.locator("#stop-voice")).toBeVisible();
  expect(await page.evaluate(() => window.__recordingStarts)).toBe(1);

  const commandResponse = page.waitForResponse((response) =>
    response.request().method() === "POST" &&
    new URL(response.url()).pathname === "/api/v1/voice/commands"
  );
  await assistant.locator("#stop-voice").click();
  expect(await page.evaluate(() => window.__recordingStops)).toBe(1);
  const response = await commandResponse;
  expect(response.status()).toBe(503);
  expect((await response.json()).detail).toContain("not configured");
  await expect(assistant.locator("#voice-status")).toContainText("Offline speech transcription is unavailable");
});

test("spoken task sends a reviewed tutor draft without a button and reuses its idempotency key", async ({ page }) => {
  const transcripts = ["ask a tutor about lesson access", "ask a tutor about lesson access", "send it"];
  const voiceCalls = [];
  await page.addInitScript(() => {
    window.__recordingCount = 0;
    class FakeMediaRecorder {
      constructor() { this.handlers = {}; this.state = "inactive"; this.mimeType = "audio/webm"; }
      addEventListener(name, callback) { this.handlers[name] = callback; }
      start() { this.state = "recording"; window.__activeRecorder = this; }
      stop() {
        this.state = "inactive";
        window.__recordingCount++;
        this.handlers.dataavailable?.({ data: new Blob([`recording-${window.__recordingCount}`], { type: this.mimeType }) });
        this.handlers.stop?.();
      }
    }
    Object.defineProperty(window, "MediaRecorder", { value: FakeMediaRecorder, configurable: true });
    Object.defineProperty(navigator, "mediaDevices", { value: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) }, configurable: true });
    Object.defineProperty(window, "SpeechSynthesisUtterance", { value: class { constructor(text) { this.text = text; } }, configurable: true });
    Object.defineProperty(window, "speechSynthesis", { value: { getVoices: () => [{ lang: "en-US" }], cancel() {}, speak() {} }, configurable: true });
  }, transcripts);
  await page.route("**/api/v1/voice/commands", async (route) => {
    const payload = route.request().postDataJSON();
    voiceCalls.push({ payload, headers: route.request().headers() });
    const transcript = transcripts[voiceCalls.length - 1];
    if (transcript === "ask a tutor about lesson access" && payload.shareConsent) {
      await route.fulfill({ json: {
        status: "draft", action: "request_tutor", transcript, language: "en",
        answerText: "Review this tutor request, then say send it.",
        draft: { conversation: [{ role: "user", text: "ask a tutor about lesson access" }], language: "en", page: "/demo/blank.html" },
        draftToken: "signed-test-draft"
      } });
      return;
    }
    if (transcript === "ask a tutor about lesson access") {
      await route.fulfill({ json: { status: "consent_required", action: "request_tutor", transcript,
                                    language: "en", answerText: "Please consent before sharing." } });
      return;
    }
    await route.abort("failed");
  });
  const retries = [];
  await page.route("**/api/v1/voice/actions/sync", async (route) => {
    const action = route.request().postDataJSON().actions[0];
    retries.push(action.idempotencyKey);
    await route.fulfill({ json: { results: [{
      id: action.id,
      status: "sent", action: "send_tutor_request", transcript: "ask a tutor about lesson access", language: "en",
      answerText: "Your tutor request was sent.", ticket: { ticketId: "ticket-123", accessToken: "learner-token" }
    }] } });
  });

  await page.goto("/demo/blank.html");
  const assistant = page.locator("db-assistant");
  await expect(assistant.locator("#launcher")).toBeEnabled();
  console.log("STAGE launcher");
  await assistant.locator("#launcher").click();
  const recordCommand = async () => {
    await assistant.locator("#voice-command").click();
    await expect(assistant.locator("#stop-voice")).toBeVisible();
    await assistant.locator("#stop-voice").click();
  };
  await recordCommand();
  await expect(assistant.locator("#escalation")).toBeVisible();
  console.log("STAGE escalation");
  await assistant.locator("#consent").check();
  await recordCommand();
  await expect(assistant.locator("#messages")).toContainText("Review this tutor request");
  await expect(assistant.locator("#messages")).toContainText("ask a tutor about lesson access");

  await recordCommand();
  await expect(assistant.locator("#messages")).toContainText("Your tutor request was sent.");
  expect(voiceCalls).toHaveLength(3);
  expect(voiceCalls[2].payload.draftToken).toBe("signed-test-draft");
  expect(voiceCalls[2].headers["idempotency-key"]).toBeTruthy();
  await expect.poll(() => retries.length).toBe(1);
  expect(retries[0]).toBe(voiceCalls[2].headers["idempotency-key"]);
  await expect(assistant.locator("#check-tutor-reply")).toBeVisible();
});

test("voice guide is shown as text and spoken, and offline voice questions sync later", async ({ page, context }) => {
  await page.addInitScript(() => {
    class FakeMediaRecorder {
      constructor() { this.handlers = {}; this.state = "inactive"; this.mimeType = "audio/webm"; }
      addEventListener(name, callback) { this.handlers[name] = callback; }
      start() { this.state = "recording"; }
      stop() {
        this.state = "inactive";
        this.handlers.dataavailable?.({ data: new Blob(["offline-recording"], { type: this.mimeType }) });
        this.handlers.stop?.();
      }
    }
    Object.defineProperty(window, "MediaRecorder", { value: FakeMediaRecorder, configurable: true });
    Object.defineProperty(navigator, "mediaDevices", { value: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) }, configurable: true });
    Object.defineProperty(window, "SpeechSynthesisUtterance", { value: class { constructor(text) { this.text = text; } }, configurable: true });
    window.__spokenGuide = [];
    Object.defineProperty(window, "speechSynthesis", { value: {
      getVoices: () => [{ lang: "en-US" }],
      cancel() {},
      speak(utterance) { window.__spokenGuide.push(utterance.text); }
    }, configurable: true });
  });
  let syncCalls = 0;
  await page.route("**/api/v1/voice/guide?**", (route) => route.fulfill({ json: {
    language: "en", steps: ["Ask a lesson question.", "Review the answer."], text: "1. Ask a lesson question.\n2. Review the answer.",
    speakText: "Ask a lesson question. Review the answer."
  } }));
  await page.route("**/api/v1/voice/actions/sync", async (route) => {
    syncCalls++;
    await route.fulfill({ json: { results: [{ id: route.request().postDataJSON().actions[0].id, status: "processed", action: "ask",
      transcript: "explain this lesson", language: "en", answerText: "This is the sourced lesson answer.",
      sources: [{ title: "Lesson", url: "/lesson#source" }], grounding: { status: "verified" } }] } });
  });

  await page.goto("/demo/blank.html");
  const assistant = page.locator("db-assistant");
  await expect(assistant.locator("#launcher")).toBeEnabled();
  await assistant.evaluate((element) => element.setAttribute("lang", "en"));
  await assistant.locator("#launcher").click();
  expect(await page.evaluate(() => window.__spokenGuide)).toEqual([]);
  await assistant.locator("#voice-guide").click();
  await expect(assistant.locator("#messages")).toContainText("Ask a lesson question.");
  expect(await page.evaluate(() => window.__spokenGuide)).toEqual(["Ask a lesson question. Review the answer."]);

  await context.setOffline(true);
  await assistant.locator("#voice-command").click();
  await expect(assistant.locator("#stop-voice")).toBeVisible();
  await assistant.locator("#stop-voice").click();
  await expect(assistant.locator("#voice-status")).toContainText("Saved on this phone");
  const storedQueue = await assistant.evaluate((element) => JSON.parse(localStorage.getItem(element._voiceQueueKey) || "[]"));
  expect(storedQueue).toHaveLength(1);
  expect(storedQueue[0].audioDataUrl).toContain("data:audio/webm;base64,");

  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect(assistant.locator("#messages")).toContainText("This is the sourced lesson answer.");
  await expect.poll(() => syncCalls).toBeGreaterThan(0);
  expect(await assistant.evaluate((element) => JSON.parse(localStorage.getItem(element._voiceQueueKey) || "[]"))).toHaveLength(0);
});

test("unsupported voice input reports a readable limitation", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "SpeechRecognition", { value: undefined, configurable: true });
    Object.defineProperty(window, "webkitSpeechRecognition", { value: undefined, configurable: true });
    Object.defineProperty(navigator, "mediaDevices", { value: undefined, configurable: true });
    Object.defineProperty(window, "MediaRecorder", { value: undefined, configurable: true });
  });
  await page.goto("/demo/blank.html");
  const assistant = page.locator("db-assistant");
  await expect(assistant.locator("#launcher")).toBeEnabled();
  await assistant.evaluate((element) => element.setAttribute("lang", "en"));
  await expect(assistant.locator("#language-select")).toHaveValue("en");
  await assistant.locator("#launcher").click();
  await assistant.locator("#microphone").click();
  await expect(assistant.locator("#voice-status")).toContainText("unavailable");
  await expect(assistant.locator("#voice-help")).toContainText("depend on your browser, device, and selected language");
});

test("Listen speaks English and Amharic replies only after an explicit click", async ({ page }) => {
  const requestedLanguages = await stubAssistantApi(page);
  await page.addInitScript(() => {
    class FakeUtterance {
      constructor(text) { this.text = text; }
    }
    Object.defineProperty(window, "SpeechSynthesisUtterance", { value: FakeUtterance, configurable: true });
    Object.defineProperty(window, "speechSynthesis", {
      configurable: true,
      value: {
        getVoices: () => [{ lang: "en-US" }, { lang: "am-ET" }],
        cancel: () => {},
        speak: (utterance) => {
          window.__spoken ||= [];
          window.__spoken.push({ text: utterance.text, lang: utterance.lang });
        }
      }
    });
  });
  await page.goto("/demo/blank.html");
  const assistant = page.locator("db-assistant");
  await expect(assistant.locator("#launcher")).toBeEnabled();
  await assistant.evaluate((element) => element.setAttribute("lang", "en"));
  await expect.poll(() => assistant.evaluate((element) => element._sections.length)).toBeGreaterThan(0);
  await assistant.locator("#launcher").click();
  await assistant.locator("#question").fill(englishQuestion);
  await assistant.locator("#send").click();
  const answer = assistant.locator("#messages .message-assistant").last();
  await expect(answer.locator(".message-body")).not.toBeEmpty();
  await expect(answer.locator("a.course-link")).toHaveAttribute("href", "https://example.test/course#section");
  expect(await page.evaluate(() => window.__spoken || [])).toHaveLength(0);
  await answer.locator(".listen-button").click();
  let spoken = await page.evaluate(() => window.__spoken);
  expect(spoken[0].text).toBe(await answer.locator(".message-body").textContent());
  expect(spoken[0].lang).toBe("en-US");

  await assistant.locator("#language-select").selectOption("am");
  await expect(assistant).toHaveAttribute("lang", "am");
  await expect(assistant.locator("#send")).toHaveText("ላክ");
  await assistant.locator("#question").fill(amharicQuestion);
  const previousAnswerCount = await assistant.locator("#messages .message-assistant").count();
  await assistant.locator("#send").click();
  await expect(assistant.locator("#messages .message-assistant")).toHaveCount(previousAnswerCount + 1);
  expect(requestedLanguages).toEqual(["en", "am"]);
  const amharicAnswer = assistant.locator("#messages .message-assistant").last();
  await expect(amharicAnswer.locator(".message-body")).not.toBeEmpty();
  expect(await page.evaluate(() => window.__spoken)).toHaveLength(1);
  await amharicAnswer.locator(".listen-button").click();
  spoken = await page.evaluate(() => window.__spoken);
  expect(spoken[1].text).toBe(await amharicAnswer.locator(".message-body").textContent());
  expect(spoken[1].lang).toBe("am-ET");
});

test("missing Amharic speech voice leaves the reply readable and reports the limitation", async ({ page }) => {
  await stubAssistantApi(page);
  await page.addInitScript(() => {
    class FakeUtterance {
      constructor(text) { this.text = text; }
    }
    Object.defineProperty(window, "SpeechSynthesisUtterance", { value: FakeUtterance, configurable: true });
    Object.defineProperty(window, "speechSynthesis", {
      configurable: true,
      value: {
        getVoices: () => [{ lang: "en-US" }],
        cancel: () => {},
        speak: () => { window.__speechStarted = true; }
      }
    });
    window.__audioConstructed = false;
    window.Audio = class {
      constructor() { window.__audioConstructed = true; }
    };
  });
  await page.goto("/demo/blank.html");
  const assistant = page.locator("db-assistant");
  await expect(assistant.locator("#launcher")).toBeEnabled();
  await assistant.evaluate((element) => element.setAttribute("lang", "am"));
  await assistant.locator("#launcher").click();
  await assistant.locator("#question").fill(amharicQuestion);
  await assistant.locator("#send").click();

  const answer = assistant.locator("#messages .message-assistant").last();
  await expect(answer.locator(".message-body")).not.toBeEmpty();
  expect(await page.evaluate(() => window.__speechStarted || false)).toBe(false);
  await answer.locator(".listen-button").click();
  await expect(answer.locator(".voice-status")).toContainText(amStrings.noSpeechVoice);
  await expect(answer.locator(".message-body")).not.toBeEmpty();
  expect(await page.evaluate(() => window.__speechStarted || false)).toBe(false);
  expect(await page.evaluate(() => window.__audioConstructed)).toBe(false);
});

test("Listen requests the selected locale voice only after learner activation", async ({ page }) => {
  await page.addInitScript(() => {
    class FakeUtterance {
      constructor(text) { this.text = text; }
    }
    const voices = ["en-US", "am-ET", "ti-ET", "om-ET", "so-SO", "ar-SA"].map((lang) => ({ lang }));
    Object.defineProperty(window, "SpeechSynthesisUtterance", { value: FakeUtterance, configurable: true });
    Object.defineProperty(window, "speechSynthesis", {
      configurable: true,
      value: {
        getVoices: () => voices,
        cancel: () => {},
        speak: (utterance) => {
          window.__spoken ||= [];
          window.__spoken.push({ text: utterance.text, lang: utterance.lang });
        }
      }
    });
  });
  await page.goto("/demo/blank.html");
  const assistant = page.locator("db-assistant");
  await expect(assistant.locator("#launcher")).toBeEnabled();
  await assistant.evaluate((element) => element.setAttribute("lang", "en"));
  await expect.poll(() => assistant.evaluate((element) => element._pack?.lang)).toBe("en");
  await assistant.locator("#launcher").click();

  const expected = [["en", "en-US"], ["am", "am-ET"], ["ti", "ti-ET"], ["om", "om-ET"], ["so", "so-SO"], ["ar", "ar-SA"]];
  for (const [language, tag] of expected) {
    await assistant.evaluate((element, lang) => {
      element._appendMessage({ role: "assistant", text: `Reply in ${lang}`, lang });
    }, language);
    await expect.poll(() => assistant.evaluate((element) => element._pack?.lang)).toBe("en");
    const reply = assistant.locator("#messages .message-assistant").last();
    await expect(reply.locator(".message-body")).toContainText(`Reply in ${language}`);
    expect(await page.evaluate(() => window.__spoken || [])).toHaveLength(expected.indexOf(expected.find((entry) => entry[0] === language)));
    await reply.locator(".listen-button").click();
    const spoken = await page.evaluate(() => window.__spoken.at(-1));
    expect(spoken.lang).toBe(tag);
  }
});

test("escalation and accommodation forms fit within narrow viewports and RTL layout does not overflow", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 720 });
  await page.goto("/demo/blank.html");
  const assistant = page.locator("db-assistant");
  await expect(assistant.locator("#launcher")).toBeEnabled();
  await assistant.locator("#launcher").click();
  await assistant.evaluate((element) => element.setAttribute("lang", "en"));
  await expect(assistant.locator("#language-select")).toHaveValue("en");

  // Test escalation form at 320px
  await assistant.getByRole("button", { name: "Talk to a person" }).click();
  await expect(assistant.locator("#escalation")).toBeVisible();
  const escalationBox = await assistant.locator("#escalation").boundingBox();
  expect(escalationBox.width).toBeLessThanOrEqual(320);

  // Test accommodation form at 320px
  await assistant.locator("#accommodation-open").click();
  await expect(assistant.locator("#accommodation-form")).toBeVisible();
  const accommodationBox = await assistant.locator("#accommodation-form").boundingBox();
  expect(accommodationBox.width).toBeLessThanOrEqual(320);

  // Test Arabic RTL
  await assistant.evaluate((element) => element.setAttribute("lang", "ar"));
  await expect(assistant.locator("#panel")).toHaveAttribute("dir", "rtl");
  const panelBox = await assistant.locator("#panel").boundingBox();
  expect(panelBox.x).toBeGreaterThanOrEqual(0);
  expect(panelBox.width).toBeLessThanOrEqual(320);
});
