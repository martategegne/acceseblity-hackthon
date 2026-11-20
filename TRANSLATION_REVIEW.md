# Track 3 Translation Review Inventory

This inventory identifies language coverage and fallback behavior for fluent-speaker review. It is not a translation-quality approval. Do not mark a language complete until a fluent speaker has reviewed the learner-facing text and recorded their review below.

## Coverage inventory

| Language | Widget strings (`module/i18n`) | Course content (`demo/data/content.json`) | Job content (`demo/data/jobs.json`) | API answer/refusal | Backend voice guide | Review status |
|---|---:|---:|---:|---:|---:|---|
| English (`en`) | 144/144 | 5/5 | 8/8 base listings | 3/3 | 5/5 steps | Needs review |
| Amharic (`am`) | 144/144 | 5/5 | 8/8 translated titles/details | 3/3 | 5/5 steps | Needs fluent-speaker review |
| Tigrinya (`ti`) | 143/143 | 5/5 | 8/8 translated | 2/2 | 5/5 steps | Needs fluent-speaker review |
| Afaan Oromo (`om`) | 143/143 | 5/5 | 8/8 translated | 2/2 | 5/5 steps | Needs fluent-speaker review |
| Somali (`so`) | 143/143 | 5/5 | 8/8 translated | 2/2 | 5/5 steps | Needs fluent-speaker review |
| Arabic (`ar`) | 61/144; 83 widget strings fall back to English | 0/5 translated; answers can fall back to English | 0/8 translated; content falls back to English | 2/2 | 5/5 steps | Explicitly incomplete; fluent-speaker translation/review pending |

Counts were read from the checked-in locale, course, and job data on 2026-11-20. They measure field coverage only; they do not establish translation accuracy, reading level, screen-reader pronunciation, or cultural suitability.

## Fallback and review notes

- The widget merges missing locale strings with English. Arabic therefore has 83 English fallbacks, including control labels, help, error, tutor, accommodation, and screen-sharing text. An explicit incomplete-translation notice is shown to Arabic learners; English fallback text is not claimed as Arabic translation.
- Course content has five localized sections for English, Amharic, Tigrinya, Afaan Oromo, and Somali. It has no Arabic course text; search can use English text for Arabic questions, so those answers must not be described as Arabic course translations.
- The jobs file has English base text and translated title/details for Amharic, Tigrinya, Afaan Oromo, and Somali. Arabic job titles/details remain unavailable and may appear in English with the incomplete-locale notice.
- The API localizes the not-found answer and medical/legal/immigration refusal in all six languages. Amharic voice-command feedback and selected validation errors are read from the locale JSON. Other API validation/error messages and the helper page are not fully localized and need separate review if those flows are claimed as multilingual.
- The off-topic response is present in English and Amharic only. Other languages currently receive the English fallback. The Amharic response is not fluent-speaker reviewed; do not describe it as reviewed or approved.
- The backend voice guide has five steps for all six languages. The installed speech voices/models are device and operator dependent; text coverage does not prove speech support.

## Fluent-speaker sign-off

For each language, review the widget controls and errors, course answers and source labels, job titles/details, API responses, tutor messages, voice instructions, and right-to-left or screen-reader behavior where applicable.

| Language | Fluent reviewer (consented name/identifier) | Review date | Areas reviewed | Corrections applied | Approved for claim? |
|---|---|---|---|---|---|
| English |  |  |  |  |  |
| Amharic |  |  |  |  |  |
| Tigrinya |  |  |  |  |  |
| Afaan Oromo |  |  |  |  |  |
| Somali |  |  |  |  |  |
| Arabic |  |  |  |  |  |
