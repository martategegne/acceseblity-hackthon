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
- Suggests up to three questions from the current lesson; selecting one fills the question field without sending it.
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

## API

The complete contract is available in [openapi.yaml](./openapi.yaml) and in the local Swagger UI at `/docs`.

Key capabilities include:

- `POST /api/v1/ask` — grounded course and job questions.
- `GET/POST /api/v1/content` — indexed content management.
- `POST /api/v1/escalations` — consented tutor requests.
- `GET /api/v1/escalations/{ticket_id}` — learner ticket status.
- `GET /api/v1/helper/...` — protected helper operations and metrics.
- `GET/POST /api/v1/voice/...` — localized voice guidance and offline actions.
- `/sms/inbound` — JSON SMS simulator for demo flows.

Only answers supported by indexed evidence include source links. The API distinguishes evidenced answers, in-scope questions not found in the course, off-topic questions, and sensitive-topic refusals. Unsupported answers do not receive fabricated citations. The tested off-topic response explains the course boundary and offers an accessible **Talk to a person** action. `/sms/inbound` is an HTTP simulator; it does not deliver carrier SMS.

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

- `npm.cmd test`: 37 passed.
- `pytest -q`: 165 passed, with one Starlette/httpx deprecation warning.
- `npm.cmd run build:module` and `npm.cmd run check:module-size`: passed; the generated bundle is 24,840 bytes gzipped.
- `npm.cmd run test:e2e -- --workers=1`: 49 passed, including lesson-based suggestions, sourced English and Amharic answers, off-topic handoff, a widget tutor reply, and the separate HTTP SMS simulator flow.
- `npm.cmd run test:axe -- --workers=1`: 5 passed.
- `docker compose config --quiet`: passed. `git ls-files` found no tracked pytest caches or temporary outputs; ignored local caches were left untouched.
- The hosted SMS simulator returned instructions for a synthetic `HELP` request. No SMS-created ticket, human reply, or carrier SMS was tested.
- The co-designer reports checking English and Amharic lesson answers, the off-topic response, and opening the handoff form. No ticket or tutor reply was checked. Session date, original-session consent, tested revision, task independence, barriers, and accessibility conditions remain unknown or unverified. See [CONFORMANCE.md](./CONFORMANCE.md) and the [manual checklist](./tests/manual/accessibility-co-designer-checklist.md) for the record.

These results are local automated checks and reported observations, not a complete hosted helper rehearsal or accessibility sign-off.

## Accessibility and privacy

The co-designer accessibility gate is **NOT VERIFIED**. Keyboard-only, screen-reader, sound-off, and actual 200% zoom results remain unverified, and one co-designer report is not a WCAG conformance assessment. Fluent-speaker review of the non-English locales also remains outstanding. The SMS endpoint is a simulator, not a real two-way SMS service. Review [CONFORMANCE.md](./CONFORMANCE.md) before making accessibility claims.

