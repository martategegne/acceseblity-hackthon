# Accessibility gate: co-designer manual run

**Co-designer report received (2026-11-20):** The project co-designer reports completing a check and that the flow worked. The session date, URL/revision, consent, device/browser, assistive technology, actual zoom, sound condition, and task-by-task observations were not supplied. Formal evidence for keyboard-only, NVDA/TalkBack, sound-off, and real 200% zoom remains incomplete; automated evidence below is not a substitute and does not establish WCAG 2.2 AA conformance.

## Pitch-day co-designer task card

Use the hosted HTTPS Savanna lesson page, not localhost:
`https://savanna-assistant-demo.onrender.com/savanna/pages/concept-with-navigation.html`

Use synthetic questions and test identifiers only. Arrange for a human helper to be available for the reply step. Do not put helper tokens, private contact details, or learner information in notes, screenshots, or recordings. Explain the tasks before starting, then let the co-designer use the product without coaching. If they ask for help, provide it and record the step and wording.

### Record before starting

- Session date and time (include timezone):
- Co-designer identifier (consented identifier only):
- Consent to take notes:
- Recording choice and consent (none / screen / audio / other):
- Device make/model:
- Operating system and version:
- Browser and version:
- Screen reader and version (or “not used”):
- Viewport in CSS pixels:
- Actual browser zoom percentage:
- Sound off / device muted?:
- Hosted demo URL:
- Helper available to reply?:
- Channel to be demonstrated (widget reply / HTTP SMS simulator / real SMS):
- If SMS simulator: synthetic sender label (not a real phone number):

### Read these tasks to the co-designer

1. **Keyboard-only, one minute:** Use only the keyboard to reach and open the assistant, ask a lesson question, follow its citation, return to the assistant, and request a person. Record whether focus stayed visible and whether the request could be submitted.
2. **English source:** Ask a question about a real Savanna lesson section. Ask whether the answer is understandable, where it came from, and whether the citation opens the right section.
3. **Amharic source:** Switch to Amharic and ask the equivalent question. Record the co-designer’s experience of the answer and source; the presence of Amharic text is not proof of translation quality.
4. **Off-topic handoff:** Ask, “How do I bake bread?” Check that the assistant says it can only help with this course and offers a person. Try the handoff; record every step and barrier.
5. **Helper reply:** Have the helper reply. Ask the co-designer to find and understand the reply through the actual channel being demonstrated.
6. **Access conditions:** Repeat the main task with sound off, at actual 200% browser zoom, and with NVDA or TalkBack where available. Record each condition separately. A narrow viewport is not a substitute for actual zoom.

If using the HTTP SMS simulator, say that it simulates an HTTP provider callback and is not a phone SMS. Claim real SMS only after a real device and configured provider have delivered and received the test message; record that evidence separately. A missing helper response is not a completed reply task.

### Observer record

For each task, choose one outcome: **completed independently / completed with help / not completed**.

| Task / condition | Outcome | Steps where the co-designer hesitated or needed help | Exact barriers and comments (co-designer’s words) | Follow-up fix and owner | Retest result |
|---|---|---|---|---|---|
| One-minute keyboard task |  |  |  |  |  |
| English answer and citation |  |  |  |  |  |
| Amharic answer and citation |  |  |  |  |  |
| Off-topic response and handoff |  |  |  |  |  |
| Helper reply through demonstrated channel |  |  |  |  |  |
| Sound off |  |  |  |  |  |
| Actual 200% browser zoom |  |  |  |  |  |
| NVDA or TalkBack (if available) |  |  |  |  |  |

Do not fill in a result for a task that was not run. Keep accessibility criteria at Partly or Does not until observations support a change. Do not mark the gate complete or claim WCAG conformance based on this session alone.

The longer keyboard, screen-reader, zoom, sound-off, and device checklists below are supplementary; automated checks remain separate evidence.

## Manual run record (copy once per co-designer run)

- Tester:
- Co-designer name or consented identifier:
- Test date and time (include timezone):
- Device make/model:
- Operating system and version/build:
- Browser and version:
- Screen reader and version (or “none”):
- Viewport in CSS pixels:
- Actual browser zoom percentage (do not substitute viewport emulation):
- Display/font scaling:
- Test language(s):
- Test page(s) and URL:
- Network state:
- Main learner task completed unaided? **Not run**
- Co-designer consent to record results: **Not recorded**

