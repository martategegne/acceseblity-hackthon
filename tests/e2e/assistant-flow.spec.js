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

test("Savanna lesson answers link in English and Amharic and the SMS simulator returns a helper reply", async ({ page, request }) => {
  const section = sections[1];
  const sender = "+251911123456";
  const helperHeaders = { "X-Helper-Token": "e2e-helper-token" };
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
    if (smsTicketId) {
      await request.delete(`/api/v1/escalations/${smsTicketId}`, { headers: helperHeaders });
    }
  }
});
