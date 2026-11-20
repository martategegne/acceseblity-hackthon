/**
 * tests/search.test.js
 * Unit tests for module/search.js using node:test and node:assert/strict.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { search, THRESHOLD, tokenize, stripPunctuation, scoreSection } from "../module/search.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load the sections from demo/data/content.json
const contentPath = path.resolve(__dirname, "../demo/data/content.json");
const sections = JSON.parse(fs.readFileSync(contentPath, "utf-8"));
const jobsPath = path.resolve(__dirname, "../demo/data/jobs.json");
const jobs = JSON.parse(fs.readFileSync(jobsPath, "utf-8")).map((job) => ({
  ...job,
  type: "job",
  text: {
    en: [job.description, job.remote ? "Remote work telecommute" : "On site work", job.location, ...job.accommodations].join(". "),
    am: [job.description, job.remote ? "Remote work telecommute" : "On site work", job.location, ...job.accommodations].join(". ")
  }
}));

describe("Search Module Constants & Tokenization", () => {
  it("exports a THRESHOLD constant defaulting to 0.25", () => {
    assert.strictEqual(THRESHOLD, 0.25);
  });

  it("strips Ethiopic punctuation correctly", () => {
    const raw = "ሰላም፡ ዓለም። ይህ፣ ጥያቄ፤ ነው፥";
    const stripped = stripPunctuation(raw);
    assert.strictEqual(stripped, "ሰላም ዓለም ይህ ጥያቄ ነው");
  });

  it("tokenises English text by words and removes stop words", () => {
    const text = "What is the future of artificial intelligence in work?";
    const tokens = tokenize(text, "en");
    assert.ok(tokens.includes("future"));
    assert.ok(tokens.includes("artificial"));
    assert.ok(tokens.includes("intelligence"));
    assert.ok(tokens.includes("work"));
    assert.ok(!tokens.includes("what"));
    assert.ok(!tokens.includes("is"));
    assert.ok(!tokens.includes("the"));
    assert.ok(!tokens.includes("of"));
    assert.ok(!tokens.includes("in"));
  });

  it("tokenises Amharic text into character 2-grams and 3-grams", () => {
    const text = "ሥራ";
    const tokens = tokenize(text, "am");
    assert.ok(tokens.includes("ሥራ")); // length 2 -> 2-gram

    const longerText = "ወደፊት";
    const longerTokens = tokenize(longerText, "am");
    // 2-grams: ወደ, ደፊ, ፊት
    assert.ok(longerTokens.includes("ወደ"));
    assert.ok(longerTokens.includes("ደፊ"));
    assert.ok(longerTokens.includes("ፊት"));
    // 3-grams: ወደፊ, ደፊት
    assert.ok(longerTokens.includes("ወደፊ"));
    assert.ok(longerTokens.includes("ደፊት"));
  });

  it("gives higher weight to title matches than body-only matches", () => {
    const dummySection = {
      id: "test-sec",
      title: "Artificial Intelligence Special Title",
      text: {
        en: "Regular administrative office routine data spreadsheets.",
        am: ""
      }
    };
    const titleMatchTokens = ["artificial", "intelligence"];
    const bodyMatchTokens = ["administrative", "spreadsheets"];

    const titleScore = scoreSection(titleMatchTokens, dummySection, "en");
    const bodyScore = scoreSection(bodyMatchTokens, dummySection, "en");

    assert.ok(titleScore > bodyScore, `Title score (${titleScore}) should exceed body score (${bodyScore})`);
  });
});

describe("English Search Tests", () => {
  const englishTestCases = [
    {
      q: "What is shaping the future of virtual assistant work?",
      expectedId: "what-is-shaping-the-future-of-va-work",
      desc: "Section 1 heading match"
    },
    {
      q: "How is technology changing remote employment and collaboration tools?",
      expectedId: "what-is-shaping-the-future-of-va-work",
      desc: "Section 1 body concepts match"
    },
    {
      q: "Will artificial intelligence tools replace human assistants?",
      expectedId: "artificial-intelligence-and-the-future-of-va-work",
      desc: "Section 2 AI heading and replacement match"
    },
    {
      q: "Can AI automate drafting routine emails and transcribing audio recordings?",
      expectedId: "artificial-intelligence-and-the-future-of-va-work",
      desc: "Section 2 repetitive tasks match"
    },
    {
      q: "What qualities do clients value most in virtual assistants?",
      expectedId: "what-clients-are-likely-to-value-more-and-more",
      desc: "Section 3 client values match"
    },
    {
      q: "Why is proactive problem solving and reliability important for clients?",
      expectedId: "what-clients-are-likely-to-value-more-and-more",
      desc: "Section 3 proactive problem solving match"
    },
    {
      q: "What should aspiring virtual assistants do to succeed?",
      expectedId: "what-this-means-for-aspiring-virtual-assistants",
      desc: "Section 4 aspiring assistants match"
    },
    {
      q: "How can beginner VAs build a portfolio and learn asynchronous communication?",
      expectedId: "what-this-means-for-aspiring-virtual-assistants",
      desc: "Section 4 portfolio and learning match"
    },
    {
      q: "Is the career future promising for virtual assistants?",
      expectedId: "so-is-the-future-of-va-promising",
      desc: "Section 5 promising future match"
    },
    {
      q: "Why is the outlook bright for skilled remote talent?",
      expectedId: "so-is-the-future-of-va-promising",
      desc: "Section 5 bright outlook match"
    }
  ];

  for (const tc of englishTestCases) {
    it(`matches English question: "${tc.q}" (${tc.desc})`, () => {
      const res = search(tc.q, sections, "en");
      assert.ok(res.best !== null, `Expected a match for "${tc.q}", got null`);
      assert.strictEqual(res.best.section.id, tc.expectedId);
      assert.ok(res.best.score >= THRESHOLD);
      assert.ok(res.best.score <= 1.0);
      assert.ok(typeof res.best.section.url === "string" && res.best.section.url.length > 0, "best section must include its source link url");
      assert.ok(Boolean(res.best.section.title), "best section must include its title");
    });
  }

  const englishNoMatchCases = [
    "How do I bake a chocolate cake at home?",
    "What is the capital city of Australia?",
    "Where can I buy train tickets for Madrid?"
  ];

  for (const q of englishNoMatchCases) {
    it(`returns null best match for unrelated English question: "${q}"`, () => {
      const res = search(q, sections, "en");
      assert.strictEqual(res.best, null, `Expected null best for "${q}", got score: ${res.others[0]?.score}`);
    });
  }
});

describe("Amharic Search Tests", () => {
  const amharicTestCases = [
    {
      q: "የቨርቹዋል አሲስታንት ሥራን ወደፊት ምን እየቀየረው ነው?",
      expectedId: "what-is-shaping-the-future-of-va-work",
      desc: "Amharic Section 1 heading match"
    },
    {
      q: "ድርጅቶች ከሩቅ ሆነው ከሚሠሩ ሠራተኞች ጋር በኮምፒውተር እንዴት ይሠራሉ?",
      expectedId: "what-is-shaping-the-future-of-va-work",
      desc: "Amharic Section 1 remote collaboration match"
    },
    {
      q: "አርቴፊሻል ኢንተለጀንስ የሰዎችን ሥራ ይተካል?",
      expectedId: "artificial-intelligence-and-the-future-of-va-work",
      desc: "Amharic Section 2 AI replacement match"
    },
    {
      q: "ኮምፒውተር የትኞቹን አድካሚ የቢሮ ሥራዎች ያከናውናል?",
      expectedId: "artificial-intelligence-and-the-future-of-va-work",
      desc: "Amharic Section 2 repetitive tasks match"
    },
    {
      q: "ቀጣሪዎች ወደፊት ምን ዓይነት ችሎታዎችን ይፈልጋሉ?",
      expectedId: "what-clients-are-likely-to-value-more-and-more",
      desc: "Amharic Section 3 client value match"
    },
    {
      q: "ቀጣሪዎች የታማኝነት እና ሚስጥር መጠበቅን ይፈልጋሉ?",
      expectedId: "what-clients-are-likely-to-value-more-and-more",
      desc: "Amharic Section 3 trust and reliability match"
    },
    {
      q: "ለአዳዲስ ቨርቹዋል አሲስታንቶች ምን ዓይነት ምክር አለ?",
      expectedId: "what-this-means-for-aspiring-virtual-assistants",
      desc: "Amharic Section 4 advice for beginners match"
    },
    {
      q: "ጀማሪዎች የሥራ ናሙና ማዘጋጀት አለባቸው?",
      expectedId: "what-this-means-for-aspiring-virtual-assistants",
      desc: "Amharic Section 4 work samples match"
    },
    {
      q: "የቨርቹዋል አሲስታንት ሥራ የወደፊት ተስፋው ጥሩ ነው?",
      expectedId: "so-is-the-future-of-va-promising",
      desc: "Amharic Section 5 promising future match"
    },
    {
      q: "ቴክኖሎጂን እንደ ረዳት ለሚጠቀሙ ሠራተኞች ተስፋ አለ?",
      expectedId: "so-is-the-future-of-va-promising",
      desc: "Amharic Section 5 technology ally match"
    }
  ];

  for (const tc of amharicTestCases) {
    it(`matches Amharic question: "${tc.q}" (${tc.desc})`, () => {
      const res = search(tc.q, sections, "am");
      assert.ok(res.best !== null, `Expected a match for "${tc.q}", got null`);
      assert.strictEqual(res.best.section.id, tc.expectedId);
      assert.ok(res.best.score >= THRESHOLD);
      assert.ok(res.best.score <= 1.0);
      assert.ok(typeof res.best.section.url === "string" && res.best.section.url.length > 0, "best section must include its source link url");
      assert.ok(Boolean(res.best.section.title), "best section must include its title");
    });
  }

  const amharicNoMatchCases = [
    "የእንጀራ አገጋገር እና የዶሮ ወጥ አሰራር እንዴት ነው?",
    "የአዲስ አበባ የአየር ሁኔታ ዛሬ ምን ይመስላል?",
    "የእግር ኳስ ጨዋታ ውጤት ስንት ለስንት ሆነ?"
  ];

  for (const q of amharicNoMatchCases) {
    it(`returns null best match for unrelated Amharic question: "${q}"`, () => {
      const res = search(q, sections, "am");
      assert.strictEqual(res.best, null, `Expected null best for "${q}", got score: ${res.others[0]?.score}`);
    });
  }
});

describe("Job source search tests", () => {
  it("finds test jobs offering an interpreter", () => {
    const result = search("Which jobs have an interpreter?", jobs, "en");
    const matches = [result.best, ...result.others]
      .filter((match) => match && match.score >= THRESHOLD)
      .map((match) => match.section.id);
    assert.ok(matches.includes("test-inbox-support"));
    assert.ok(matches.includes("test-calendar-coordinator"));
    assert.ok(matches.includes("test-project-notes"));
    assert.ok(matches.every((id) => jobs.some((job) => job.id === id && job.url)));
  });

  it("finds remote jobs and returns their source URLs", () => {
    const result = search("remote jobs", jobs, "en");
    const matches = [result.best, ...result.others].filter((match) => match && match.score >= THRESHOLD);
    assert.ok(matches.length > 0);
    assert.ok(matches.every(({ section }) => section.remote && section.url));
  });
});

describe("Additional language packs and retrieval", () => {
  const languages = ["am", "ti", "om", "so"];
  const englishStrings = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../module/i18n/en.json"), "utf-8")).strings;
  const declaredFallbackKeys = [
    "answerCopied",
    "copyAnswer",
    "copyAnswerFailed",
    "exploreDescription",
    "exploreEmpty",
    "exploreError",
    "exploreFallback",
    "exploreHeading",
    "exploreInserted",
    "exploreLoading",
    "exploreQuestionTemplate",
    "exploreRetry"
  ];

  for (const language of languages) {
    it(`${language} locale has localized course content and only declared UI fallbacks`, () => {
      const pack = JSON.parse(fs.readFileSync(path.resolve(__dirname, `../module/i18n/${language}.json`), "utf-8"));
      const missingStringKeys = Object.keys(englishStrings).filter((key) => !pack.strings[key]);
      assert.equal(pack.lang, language);
      assert.equal(pack.dir, "ltr");
      assert.ok(missingStringKeys.every((key) => declaredFallbackKeys.includes(key)));
      if (language === "am") assert.deepEqual(missingStringKeys, []);
      assert.deepEqual(
        Object.keys(pack.strings).sort(),
        Object.keys(englishStrings).filter((key) => !missingStringKeys.includes(key)).sort()
      );
      assert.ok(Object.values(pack.strings).every((value) => typeof value === "string" && value.trim()));
      for (const section of sections) {
        assert.ok(section.titles[language], `${section.id} needs a ${language} title`);
        assert.ok(section.text[language], `${section.id} needs ${language} course text`);
        const result = search(section.titles[language], sections, language);
        assert.equal(result.best?.section.id, section.id);
        assert.equal(result.best?.section.url, section.url);
      }
    });
  }
});
