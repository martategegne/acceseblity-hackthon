import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";

const sections = JSON.parse(await readFile(new URL("../../demo/data/content.json", import.meta.url), "utf8"));
const amharicQuestion = sections[1].text.am;
const trackLanguages = ["en", "am", "ti", "om", "so"];
const locales = Object.fromEntries(await Promise.all(trackLanguages.map(async (language) => [
  language,
  JSON.parse(await readFile(new URL(`../../module/i18n/${language}.json`, import.meta.url), "utf8"))
])));

test("Amharic answer is linked and learners can follow up on a queued tutor request", async ({ page, request }) => {
  const contentResponse = await request.post("/api/v1/content", {
    headers: { "X-Helper-Token": "e2e-helper-token" },
    data: sections
  });
  expect(contentResponse.status()).toBe(200);
  await page.goto("/demo/blank.html");
  const assistant = page.locator("db-assistant");
  await expect(assistant.locator("#launcher")).toBeEnabled();
  await assistant.evaluate((element) => element.setAttribute("lang", "am"));
  await assistant.locator("#launcher").click();
  await assistant.locator("#question").fill(amharicQuestion);
  await assistant.locator("#send").click();

  const answer = assistant.locator("#messages .message-assistant").last();
  await expect(answer).toContainText(amharicQuestion.slice(0, 24));
  await expect(answer.locator("a.course-link")).toHaveAttribute("href", /concept-with-navigation\.html#/);
  await expect(answer.locator("a.course-link")).toHaveCount(1);
  const ticketIdPromise = assistant.evaluate((element) => new Promise((resolve) => {
    element.addEventListener("db-assistant:escalated", (event) => resolve(event.detail.ticketId), { once: true });
  }));
  await assistant.getByRole("button", { name: "ከሰው ጋር ይነጋገሩ" }).click();
  await assistant.locator("#escalation-reason").selectOption("learner_requested_person");
  const createResponsePromise = page.waitForResponse((response) =>
    response.request().method() === "POST" &&
    new URL(response.url()).pathname === "/api/v1/escalations"
  );
  await assistant.locator("#send-escalation").click();
  const createResponse = await createResponsePromise;
  expect(createResponse.status()).toBe(201);
  const ticketId = await ticketIdPromise;
  expect((await createResponse.json()).ticketId).toBe(ticketId);
  expect(ticketId).toMatch(/^[0-9a-f-]{36}$/i);
  await expect(assistant.locator("#escalation-status")).toContainText(ticketId);
  await expect(assistant.locator("#check-tutor-reply")).toBeVisible();
  await expect(assistant.locator("#tutor-availability")).toContainText("የምላሽ ጊዜ ይለያያል");
  await expect(assistant.locator("#ticket-data-select option")).toContainText("የጥያቄ 1");

  const ticketUrl = `/api/v1/escalations/${ticketId}/reply`;
  const helperHeaders = { "X-Helper-Token": "e2e-helper-token" };
  const inboxResponse = await request.get("/api/v1/escalations", { headers: helperHeaders });
  expect(inboxResponse.status()).toBe(200);
  const helperTicket = (await inboxResponse.json()).find((entry) => entry.ticketId === ticketId);
  expect(helperTicket.handoffBrief.reason).toBe("learner_requested_person");
  expect(helperTicket.conversation).toEqual([]);
  const updateResponse = await request.post(ticketUrl, {
    headers: helperHeaders,
    data: { text: "I am unavailable right now; I will follow up later.", resolve: false }
  });
  expect(updateResponse.status()).toBe(200);
  await assistant.locator("#check-tutor-reply").click();
  await expect(assistant.locator("#messages .message-assistant").last()).toContainText("I am unavailable right now");
  await expect(assistant.locator("#check-tutor-reply")).toBeVisible();

  await page.reload();
  const returnedAssistant = page.locator("db-assistant");
  await expect(returnedAssistant.locator("#launcher")).toBeEnabled();
  await returnedAssistant.evaluate((element) => element.setAttribute("api", location.origin));
  await returnedAssistant.evaluate((element) => element.setAttribute("lang", "en"));
  await expect(returnedAssistant.locator("#language-select")).toHaveValue("en");
  await returnedAssistant.locator("#launcher").click();
  await returnedAssistant.getByRole("button", { name: "Talk to a person" }).click();
  await expect(returnedAssistant.locator("#check-tutor-reply")).toBeVisible();

  const finalReplyResponse = await request.post(ticketUrl, {
    headers: helperHeaders,
    data: { text: "I am available now and can help.", resolve: true }
  });
  expect(finalReplyResponse.status()).toBe(200);
  await returnedAssistant.locator("#check-tutor-reply").click();
  await expect(returnedAssistant.locator("#messages .message-assistant").last()).toContainText("I am available now");
  await expect(returnedAssistant.locator("#check-tutor-reply")).toBeHidden();

  await expect(returnedAssistant.locator("#ticket-data")).toBeVisible();
  const downloadPromise = page.waitForEvent("download");
  await returnedAssistant.locator("#export-ticket-data").click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe(`tutor-request-${ticketId}.json`);
  const learnerTicket = await returnedAssistant.evaluate((element) => {
    const stored = JSON.parse(localStorage.getItem(`${element._storageKey}:learner-tickets`) || "[]");
    return stored.find((ticket) => ticket.ticketId === element._pendingTutorTicketId) || stored[0];
  });
  const exportedData = await request.get(`/api/v1/escalations/${ticketId}/data`, {
    headers: { "X-Learner-Token": learnerTicket.accessToken }
  });
  expect(exportedData.status()).toBe(200);
  expect((await exportedData.json()).reply).toBe("I am available now and can help.");

  page.once("dialog", (dialog) => dialog.accept());
  await returnedAssistant.locator("#delete-ticket-data").click();
  await expect(returnedAssistant.locator("#ticket-data-status")).toContainText("deleted");
  await expect(returnedAssistant.locator("#ticket-data")).toBeHidden();
  expect((await request.get(`/api/v1/escalations/${ticketId}/data`, {
    headers: { "X-Learner-Token": learnerTicket.accessToken }
  })).status()).toBe(404);

  page.once("dialog", (dialog) => dialog.accept());
  await returnedAssistant.locator("#clear-local-data").click();
  await expect(returnedAssistant.locator("#escalation-status")).toContainText("Local assistant data cleared");
  await expect(returnedAssistant.locator("#messages .message")).toHaveCount(0);
  expect(await page.evaluate((key) => localStorage.getItem(key), await returnedAssistant.evaluate((element) => element._storageKey))).toBeNull();
});

test("learner conversation is included in a tutor ticket only after explicit consent", async ({ page, request }) => {
  const helperHeaders = { "X-Helper-Token": "e2e-helper-token" };
  const seeded = await request.post("/api/v1/content", { headers: helperHeaders, data: sections });
  expect(seeded.status()).toBe(200);
  const ticketIds = [];
  try {
    await page.goto("/demo/blank.html");
    const assistant = page.locator("db-assistant");
    await expect(assistant.locator("#launcher")).toBeEnabled();
    await assistant.evaluate((element) => element.setAttribute("lang", "en"));
    await expect(assistant.locator("#language-select")).toHaveValue("en");
    await assistant.locator("#launcher").click();
    const question = sections[1].titles.en;
    await assistant.locator("#question").fill(question);
    await assistant.locator("#send").click();
    await expect(assistant.locator("#messages .message-assistant").last()).toBeVisible();

    await assistant.getByRole("button", { name: "Talk to a person" }).click();
    await assistant.locator("#escalation-reason").selectOption("learner_requested_person");
    const firstCreate = page.waitForResponse((response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/v1/escalations"
    );
    await assistant.locator("#send-escalation").click();
    const firstResponse = await firstCreate;
    expect(firstResponse.status()).toBe(201);
    ticketIds.push((await firstResponse.json()).ticketId);
    await expect(assistant.locator("#escalation-status")).toContainText(ticketIds[0]);

    let inbox = await request.get("/api/v1/escalations", { headers: helperHeaders });
    let ticket = (await inbox.json()).find((entry) => entry.ticketId === ticketIds[0]);
    expect(ticket.conversation).toEqual([]);

    await assistant.locator("#escalation-reason").selectOption("answer_flagged_incorrect");
    await assistant.locator("#consent").check();
    const secondCreate = page.waitForResponse((response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/v1/escalations"
    );
    await assistant.locator("#send-escalation").click();
    const secondResponse = await secondCreate;
    expect(secondResponse.status()).toBe(201);
    ticketIds.push((await secondResponse.json()).ticketId);
    await expect(assistant.locator("#escalation-status")).toContainText(ticketIds[1]);

    inbox = await request.get("/api/v1/escalations", { headers: helperHeaders });
    ticket = (await inbox.json()).find((entry) => entry.ticketId === ticketIds[1]);
    expect(ticket.handoffBrief.reason).toBe("answer_flagged_incorrect");
    expect(ticket.conversation.some((message) => message.text === question)).toBe(true);
    expect(ticket.conversation.some((message) => message.role === "assistant")).toBe(true);
  } finally {
    for (const ticketId of ticketIds) {
      await request.delete(`/api/v1/escalations/${ticketId}`, { headers: helperHeaders });
    }
  }
});

test("tutor requests require a reason and send Other details to the helper inbox", async ({ page, request }) => {
  let ticketId;
  const helperHeaders = { "X-Helper-Token": "e2e-helper-token" };
  try {
    await page.goto("/demo/blank.html");
    const assistant = page.locator("db-assistant");
    await expect(assistant.locator("#launcher")).toBeEnabled();
    await assistant.evaluate((element) => element.setAttribute("lang", "en"));
    await expect(assistant.locator("#language-select")).toHaveValue("en");
    await assistant.locator("#launcher").click();
    await assistant.getByRole("button", { name: "Talk to a person" }).click();

    const reason = assistant.locator("#escalation-reason");
    await expect(reason).toHaveJSProperty("required", true);
    await expect(reason.locator("option")).toHaveText([
      "Choose a request type",
      "I couldn't find the answer in the course",
      "I want to speak with a tutor",
      "I think an answer is incorrect",
      "Other"
    ]);

    await assistant.locator("#send-escalation").click();
    await expect(reason).toHaveAttribute("aria-invalid", "true");
    await expect(assistant.locator("#escalation-reason-error")).toBeVisible();
    await expect(reason).toBeFocused();

    await reason.selectOption("other");
    await expect(assistant.locator("#escalation-note-label")).toHaveText("Describe what you need help with");
    await expect(assistant.locator("#escalation-note")).toHaveJSProperty("required", true);
    await assistant.locator("#send-escalation").click();
    await expect(assistant.locator("#escalation-other-error")).toBeVisible();
    await expect(assistant.locator("#escalation-note")).toHaveAttribute("aria-invalid", "true");

    await assistant.locator("#escalation-note").fill("I need help with a course access issue.");
    const createResponse = page.waitForResponse((response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/v1/escalations"
    );
    await assistant.locator("#send-escalation").click();
    const response = await createResponse;
    expect(response.status()).toBe(201);
    ticketId = (await response.json()).ticketId;
    await expect(assistant.locator("#escalation-status")).toContainText(ticketId);

    const ticketsResponse = await request.get("/api/v1/escalations", { headers: helperHeaders });
    expect(ticketsResponse.status()).toBe(200);
    const ticket = (await ticketsResponse.json()).find((entry) => entry.ticketId === ticketId);
    expect(ticket.handoffBrief.reason).toBe("other");
    expect(ticket.note).toBe("I need help with a course access issue.");
  } finally {
    if (ticketId) {
      await request.delete(`/api/v1/escalations/${ticketId}`, { headers: helperHeaders });
    }
  }
});

test("course source links from the blank demo open the cited course section", async ({ page }) => {
  const section = sections[0];
  await page.goto("/demo/blank.html");
  const assistant = page.locator("db-assistant");
  await expect(assistant.locator("#launcher")).toBeEnabled();
  await assistant.evaluate((element) => element.setAttribute("lang", "en"));
  await expect(assistant.locator("#language-select")).toHaveValue("en");
  await assistant.locator("#launcher").click();
  await assistant.locator("#question").fill("What is shaping the future of virtual assistant work?");
  await assistant.locator("#send").click();

  const courseLink = assistant.locator("#messages .message-assistant a.course-link").last();
  await expect(courseLink).toHaveAttribute("href", section.url);
  const navigationResponse = page.waitForResponse((response) =>
    response.request().isNavigationRequest() &&
    new URL(response.url()).pathname === "/savanna/pages/concept-with-navigation.html"
  );
  await courseLink.click();
  const response = await navigationResponse;
  expect(response.status()).toBe(200);
  await expect(page).toHaveURL(new RegExp(`/savanna/pages/concept-with-navigation\\.html#${section.id}$`));
  await expect(page.locator(`#${section.id}`)).toBeVisible();
});

test("lesson exploration uses current lesson text, localizes prompts, and does not auto-submit", async ({ page }) => {
  let askRequests = 0;
  await page.route("**/api/v1/ask", (route) => {
    askRequests += 1;
    return route.continue();
  });
  await page.goto("/savanna/pages/concept-with-navigation.html");
  const assistant = page.locator("db-assistant");
  await expect(assistant.locator("#launcher")).toBeEnabled();
  await assistant.locator("#launcher").click();

  const explore = assistant.locator("#lesson-explore");
  const exploreSummary = explore.locator("summary");
  await expect.poll(() => explore.evaluate((element) => element.open)).toBe(false);
  await exploreSummary.focus();
  await page.keyboard.press("Enter");
  await expect.poll(() => explore.evaluate((element) => element.open)).toBe(true);
  await page.keyboard.press("Enter");
  await expect.poll(() => explore.evaluate((element) => element.open)).toBe(false);
  await page.keyboard.press("Enter");
  await expect.poll(() => explore.evaluate((element) => element.open)).toBe(true);

  const suggestions = assistant.locator("#lesson-explore-list button");
  await expect(suggestions).toHaveCount(3);
  await expect(assistant.locator("#lesson-explore-heading")).toHaveText(locales.am.strings.exploreHeading);
  await expect(suggestions.first()).toHaveAttribute("lang", "am");
  await expect(suggestions.first()).toContainText(sections[0].titles.am);
  const amharicQuestion = await suggestions.first().getAttribute("data-question");
  await suggestions.first().click();
  await expect(assistant.locator("#question")).toHaveValue(amharicQuestion);
  await expect(assistant.locator("#lesson-explore-status")).toHaveText(locales.am.strings.exploreInserted);
  expect(askRequests).toBe(0);

  await assistant.locator("#language-select").selectOption("ti");
  await expect.poll(() => assistant.evaluate((element) => element._pack?.lang)).toBe("ti");
  await expect(assistant.locator("#lesson-explore-fallback")).toBeVisible();
  await expect(assistant.locator("#lesson-explore-fallback")).toContainText("English");
  await expect(suggestions.first()).toHaveAttribute("lang", "en");
  await expect(suggestions.first()).toContainText(sections[0].titles.en);
  const fallbackQuestion = await suggestions.first().getAttribute("data-question");
  await suggestions.first().click();
  await expect(assistant.locator("#question")).toHaveValue(fallbackQuestion);
  expect(askRequests).toBe(0);

  await page.goto("/demo/blank.html");
  const blankAssistant = page.locator("db-assistant");
  await expect(blankAssistant.locator("#launcher")).toBeEnabled();
  await blankAssistant.evaluate((element) => element.setAttribute("lang", "en"));
  await blankAssistant.locator("#launcher").click();
  await expect(blankAssistant.locator("#lesson-explore-status")).toHaveText(locales.en.strings.exploreEmpty);
  await expect(blankAssistant.locator("#lesson-explore-list button")).toHaveCount(0);
});

test("lesson suggestions reflow on mobile and desktop without horizontal scrolling", async ({ page }) => {
  for (const viewport of [{ width: 320, height: 800 }, { width: 390, height: 844 }, { width: 1440, height: 900 }]) {
    await page.setViewportSize(viewport);
    await page.goto("/savanna/pages/concept-with-navigation.html");
    const assistant = page.locator("db-assistant");
    await expect(assistant.locator("#launcher")).toBeEnabled();
    await assistant.locator("#launcher").click();
    await assistant.locator("#lesson-explore > summary").click();

    const metrics = await assistant.evaluate((element) => {
      const root = element.shadowRoot;
      const details = root.querySelector("#lesson-explore");
      const list = root.querySelector("#lesson-explore-list");
      const firstSuggestion = list.querySelector("button");
      const panel = root.querySelector("#panel");
      const suggestionStyle = getComputedStyle(firstSuggestion);
      return {
        panelWidth: panel.clientWidth,
        panelScrollWidth: panel.scrollWidth,
        detailsWidth: details.clientWidth,
        detailsScrollWidth: details.scrollWidth,
        listWidth: list.clientWidth,
        listScrollWidth: list.scrollWidth,
        suggestionWidth: firstSuggestion.getBoundingClientRect().width,
        suggestionHeight: firstSuggestion.getBoundingClientRect().height,
        suggestionFontSize: parseFloat(suggestionStyle.fontSize),
        suggestionLineHeight: parseFloat(suggestionStyle.lineHeight),
        count: list.querySelectorAll("button").length
      };
    });

    expect(metrics.count).toBe(3);
    expect(metrics.panelScrollWidth).toBeLessThanOrEqual(metrics.panelWidth);
    expect(metrics.detailsScrollWidth).toBeLessThanOrEqual(metrics.detailsWidth);
    expect(metrics.listScrollWidth).toBeLessThanOrEqual(metrics.listWidth);
    expect(metrics.suggestionWidth).toBeLessThanOrEqual(metrics.listWidth);
    expect(metrics.suggestionHeight).toBeGreaterThanOrEqual(44);
    expect(metrics.suggestionLineHeight).toBeGreaterThan(metrics.suggestionFontSize * 1.7);
  }
});

test("lesson exploration shows a retryable error when lesson content is unavailable", async ({ page }) => {
  await page.route("**/demo/data/content.json", (route) => route.abort());
  await page.goto("/savanna/pages/concept-with-navigation.html");
  const assistant = page.locator("db-assistant");
  await expect(assistant.locator("#launcher")).toBeEnabled();
  await assistant.locator("#launcher").click();
  await assistant.locator("#lesson-explore > summary").click();
  await expect(assistant.locator("#lesson-explore-status")).toHaveText(locales.am.strings.exploreError);
  const retry = assistant.locator("#lesson-explore-retry");
  await expect(retry).toBeVisible();
  await page.unroute("**/demo/data/content.json");
  await retry.click();
  await expect(assistant.locator("#lesson-explore-list button")).toHaveCount(3);
});

test("answer actions copy only the answer, report clipboard failures, and retain Listen", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text) => {
          if (window.__failClipboard) throw new Error("Clipboard unavailable");
          window.__copiedAnswer = text;
        }
      }
    });
  });
  await page.route("**/api/v1/config", (route) => route.fulfill({ json: { externalAiConsentRequired: false } }));
  await page.route("**/api/v1/ask", (route) => route.fulfill({
    json: {
      answer: sections[1].text.am,
      sources: [{ url: sections[1].url, title: sections[1].titles.am }]
    }
  }));
  await page.goto("/savanna/pages/concept-with-navigation.html");
  const assistant = page.locator("db-assistant");
  await expect(assistant.locator("#launcher")).toBeEnabled();
  await assistant.locator("#launcher").click();
  const learnerPrompt = "የሙከራ ጥያቄ ጽሑፍ";
  await assistant.locator("#question").fill(learnerPrompt);
  await assistant.locator("#send").click();

  const answer = assistant.locator("#messages .message-assistant").last();
  await expect(answer.locator("a.course-link")).toHaveAttribute("href", sections[1].url);
  const copy = answer.getByRole("button", { name: locales.am.strings.copyAnswer });
  await expect(copy).toBeVisible();
  await expect(copy).toHaveAttribute("lang", "am");
  await expect(answer.getByRole("button", { name: locales.am.strings.listen })).toBeVisible();
  await copy.click();
  await expect(answer.locator(".answer-copy-status")).toHaveText(locales.am.strings.answerCopied);
  expect(await page.evaluate(() => window.__copiedAnswer)).toBe(sections[1].text.am);
  expect(await page.evaluate(() => window.__copiedAnswer)).not.toBe(learnerPrompt);

  await page.evaluate(() => { window.__failClipboard = true; });
  await copy.click();
  await expect(answer.locator(".answer-copy-status")).toHaveText(locales.am.strings.copyAnswerFailed);

  await assistant.locator("#language-select").selectOption("ti");
  await expect.poll(() => assistant.evaluate((element) => element._pack?.lang)).toBe("ti");
  const englishFallbackCopy = answer.getByRole("button", { name: locales.en.strings.copyAnswer });
  await expect(englishFallbackCopy).toHaveAttribute("lang", "en");
});