| Required condition | Actual setting | Main task result (Pass/Fail/Not run) | Barriers, evidence, and follow-up |
|---|---|---|---|
| Keyboard-only |  | Not run |  |
| NVDA (Windows) or TalkBack (Android) |  | Not run |  |
| Sound off / device muted |  | Not run |  |
| Actual browser zoom at 200% |  | Not run |  |

### Required main learner task

Arrange for a tutor/helper to send an update or reply during the run. With keyboard-only operation, the selected screen reader enabled, sound muted, and actual browser zoom set to 200%:

1. Ask a question about the current course lesson.
2. Open and follow the answer’s course source link, then return to the assistant.
3. Request tutor help.
4. Return to the assistant and read a tutor update or reply.

Record whether the co-designer completed the entire sequence without tester assistance. Note the step and exact barrier for anything not completed. A missing tutor reply is an uncompleted task, not a pass. The gate remains **NOT RUN / NOT PASSED** until this task is completed unaided under all four required conditions and the record is filled in.

## Keyboard only

1. Reload. Use Tab until the launcher is focused; confirm its focus outline is easy to see and the target is at least 44 by 44 CSS pixels. Press Enter or Space.
2. Confirm focus moves to the chat heading. Press Tab through Close, Talk to a person, the accommodation action, language choices, question field, voice controls, and Send in that order. Do not use a mouse.
3. Confirm you can still Tab to and activate a page link while the non-modal chat is open. Press Escape from inside the chat and again after tabbing to a page control. Confirm the panel closes and focus returns to the launcher.
4. Submit an empty question. Confirm a worded error appears, the question field receives focus, and the field is marked invalid. Enter a question; confirm the error clears. Check Enter sends and Shift+Enter inserts a line break.
5. Open Talk to a person, enter an invalid phone number, and send. Confirm the field gets a visible error and focus, then correct it and submit.
6. Tab to each checkbox, microphone, Stop, Listen, audio player, and screen/page sharing control. Confirm each has a visible focus indicator and can be operated without dragging.
7. Use the language selector to choose English, Amharic, Tigrinya, Afaan Oromo, Somali, and Arabic. Confirm the selected interface text and message language are understandable; Arabic alone should be RTL. Record any untranslated or mixed-language content rather than assuming it is correct.

## TalkBack, eyes closed (Android Chrome over HTTPS)

1. Turn on TalkBack, close your eyes, reload, and navigate by swipe. Find and activate the assistant launcher by its spoken name.
2. Listen to the heading, labels, Talk to a person action, language controls, input, and Send button. Confirm focus does not jump when a new message arrives.
3. Ask a short question. Confirm TalkBack announces the added message politely and the answer is also readable as text. Find its source link and Listen control by swipe.
4. Change to Amharic. Confirm the language controls and new messages are announced in Amharic and the message direction follows its text.
5. Open the microphone only by activating its button. Confirm the visible Listening/recording state is announced, Stop works, and recognized text is not sent until Send is pressed. With sound off, confirm all spoken output remains available as text and nothing autoplays.
6. Open an accommodation request. Listen for the privacy statement and confirm it says the choice is for the tutor and is not shared with an employer.

## NVDA (Windows, Chrome or Firefox)

1. With NVDA running, open the blank demo and navigate to the launcher using Tab. Open the chat and confirm the heading is announced as a dialog heading.
2. Use Tab and Shift+Tab to check the full focus order, visible focus, and Escape/return-focus behavior. Confirm the page remains usable while the panel is open.
3. Ask a question and listen for one polite message announcement, then browse the message as text. Check its source link and Listen button.
4. Trigger the empty-question and invalid-phone errors. Confirm each error is spoken and associated with its field; correct the input and confirm invalid state clears.

## 200% zoom and 320 CSS px

