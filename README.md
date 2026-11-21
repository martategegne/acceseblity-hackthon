# DIGITAL BRIDGE ACCESSIBILITY HACKATHON 2026

## Absari | Track 3: Multilingual assistant and live help

<p align="center">
  <strong>Answer &gt; evidence &gt; human help</strong>
</p>

<p align="center">
  <strong>Accessible multilingual learning support with evidence-based answers and a human handoff.</strong>
</p>

<p align="center">
  <img src="https://skillicons.dev/icons?i=javascript,python,fastapi,docker,nginx,playwright&perline=6" alt="JavaScript, Python, FastAPI, Docker, NGINX, and Playwright logos" />
</p>

<p align="center">
  <a href="#quick-start">Quick start</a> ·
  <a href="#architecture">Architecture</a> ·
  <a href="#api">API</a> ·
  <a href="#accessibility-and-privacy">Accessibility</a>
</p>

`db-assistant` is an accessibility-focused multilingual learning assistant for learners who need clear answers, reliable sources, and a simple way to request human help.

### Channel readiness

The web assistant, SMS flow, and Telegram bot are implemented and connected to the same evidence-based answer and tutor-handoff pipeline. SMS and Telegram are ready to work when their provider settings are added; this repository does not pretend that live carrier delivery or a live bot conversation has been tested without those credentials.

| Channel | Ready in this repository | Live requirement |
| --- | --- | --- |
| Web assistant | Yes — local/offline demo and embedded component | Docker Compose or a hosted deployment |
| SMS | Yes — JSON simulator, signed Twilio inbound webhook, tutor status, and opt-in job alerts | Twilio credentials, a public HTTPS URL, and `OFFLINE_MODE=false` |
| Telegram bot | Yes — long polling, text commands, tutor handoff/status, and voice-note support | A BotFather token, `OFFLINE_MODE=false`, and the Telegram worker profile |