test("accommodation request announces its queued ticket ID", async ({ page, request }) => {
  await page.goto("/demo/blank.html");
  const assistant = page.locator("db-assistant");
  await expect(assistant.locator("#launcher")).toBeEnabled();
  await assistant.evaluate((element) => element.setAttribute("lang", "en"));
  await assistant.locator("#launcher").click();
  await assistant.locator("#accommodation-open").click();
  await expect.poll(() => assistant.locator("#accommodation-job option").count()).toBeGreaterThan(0);
  await assistant.locator("#accommodation-choice").selectOption({ index: 0 });

  let ticketId;
  try {
    const ticketIdPromise = assistant.evaluate((element) => new Promise((resolve) => {
      element.addEventListener("db-assistant:escalated", (event) => resolve(event.detail.ticketId), { once: true });
    }));
    await assistant.locator("#accommodation-send").click();
    ticketId = await ticketIdPromise;
    expect(ticketId).toMatch(/^[0-9a-f-]{36}$/i);
    await expect(assistant.locator("#accommodation-status")).toContainText(ticketId);
  } finally {
    if (ticketId) {
      await request.delete(`/api/v1/escalations/${ticketId}`, {
        headers: { "X-Helper-Token": "e2e-helper-token" }
      });
    }
  }
});

test("helper can send an interim update and later close the same ticket", async ({ page, request }) => {
  const createResponse = await request.post("/api/v1/escalations", {
    data: { conversation: [], language: "en", page: "https://example.test/lesson", note: "Follow-up test" }
  });
  expect(createResponse.status()).toBe(201);
  const ticketId = (await createResponse.json()).ticketId;
  const helperHeaders = { "X-Helper-Token": "e2e-helper-token" };
  const ticketUrl = `/api/v1/escalations/${ticketId}`;
  try {
    await page.goto("/helper");
    await page.locator("#token").fill("e2e-helper-token");
    await page.getByRole("button", { name: "Load waiting requests" }).click();
    const ticket = page.locator(".ticket").filter({ hasText: ticketId });
    await expect(ticket).toBeVisible();
    await ticket.locator("textarea").fill("I am unavailable right now; I will follow up later.");
    await ticket.locator('input[type="checkbox"]').check();
    await ticket.getByRole("button", { name: "Send reply" }).click();
    await expect(ticket).toContainText("remains open for follow-up");
    await expect(ticket.getByRole("button", { name: "Send reply" })).toBeEnabled();

    await ticket.locator("textarea").fill("I am available now and can help.");
    await ticket.locator('input[type="checkbox"]').uncheck();
    await ticket.getByRole("button", { name: "Send reply" }).click();
    await expect(ticket).toHaveCount(0);
  } finally {
    await request.delete(ticketUrl, { headers: helperHeaders });
  }
});