1. At 200% browser zoom, open the chat. Repeat at a 320 CSS-pixel viewport (DevTools device emulation is acceptable).
2. Confirm the panel is a full-width bottom sheet, stays within 80vh, scrolls internally, and does not cover or prevent access to page controls.
3. Open both escalation forms and the screen/page assistance section. Confirm no labels, buttons, errors, or submit actions are clipped; use scroll instead of relying on hidden content.
4. Repeat with Amharic and Arabic (`lang="ar"`) and confirm RTL placement does not push controls off-screen.
5. At actual 200% browser zoom, also open the sharing consent and sharing controls; confirm the status and Stop control remain visible/reachable and do not block page controls. Record actual zoom separately from the 320 CSS-pixel viewport result.

## Sound off

1. Mute the device. Load the page and open the assistant. Confirm there is no automatic speech or audio playback.
2. Ask a question and use only the text transcript and links. Confirm every assistant message has a Listen button even though sound is muted.
3. If available, activate Listen and voice input explicitly; stop them. Confirm the transcript and visible status remain understandable with sound off.

## Recorded automated evidence (2026-11-15)

- **200% zoom / narrow view:** Playwright Chromium passed the responsive check at 640×800 and 320×720 CSS-pixel viewports. It confirms the panel fits the viewport and an outside page control remains keyboard-operable. The 640px case is a narrow-viewport approximation, not a real browser-zoom run; the requested manual 200% check remains outstanding.
- **Search and sources:** Playwright confirmed the Amharic API answer and local-search answer each have their course link; an unrelated question has no unrelated link.
- **AI layer:** Only exact excerpts present in a cited, retrieved section are accepted. API tests confirm uncited, unknown, and non-extractive provider claims fall back to course text.
- **Voice:** `npm.cmd run test:e2e -- tests/e2e/responsive-voice.spec.js` completed with **6 passed**. Browser API stubs confirm recognized text is left for review, English and Amharic Listen controls call synthesis only after activation, the missing-Amharic-voice state keeps the reply readable, and an unsupported recognition browser gets a readable limitation. These stubs do not test physical microphone permissions, real speech engines, Amharic recognition or playback, or device/browser compatibility; use the [voice-device checklist](./voice-device-checklist.md).
- **Tutor follow-up:** Playwright confirmed that a tutor update can be shown while a ticket stays open and that a final tutor reply is displayed and closes the follow-up check. No real after-hours staffing or response time was measured or promised.
- **Privacy controls:** Playwright confirmed a learner can export their ticket, delete that ticket using its private token, and clear widget-local history and keys. These controls do not erase SQLite/WAL or backup copies.

These automated checks do not replace the co-designer main-task run, TalkBack, NVDA, actual 200% browser zoom, or real-device speech checks above. Record each human run in the template above; do not infer a 200% result from a narrow-viewport test.

## Low-cost Android field run (not yet performed)

Use the lowest-cost Android phone available to the team, on the intended Android version and Chrome build, with TalkBack available. Record the model, OS/build, Chrome version, display/font scaling, network conditions, tester, and date before starting. On a clean install, open the lesson once online, allow the service worker to install, then reload in airplane mode; verify the lesson and assistant scripts still load. With TalkBack, keyboard/soft-keyboard only, and sound muted, complete a course search, source link, offline-question queue/retry, and tutor request. Note data usage, memory pressure, failures, and any controls that become unreachable. **Status: not performed; do not claim Android field validation.**

## Screen-sharing device run record (not yet performed)

Copy this record for each target device/browser and have the learner or co-designer explicitly approve the sharing actions.

- Tester/co-designer (consented identifier):
- Test date/time and timezone:
- Device make/model and OS/version:
- Browser/version:
- Screen reader/version (if used):
- Viewport in CSS pixels and actual zoom:
- Page origin (HTTPS or localhost):
- Network type/conditions:
- Share mode offered (desktop capture / Android page context / unavailable):
- Did capture remain off until consent and the explicit action?:
- Was the browser's source picker shown (where applicable)?:
- Was the "You are sharing your screen" status announced and Stop usable?:
- Did Stop and browser-ended capture stop the stream and clear the ticket/signaling?:
- Page-context fields and selected screenshot actually sent:
- Helper connection outcome, disconnect/error status, and timeout observed:
- Barriers, privacy concerns, follow-up owner, and retest result:

**Status: not performed.** Automated media/WebRTC stubs are not physical-device, network, or helper interoperability evidence.