See [Optional channel setup](#optional-channel-setup) for the short setup steps. The default remains offline, so a fresh checkout is safe to run without sending messages to external services.

## Submission profile

| | Details |
| --- | --- |
| **Hackathon** | Absari Accessibility Hackathon 2026 |
| **Track** | Track 3 — Multilingual assistant and live help |
| **Stack** | JavaScript web component, Python/FastAPI, Docker, and NGINX |
| **Languages** | English, Amharic, Tigrinya, Afaan Oromo, Somali, and Arabic |
| **Validation** | Automated checks are recorded; co-designer and fluent-speaker review remain open |

### Team

- **Marta Tegegne** — Lead, Savanna Integration & Demo
- **Zenebu Melaku** — Backend, AI & API Integration
- **Betelehem Meheret** — Product Design & Frontend Lead
- **Huda Hussen** — Accessibility & Co-Design Lead

## What the project does

- Answers questions from course and job content.
- Links answers to the relevant source section.
- Offers a collapsed-by-default lesson-exploration section with up to three localized questions from the current lesson; selecting one fills but does not send the prompt.
- Lets learners explicitly copy an assistant answer or use its existing Listen control; audio does not start automatically.
- Supports multilingual content and voice-friendly interaction.
- Queues questions for retry when connectivity is unreliable.
- Lets learners request a tutor and gives helpers a protected inbox.
- Provides a lightweight component that can be embedded in existing learning pages.

## Architecture

```text
Learner page / Savanna demo
          |
          v
Embeddable web component (module/)
          |
          v
FastAPI service (api/)
  retrieval · content · tutor escalation · helper tools
          |
          v
Demo content and optional local/cloud integrations
```

## Quick start

Requirements: Docker and Docker Compose.

```bash
cp .env.example .env
docker compose up
```

Open:

- Learner UI: <http://localhost:8080/>
- API documentation: <http://localhost:8081/docs>
- Helper inbox: <http://localhost:8081/helper>

Set a unique local `HELPER_TOKEN` in `.env`. Never commit secrets or place the helper token in learner-facing HTML or JavaScript.

For Twilio callbacks, set `OFFLINE_MODE=false`, configure `TWILIO_WEBHOOK_BASE_URL` to the public HTTPS origin, provide `TWILIO_AUTH_TOKEN`, and set `TWILIO_WEBHOOKS_ENABLED=true`. The reverse proxy forwards `/sms/` and `/voice/` to the API. See [Optional channel setup](#optional-channel-setup) below before configuring provider callbacks.

## Demo deployment

The root [render.yaml](./render.yaml) defines a Docker deployment for Render. The service runs in offline mode by default and uses ephemeral demo data; it is not intended for live learner information.

Hosted demo page: <https://savanna-assistant-demo.onrender.com/savanna/pages/concept-with-navigation.html>

A direct hosted check on 2026-11-20 found `/health/ready` ready; English and Amharic lesson questions cited the same lesson section; “How do I bake bread?” returned “I can only help with this course. Would you like a person to help?” without a course citation; and “Talk to a person” opened the handoff form. No ticket was submitted. The host did not expose its deployed commit ID.

## Configuration

The main settings are stored in `.env`:

| Variable | Purpose |
| --- | --- |
| `HELPER_TOKEN` | Protects helper and tutor-management endpoints |
| `OFFLINE_MODE` | Keeps optional external integrations disabled by default |
| `AI_PROVIDER` | Selects `none`, `local`, or `cloud` answer assistance |
| `ESCALATIONS_DB` | SQLite storage location for tutor tickets |
| `TICKET_RETENTION_DAYS` | Controls automatic ticket expiry |
| `VOICE_ACTION_SECRET` | Signs offline voice actions and learner tokens |

Optional SMS, Telegram, webhook, Ollama, cloud AI, Vosk, and Piper integrations are documented in [.env.example](./.env.example). Keep all credentials server-side.

## Optional channel setup

External channels are opt-in. The repository defaults to `OFFLINE_MODE=true`; this keeps Telegram polling and outbound SMS alerts disabled. Do not put provider tokens in source files or learner pages.

### SMS

SMS is ready in two modes:

1. **Local demo:** `POST /api/v1/sms/inbound` accepts JSON and exercises course answers, language selection, tutor requests, status checks, and job-alert consent without contacting a carrier.
2. **Live Twilio:** configure a public HTTPS origin in `TWILIO_WEBHOOK_BASE_URL`, set `TWILIO_AUTH_TOKEN`, set `TWILIO_WEBHOOKS_ENABLED=true`, and set `OFFLINE_MODE=false`. Configure the Twilio number's incoming-message webhook as `https://YOUR-HOST/sms/inbound` using HTTP POST. The endpoint validates Twilio's signature and returns TwiML with the course answer.

Supported commands include `HELP`, `LANG AM` (also `EN`, `TI`, `OM`, and `SO`), `JOBS`, `PERSON`, `STATUS CODE`, and alert opt-in/out commands. A quick local check is:

```bash
curl -X POST http://localhost:8081/api/v1/sms/inbound \
  -H 'Content-Type: application/json' \
  -d '{"from":"+251911000000","text":"HELP"}'
```

Outbound job-alert SMS also needs `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`, and `SMS_ENCRYPTION_KEY`. Generate the encryption key with `python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"`. Learners text `ALERT` to see the sender and cost disclosure, `ALERT ON` to review it, then `ALERT YES` to opt in. They can send `ALERT OFF` at any time. Carrier fees may apply. `POST /api/v1/jobs/notify` sends alerts only after a helper authenticates with `X-Helper-Token`.

### Telegram

The Telegram bot is ready to run as a separate long-polling worker. Create a bot with `@BotFather` (`/newbot`), place its token in `TELEGRAM_BOT_TOKEN`, set `OFFLINE_MODE=false`, then run:

```bash
docker compose --profile telegram up --build -d
```

Start a private chat with the bot and send `/start`; try a lesson question, `/lang am`, `/jobs`, `/person`, and `/status CODE`. Telegram supports text and voice-note handling and sends tutor requests into the same protected helper inbox used by the web and SMS channels. Voice notes require the local audio setup below. Long polling and Telegram webhooks are mutually exclusive; this project uses polling.

### Phone calls

Deploy the API behind a public HTTPS address, set `TWILIO_WEBHOOK_BASE_URL` to that public origin, configure `TWILIO_AUTH_TOKEN`, and enable `TWILIO_WEBHOOKS_ENABLED=true`. In Twilio, set the phone number's incoming-call webhook to `https://YOUR-HOST/voice/inbound` using HTTP POST. `VOICE_CALL_ANSWER_URL` can override the callback generated from the public origin; configure it as an absolute HTTPS URL, or leave it blank so the app uses `https://YOUR-HOST/voice/answer`. Callback signatures are validated when live webhooks are enabled.

Calls use `VOICE_CALL_LANGUAGE` (default `en`) and the matching `VOICE_CALL_LOCALE_<LANG>` / `VOICE_CALL_VOICE_<LANG>` settings. Twilio's current `<Say>` voice table does not list Amharic; so Amharic calls need a TwiML-compatible provider that supports both Amharic speech recognition and spoken output. This is based on the provider's currently published voice list, which may change. Verify the selected locale with a real call before demoing it. Callers can ask course questions or say they want a tutor; the latter creates a ticket visible in the helper inbox. Twilio webhook callbacks require a public HTTPS URL with a trusted certificate.

### Local voice models and answer providers

Browser speech recognition depends on the browser. Server-side Telegram voice notes and `POST /api/v1/voice/notes` need FFmpeg, the Python Vosk package, and a Vosk model configured as `VOICE_STT_MODEL_<LANG>`. Spoken read-back additionally needs Piper and `VOICE_TTS_MODEL_<LANG>` (plus its matching `.json` file). The default API image does not install these optional executables or download language models; provision them in the runtime image/environment first.

For course answers, `AI_PROVIDER=none` uses local retrieval and needs no external AI credentials. `AI_PROVIDER=local` needs an Ollama-compatible server and model. `AI_PROVIDER=cloud` needs `CLOUD_URL`, `CLOUD_API_KEY`, and `CLOUD_MODEL`; the learner must explicitly consent before the assistant sends the question and matched course section to the configured cloud provider. The optional model receives only above-threshold retrieved sections, must return source IDs plus exact evidence quotes, and is discarded when that evidence cannot be verified. Retrieval still decides when an answer is `not_found`, so model assistance cannot add citations to an unsupported question. SMS and voice call answers stay on local course retrieval.

### API

The FastAPI API is at `http://localhost:8081` in the compose setup. Open Swagger at `/docs`; `POST /api/v1/ask` answers questions, `GET /api/v1/content` reads indexed content, and the escalation/helper endpoints support tutor handoff. Protected helper operations require `X-Helper-Token`. The voice guide, capabilities, command, and voice-note endpoints are under `/api/v1/voice/`. The full contract is [openapi.yaml](./openapi.yaml).

## Project structure

```text
api/                 FastAPI service, retrieval, voice, and tutor flows
demo/                Blank-host page and sample course/job data
module/              Embeddable browser component and locale packs
savanna/             Learner-facing demo pages
tests/               JavaScript, pytest, Playwright, and axe coverage
scripts/             Build, content, OpenAPI, and validation utilities
docker-compose.yml   Local web and API stack
openapi.yaml         Checked-in API contract
```

## Embed the component

```html
<script src="/module/db-assistant.min.js" defer></script>
<db-assistant
  id="lesson-assistant"
  lang="en"
  api="https://api.example.org"
  content="/demo/data/content.json"
  theme="light">
</db-assistant>
```

The component uses `lang`, `api`, `content`, `theme`, and `debug` attributes. The blank-host example is available at [demo/blank.html](./demo/blank.html).

### Host-page event bridge

For a host-managed text answer, listen for `db-assistant:question`, set `event.detail.hostHandled = true` synchronously, and dispatch `db-assistant:answer` on the same `<db-assistant>` element. Preserve the supplied `requestId` when returning `{ requestId, answer, language, sources, answerStatus }`. The component validates the returned answer, keeps source links and answer status, and falls back to its existing server/retrieval flow if the host does not claim the question, times out, or returns an error.

## API

The complete contract is available in [openapi.yaml](./openapi.yaml) and in the local Swagger UI at `/docs`.

Key capabilities include:

- `POST /api/v1/ask` — grounded course and job questions.
- `GET/POST /api/v1/content` — indexed content management.
- `POST /api/v1/escalations` — consented tutor requests.
- `GET /api/v1/escalations/{ticket_id}` — learner ticket status.
- `POST /api/v1/escalations/{ticket_id}/close` and `DELETE /api/v1/escalations/{ticket_id}` — protected helper close/delete actions.
- `GET /api/v1/helper/...` — protected helper operations and metrics.
- `GET/POST /api/v1/voice/...` — localized voice guidance and offline actions.
- `POST /api/v1/voice/notes` — transcribe an Amharic voice note, answer from the course, and return an optional local read-back WAV.
- `POST /voice/inbound` and `/voice/answer` — provider-facing call webhooks that gather spoken questions, read answers back, and send “person” requests to the same tutor inbox.
- `/api/v1/sms/inbound` — JSON SMS simulator; `/sms/inbound` accepts the simulator format locally and signed Twilio form callbacks in live webhook mode.
- The Telegram polling bot accepts text and voice notes. `/lang am`, voice-note questions, `/person`, and tutor status all use the same course answer and handoff path as SMS.

Only answers supported by indexed evidence include source links. The API distinguishes evidenced answers, in-scope questions not found in the course, off-topic questions, and sensitive-topic refusals. Unsupported answers do not receive fabricated citations. The tested off-topic response explains the course boundary and offers an accessible **Talk to a person** action. `/api/v1/sms/inbound` remains an HTTP simulator; live carrier SMS is handled through a configured Twilio webhook.

## Development and testing

```bash
npm run build:module
npm run check:module-size
npm test
pytest -q
npm run test:e2e
npm run test:axe
```

The generated browser bundle is [module/db-assistant.min.js](./module/db-assistant.min.js). Test commands require the development dependencies listed in [package.json](./package.json) and [api/requirements-dev.txt](./api/requirements-dev.txt).

### Verification record — 2026-11-20

- `npm test`: 37 passed.
- `pytest -q`: 165 passed, with one Starlette/httpx deprecation warning.
- `npm run build:module` and `npm run check:module-size`: passed; the generated bundle is 24,840 bytes gzipped.
- `npm run test:e2e -- --workers=1`: 49 passed, including lesson-based suggestions, sourced English and Amharic answers, off-topic handoff, a widget tutor reply, and the separate HTTP SMS simulator flow.
- `npm run test:axe -- --workers=1`: 5 passed.
- `docker compose config --quiet`: passed. `git ls-files` found no tracked pytest caches or temporary outputs; ignored local caches were left untouched.
- The hosted JSON SMS simulator returned instructions for a synthetic `HELP` request. No SMS-created ticket, human reply, live Twilio webhook, or carrier SMS was tested.
- The co-designer reports checking English and Amharic lesson answers, the off-topic response, and opening the handoff form. No ticket or tutor reply was checked. Session date, original-session consent, tested revision, task independence, barriers, and accessibility conditions remain unknown or unverified. See [CONFORMANCE.md](./CONFORMANCE.md) and the [manual checklist](./tests/manual/accessibility-co-designer-checklist.md) for the record.

These results are local automated checks and reported observations, not a complete hosted helper rehearsal or accessibility sign-off.

## Accessibility and privacy

The assistant includes keyboard answer/source navigation, polite state announcements, explicit language direction metadata, descriptive source links, a text-first tutor handoff with visible Waiting/Answered/Closed status, visible transcripts and voice states, vibration as an optional supplemental cue, media caption validation, and an optional simple-language answer when supplied. The embeddable component also has an opt-in browser-only Voice guide: it is off by default, stores its local setting and speech controls, narrates focused controls, shows the same text in a caption bar, supports stop/pause/resume, and reports when the selected language has no device voice. Screen-reader users are advised to keep it off to avoid double speech. These are implementation behaviors covered by automated checks; NVDA, TalkBack, VoiceOver, braille-display, deaf co-designer, fluent-speaker, physical audio, and actual 200%/400% zoom verification remain open.

The co-designer accessibility gate is **NOT VERIFIED**. Keyboard-only, screen-reader, sound-off, and actual 200% zoom results remain unverified, and one co-designer report is not a WCAG conformance assessment. Fluent-speaker review of the non-English locales also remains outstanding. Real SMS and phone integrations require provider credentials and an externally reachable HTTPS deployment; no live provider callbacks have been tested. Review [CONFORMANCE.md](./CONFORMANCE.md) before making accessibility claims.