test("helper can close a ticket without replying or delete it from the inbox", async ({ page, request }) => {
  const createTicket = async (note) => {
    const response = await request.post("/api/v1/escalations", {
      data: { conversation: [], language: "en", page: "https://example.test/lesson", note }
    });
    expect(response.status()).toBe(201);
    return response.json();
  };
  const closed = await createTicket("Close-only test");
  const deleted = await createTicket("Delete-only test");
  const helperHeaders = { "X-Helper-Token": "e2e-helper-token" };
  try {
    await page.goto("/helper");
    await page.locator("#token").fill("e2e-helper-token");
    await page.getByRole("button", { name: "Load waiting requests" }).click();

    const closedTicket = page.locator(".ticket").filter({ hasText: closed.ticketId });
    await expect(closedTicket).toBeVisible();
    page.once("dialog", (dialog) => dialog.accept());
    await closedTicket.getByRole("button", { name: "Close ticket" }).click();
    await expect(closedTicket).toHaveCount(0);
    const closedStatus = await request.get(`/api/v1/escalations/${closed.ticketId}`, {
      headers: { "X-Learner-Token": closed.accessToken }
    });
    expect(closedStatus.status()).toBe(200);
    expect((await closedStatus.json()).status).toBe("answered");

    const deletedTicket = page.locator(".ticket").filter({ hasText: deleted.ticketId });
    await expect(deletedTicket).toBeVisible();
    page.once("dialog", (dialog) => dialog.accept());
    await deletedTicket.getByRole("button", { name: "Delete request" }).click();
    await expect(deletedTicket).toHaveCount(0);
    expect((await request.get(`/api/v1/escalations/${deleted.ticketId}`)).status()).toBe(404);
  } finally {
    await request.delete(`/api/v1/escalations/${closed.ticketId}`, { headers: helperHeaders });
    await request.delete(`/api/v1/escalations/${deleted.ticketId}`, { headers: helperHeaders });
  }
});

