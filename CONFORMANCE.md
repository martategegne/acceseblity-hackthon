# WCAG 2.2 AA self-assessment — not a conformance claim

This is a code-based self-assessment, not an independent accessibility audit or a claim of full WCAG conformance. “Supports” describes the feature as implemented in the repository; the whole product still needs manual testing with the target browsers, devices, and assistive technologies.

**Gate status: NOT VERIFIED.** The project co-designer reports completing a check and that the flow worked. The session date, tested URL/revision, consent, device/browser, screen reader, sound setting, actual zoom, and task-by-task results have not been recorded here. No repository evidence confirms the complete task under keyboard-only use, a screen reader, sound off, and actual 200% browser zoom together. Automated Playwright/axe results are not a substitute. Do not report this document as a completed WCAG 2.2 AA conformance report.

The required unaided task is to ask a course question, follow its source link, request tutor help, then return to read a tutor update or reply. The co-designer record must include the participant's name or consented identifier and consent, date, device/OS/browser/screen-reader versions, viewport, actual browser zoom, task outcome, keyboard-only, screen-reader, sound-off and 200% zoom results, barriers, and follow-up fixes. Use the [manual accessibility checklist](tests/manual/accessibility-co-designer-checklist.md). Do not treat a narrow viewport as evidence of actual 200% browser zoom. Keep untested criterion statuses at Partly or Does not, as appropriate, until evidence supports changing them.

Physical microphone, speech-recognition, and speech-synthesis combinations are also unverified. Use the [voice-device test record](tests/manual/voice-device-checklist.md); Playwright stubs are automated behavior checks, not device or language-support evidence.

The assistant selector now offers English, Amharic, Tigrinya, Afaan Oromo, Somali, and Arabic. Tigrinya, Afaan Oromo, and Somali locale/course/job text is present but has not been reviewed by fluent speakers. Requested speech locale tags and automated media stubs do not establish browser/device support. Screen sharing is demo-only direct WebRTC without configured STUN/TURN; physical-device/network interoperability is unverified.

| Criterion | Supports / Partly / Does not | Notes |
|---|---|---|
| 1.1.1 Non-text Content | Partly | The helper gives a learner-uploaded screenshot an alt text, and controls have text labels. Learners can send a screenshot only after selecting it and consenting. There has not been a complete audit of every image or other non-text item in all pages. |
| 1.2.1 Audio-only and Video-only (Prerecorded) | Partly | A tutor can play a learner's recorded voice note, but the code does not provide a transcript for that note. |
| 1.2.2 Captions (Prerecorded) | Supports | The repository contains no prerecorded synchronized audio/video program requiring captions. Tutor voice notes are audio-only. |
| 1.2.3 Audio Description or Media Alternative (Prerecorded) | Supports | The repository contains no prerecorded video that needs audio description or a media alternative. |
| 1.2.4 Captions (Live) | Supports | The desktop screen-sharing stream sends video only (`audio: false`); the current feature has no live audio to caption. |
| 1.2.5 Audio Description (Prerecorded) | Supports | The repository contains no prerecorded video requiring audio description. |
| 1.3.1 Info and Relationships | Partly | Pages use headings, landmarks, labels, lists, and status regions, but relationships and reading order have not been audited across all content and generated states. |
| 1.4.3 Contrast (Minimum) | Partly | The CSS defines foreground/background colors and visible focus styles, but all text, links, states, and themes have not been measured against contrast thresholds. |
| 1.4.4 Resize Text | Partly | The layouts use responsive CSS and relative units in places, but the full interface has not been verified at 200% text resize without loss. |
| 1.4.10 Reflow | Partly | Automated Playwright checks cover narrow 320 CSS-pixel layout behavior. No actual 200% browser zoom or complete page/state reflow audit is recorded. |
| 1.4.11 Non-text Contrast | Partly | Controls have borders and focus outlines in CSS; the contrast of every control boundary, icon, and state has not been measured. |
| 2.1.1 Keyboard | Partly | The widget uses native buttons, a native language selector, and form controls. Keyboard-only operation of every flow, including browser capture and voice prompts, still needs co-designer testing. |
| 2.1.2 No Keyboard Trap | Partly | The widget closes with Escape and returns focus to its launcher. The full page and all browser/helper states have not had a keyboard trap audit. |
| 2.4.3 Focus Order | Partly | The markup follows a mostly logical DOM order and the widget moves focus when it opens and closes. Complete flow-by-flow testing is outstanding. |
| 2.4.7 Focus Visible | Partly | The pages and widget define `:focus-visible` outlines. Confirm visibility in all themes, forced-colors mode, and embedded host pages. |
| 2.5.7 Dragging Movements | Supports | No app task requires a dragging movement; screen-source selection is delegated to the browser's native picker. |
| 2.5.8 Target Size (Minimum) | Partly | Many buttons have a 44-pixel minimum height, but every link, control, and spacing exception has not been measured. |
| 3.1.1 Language of Page | Partly | Demo pages declare a document language and the widget sets its language from the selected pack. The selector offers six locales; Tigrinya, Afaan Oromo, and Somali text has not had fluent-speaker review, and all page variants have not been checked. |
| 3.1.2 Language of Parts | Partly | Chat messages and translated controls set language attributes, and helper conversation lines preserve supported ticket language metadata. Mixed-language course content and every generated message have not been audited. |
| 3.3.1 Error Identification | Partly | Several form errors are shown in alert/status regions and the question input receives `aria-invalid`; not every server-side error is tied to a specific field. |
| 3.3.2 Labels or Instructions | Partly | Most inputs have associated labels and screen/page sharing describes consent and the data sent. Instructions and labels still need fluent-speaker and screen-reader review in each language and state. |
| 4.1.2 Name, Role, Value | Partly | The widget and helper use native controls, labels, accessible names, and a visible sharing Stop action. Assistive-technology output and all custom-element states have not been manually verified. |
| 4.1.3 Status Messages | Partly | The widget and helper use `role="status"`/`aria-live` for updates, including sharing and voice states, but announcement timing and completeness need testing with screen readers. |

**Human test record:** A co-designer success report has been received, but the session record is incomplete. Record the consented identifier, session date/time, tested URL, device/OS/browser, screen reader and version, viewport/actual zoom, sound setting, tasks completed, barriers, and follow-up. A low-cost Android run, physical voice runs for each claimed browser/language combination, screen-sharing network/device runs, and fluent-speaker review of the new translations are also outstanding. The accessibility gate remains **NOT VERIFIED**; this document is not a WCAG 2.2 AA conformance claim.
