# Track 3 Translation Review Inventory

This inventory identifies language coverage and fallback behavior for fluent-speaker review. It is not a translation-quality approval. Do not mark a language complete until a fluent speaker has reviewed the learner-facing text and recorded their review below.

## Coverage inventory

| Language | Widget strings (`module/i18n`) | Course content (`demo/data/content.json`) | Job content (`demo/data/jobs.json`) | API answer/refusal | Core SMS/API messages | Backend voice guide | Review status |
|---|---:|---:|---:|---:|---:|---:|---|
| English (`en`) | 144/144 | 5/5 | 8/8 base listings | 3/3 | 38/38 | 5/5 steps | Needs review |
| Amharic (`am`) | 144/144 | 5/5 | 8/8 translated titles/details | 3/3 | 38/38 | 5/5 steps | Needs fluent-speaker review |
| Tigrinya (`ti`) | 144/144 | 5/5 | 8/8 translated | 3/3 | 38/38 | 5/5 steps | Draft translations; needs fluent-speaker review |
| Afaan Oromo (`om`) | 144/144 | 5/5 | 8/8 translated | 3/3 | 38/38 | 5/5 steps | Draft translations; needs fluent-speaker review |
| Somali (`so`) | 144/144 | 5/5 | 8/8 translated | 3/3 | 38/38 | 5/5 steps | Draft translations; needs fluent-speaker review |
| Arabic (`ar`) | 61/144; 83 widget strings fall back to English | 0/5 translated; answers can fall back to English | 0/8 translated; content falls back to English | 2/2 | 0/38; English fallback | 5/5 steps | Explicitly incomplete; fluent-speaker translation/review pending |

Counts were read from the checked-in locale, course, and job data on 2026-11-20. They measure field coverage only; they do not establish translation accuracy, reading level, screen-reader pronunciation, or cultural suitability.

## Fallback and review notes

- The widget merges missing locale strings with English. Arabic therefore has 83 English fallbacks, including control labels, help, error, tutor, accommodation, and screen-sharing text. An explicit incomplete-translation notice is shown to Arabic learners; English fallback text is not claimed as Arabic translation.
- Course content has five localized sections for English, Amharic, Tigrinya, Afaan Oromo, and Somali. It has no Arabic course text; search can use English text for Arabic questions, so those answers must not be described as Arabic course translations.
- The jobs file has English base text and translated title/details for Amharic, Tigrinya, Afaan Oromo, and Somali. Arabic job titles/details remain unavailable and may appear in English with the incomplete-locale notice.
- The API loads response strings from the matching `module/i18n/<language>.json` locale pack. Not-found answers, off-topic responses, sensitive-topic refusals, learner question/tutor validation errors, and SMS question/help/handoff/status messages have entries for all five Track 3 languages. Core SMS command words (`LANG`, `HELP`, `PERSON`, `STATUS`, and `ALERT`) remain stable tokens; explanatory text is localized. Other API validation errors and the helper page still contain English-only copy, so do not claim every backend/helper message is localized.
- The course-only off-topic response and “talk to a person” action are present for English, Amharic, Tigrinya, Afaan Oromo, and Somali. Tigrinya, Afaan Oromo, and Somali wording is draft copy without fluent-speaker approval. There is no fluent-speaker sign-off recorded for any of the five languages.
- SMS defaults to English, recognizes Amharic script when no preference is saved, and supports an explicit per-sender `LANG` choice for all five Track 3 languages. Since Tigrinya shares the Ethiopic script with Amharic, and Afaan Oromo/Somali use Latin script, select those languages explicitly. Only a one-way hash of the sender number is stored for this preference.
- Arabic remains explicitly incomplete and its off-topic copy falls back to English. Arabic stays outside the five-language completion claim. Its existing not-found and safety-refusal strings remain available; that does not mean Arabic is a completed translation.
- The backend voice guide has five steps for all six languages. The installed speech voices/models are device and operator dependent; text coverage does not prove speech support.

## Fluent-speaker sign-off

For each language, review widget controls and errors, course answers and source labels, job titles/details, off-topic handoff wording, SMS command/status messages, API responses, tutor messages, voice instructions, and screen-reader pronunciation/announcements. Record human, device, and assistive-technology results separately; automated tests verify application behavior and key coverage, not translation quality or accessibility conformance.

| Language | Fluent reviewer (consented name/identifier) | Review date | Areas reviewed | Corrections applied | Approved for claim? |
|---|---|---|---|---|---|
| English |  |  |  |  |  |
| Amharic |  |  |  |  |  |
| Tigrinya |  |  |  |  |  |
| Afaan Oromo |  |  |  |  |  |
| Somali |  |  |  |  |  |
| Arabic |  |  |  |  |  |