test("course answers stay localized and linked across every supported learner language", async ({ page, request }) => {
  const section = sections[1];
  const pageErrors = [];
  const contentResponse = await request.post("/api/v1/content", {
    headers: { "X-Helper-Token": "e2e-helper-token" },
    data: sections
  });
  expect(contentResponse.status()).toBe(200);
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto("/savanna/pages/concept-with-navigation.html");
  const assistant = page.locator("db-assistant");
  await expect(assistant.locator("#launcher")).toBeEnabled();
  await assistant.locator("#launcher").click();

  for (const language of trackLanguages) {
    await assistant.locator("#language-select").selectOption(language);
    await expect.poll(() => assistant.evaluate((element) => element._pack?.lang)).toBe(language);
    await assistant.locator("#question").fill(section.titles[language]);
    await assistant.locator("#send").click();

    const answer = assistant.locator("#messages .message-assistant").last();
    await expect(answer).toHaveAttribute("lang", language);
    await expect(answer).toHaveAttribute("data-answer-status", "answered");
    await expect(answer).toContainText(section.text[language].slice(0, 40));
    await expect(answer.locator("a.course-link")).toContainText(section.titles[language]);
    await expect(answer.locator("a.course-link")).toHaveAttribute("href", section.url);
  }

  expect(pageErrors).toEqual([]);
});

test("sensitive questions remain refused without a course citation", async ({ page }) => {
  await page.goto("/demo/blank.html");
  const assistant = page.locator("db-assistant");
  await expect(assistant.locator("#launcher")).toBeEnabled();
  await assistant.evaluate((element) => element.setAttribute("lang", "en"));
  await assistant.locator("#launcher").click();
  await assistant.locator("#question").fill("Can you give me legal advice?");
  await assistant.locator("#send").click();

  const answer = assistant.locator("#messages .message-assistant").last();
  await expect(answer).toHaveAttribute("data-answer-status", "refused");
  await expect(answer).toContainText(locales.en.api.sensitive_refusal);
  await expect(answer.locator("a.course-link, .person-action")).toHaveCount(0);
});

test("question form exposes its busy state while a sourced answer is loading", async ({ page }) => {
  await page.route("**/api/v1/config", (route) => route.fulfill({ json: { externalAiConsentRequired: false } }));
  await page.route("**/api/v1/ask", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 300));
    await route.fulfill({
      json: {
        answer: sections[1].text.en,
        answerStatus: "answered",
        sources: [{ title: sections[1].titles.en, url: sections[1].url }]
      }
    });
  });
  await page.goto("/demo/blank.html");
  const assistant = page.locator("db-assistant");
  await expect(assistant.locator("#launcher")).toBeEnabled();
  await assistant.evaluate((element) => element.setAttribute("lang", "en"));
  await assistant.locator("#launcher").click();
  await assistant.locator("#question").fill(sections[1].titles.en);
  await assistant.locator("#send").click();

  await expect(assistant.locator("#form")).toHaveAttribute("aria-busy", "true");
  await expect(assistant.locator("#send")).toBeDisabled();
  await expect(assistant.locator("#messages .message-assistant").last()).toContainText(sections[1].text.en.slice(0, 40));
  await expect(assistant.locator("#form")).not.toHaveAttribute("aria-busy", "true");
  await expect(assistant.locator("#send")).toBeEnabled();
});

test("off-topic answers offer a localized accessible tutor handoff in each Track 3 language", async ({ page }) => {
  for (const language of trackLanguages) {
    const strings = locales[language].strings;
    await page.goto("/demo/blank.html");
    const assistant = page.locator("db-assistant");
    await expect(assistant.locator("#launcher")).toBeEnabled();
    await assistant.evaluate((element, selectedLanguage) => element.setAttribute("lang", selectedLanguage), language);
    await expect.poll(() => assistant.evaluate((element) => element._sections.length)).toBeGreaterThan(0);
    await assistant.locator("#launcher").click();
    await assistant.locator("#question").fill("How do I bake bread?");
    await assistant.locator("#send").click();

    const answer = assistant.locator("#messages .message-assistant").last();
    await expect(answer).toContainText(strings.offTopic);
    await expect(answer.locator("a.course-link")).toHaveCount(0);
    const helpButton = answer.getByRole("button", { name: strings.person });
    await expect(helpButton).toBeVisible();
    await helpButton.click();
    await expect(assistant.locator("#escalation-reason")).toBeFocused();
  }
});

test("Savanna lesson supports sourced answers, widget tutor follow-up, and separate SMS simulation", async ({ page, request }) => {
  const section = sections[1];
  const sender = "+12025550100";
  const helperHeaders = { "X-Helper-Token": "e2e-helper-token" };
  let widgetTicketId;
  let smsTicketId;

  try {
    await page.goto("/savanna/pages/concept-with-navigation.html");
    const assistant = page.locator("db-assistant");
    await expect(assistant.locator("#launcher")).toBeEnabled();
    await assistant.locator("#launcher").click();

    await assistant.evaluate((element) => element.setAttribute("lang", "en"));
    await assistant.locator("#question").fill(section.titles.en);
    await assistant.locator("#send").click();
    const englishAnswer = assistant.locator("#messages .message-assistant").last();
    await expect(englishAnswer).toContainText(section.text.en.slice(0, 40));
    await expect(englishAnswer.locator("a.course-link")).toHaveAttribute("href", section.url);

    await assistant.evaluate((element) => element.setAttribute("lang", "am"));
    await assistant.locator("#question").fill(section.titles.am);
    await assistant.locator("#send").click();
    const amharicAnswer = assistant.locator("#messages .message-assistant").last();
    await expect(amharicAnswer).toContainText(section.text.am.slice(0, 32));
    await expect(amharicAnswer.locator("a.course-link")).toHaveAttribute("href", section.url);

    await assistant.evaluate((element) => element.setAttribute("lang", "en"));
    await assistant.locator("#question").fill("How do I bake bread?");
    await assistant.locator("#send").click();
    const offTopicAnswer = assistant.locator("#messages .message-assistant").last();
    await expect(offTopicAnswer).toHaveAttribute("data-answer-status", "off_topic");
    await expect(offTopicAnswer).toContainText(locales.en.strings.offTopic);
    await expect(offTopicAnswer.locator("a.course-link")).toHaveCount(0);
    const personAction = offTopicAnswer.getByRole("button", { name: locales.en.strings.person });
    await expect(personAction).toBeVisible();
    await personAction.click();
    await expect(assistant.locator("#escalation-reason")).toBeFocused();
    await assistant.locator("#escalation-reason").selectOption("learner_requested_person");

    const widgetTicketIdPromise = assistant.evaluate((element) => new Promise((resolve) => {
      element.addEventListener("db-assistant:escalated", (event) => resolve(event.detail.ticketId), { once: true });
    }));
    const widgetCreateResponsePromise = page.waitForResponse((response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/v1/escalations"
    );
    await assistant.locator("#send-escalation").click();
    const widgetCreateResponse = await widgetCreateResponsePromise;
    expect(widgetCreateResponse.status()).toBe(201);
    const widgetTicket = await widgetCreateResponse.json();
    widgetTicketId = widgetTicket.ticketId;
    expect(await widgetTicketIdPromise).toBe(widgetTicketId);
    await expect(assistant.locator("#escalation-status")).toContainText(widgetTicketId);
    await expect(assistant.locator("#check-tutor-reply")).toBeVisible();

    const widgetHelperReply = await request.post(`/api/v1/escalations/${widgetTicketId}/reply`, {
      headers: helperHeaders,
      data: { text: "I can help with this course question.", resolve: true }
    });
    expect(widgetHelperReply.status()).toBe(200);
    await assistant.locator("#check-tutor-reply").click();
    await expect(assistant.locator("#messages .message-assistant").last())
      .toContainText("I can help with this course question.");
    await expect(assistant.locator("#check-tutor-reply")).toBeHidden();

    // SMS creates a separate ticket and is exercised only through the HTTP simulator.
    const inboxBefore = await request.get("/api/v1/escalations", { headers: helperHeaders });
    expect(inboxBefore.status()).toBe(200);
    const existingIds = new Set((await inboxBefore.json()).map((ticket) => ticket.ticketId));
    const smsRequest = await request.post("/sms/inbound", { data: { from: sender, text: "PERSON" } });
    expect(smsRequest.status()).toBe(200);
    const reference = (await smsRequest.text()).match(/STATUS ([A-F0-9]{8})/)?.[1];
    expect(reference).toBeTruthy();

    const inboxAfter = await request.get("/api/v1/escalations", { headers: helperHeaders });
    expect(inboxAfter.status()).toBe(200);
    const ticket = (await inboxAfter.json()).find((entry) => !existingIds.has(entry.ticketId));
    expect(ticket).toBeTruthy();
    smsTicketId = ticket.ticketId;

    await page.goto("/helper");
    await page.locator("#token").fill("e2e-helper-token");
    await page.getByRole("button", { name: "Load waiting requests" }).click();
    const helperTicket = page.locator(".ticket").filter({ hasText: smsTicketId });
    await expect(helperTicket).toBeVisible();
    await helperTicket.locator("textarea").fill("Please review the lesson source.");
    await helperTicket.getByRole("button", { name: "Send reply" }).click();
    await expect(helperTicket).toHaveCount(0);

    const status = await request.post("/sms/inbound", {
      data: { from: sender, text: `STATUS ${reference}` }
    });
    expect(status.status()).toBe(200);
    await expect(status).toBeOK();
    expect(await status.text()).toContain("Please review the lesson source.");
  } finally {
    if (widgetTicketId) {
      await request.delete(`/api/v1/escalations/${widgetTicketId}`, { headers: helperHeaders });
    }
    if (smsTicketId) {
      await request.delete(`/api/v1/escalations/${smsTicketId}`, { headers: helperHeaders });
    }
  }
});
