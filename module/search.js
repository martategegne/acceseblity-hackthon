/**
 * module/search.js
 * Pure-JS search function (no AI, no network) for lesson content.
 */

export const THRESHOLD = 0.25;

export const STOP_WORDS = new Set([
  "a", "about", "above", "after", "again", "against", "all", "am", "an", "and",
  "any", "are", "aren't", "as", "at", "be", "because", "been", "before", "being",
  "below", "between", "both", "but", "by", "can", "cannot", "could", "did", "do",
  "does", "doing", "down", "during", "each", "few", "for", "from", "further",
  "had", "has", "have", "having", "he", "her", "here", "hers", "herself", "him",
  "himself", "his", "how", "i", "if", "in", "into", "is", "isn't", "it", "its",
  "itself", "let's", "me", "more", "most", "my", "myself", "no", "nor", "not",
  "of", "off", "on", "once", "only", "or", "other", "ought", "our", "ours",
  "ourselves", "out", "over", "own", "same", "she", "should", "so", "some",
  "such", "than", "that", "the", "their", "theirs", "them", "themselves", "then",
  "there", "these", "they", "this", "those", "through", "to", "too", "under",
  "until", "up", "very", "was", "wasn't", "we", "were", "weren't", "what",
  "when", "where", "which", "while", "who", "whom", "why", "will", "with",
  "won't", "would", "you", "your", "yours", "yourself", "yourselves"
]);

export const AMHARIC_TITLES = {
  "what-is-shaping-the-future-of-va-work": "የቨርቹዋል አሲስታንት ሥራን ወደፊት ምን እየቀየረው ነው",
  "artificial-intelligence-and-the-future-of-va-work": "አርቴፊሻል ኢንተለጀንስ እና የቨርቹዋል አሲስታንት ሥራ ወደፊት",
  "what-clients-are-likely-to-value-more-and-more": "ቀጣሪዎች ወደፊት ይበልጥ ትኩረት የሚሰጡባቸው ነገሮች",
  "what-this-means-for-aspiring-virtual-assistants": "ይህ ለአዳዲስ ቨርቹዋል አሲስታንቶች ምን ትርጉም አለው",
  "so-is-the-future-of-va-promising": "ታዲያ የቨርቹዋል አሲስታንት ሥራ የወደፊት ተስፋው ጥሩ ነው"
};

const ETHIOPIC_PUNCT_REGEX = /[፡።፣፤፥፦፧፨]/g;
const GENERAL_PUNCT_REGEX = /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/g;
const ETHIOPIC_CHAR_REGEX = /[\u1200-\u137F]/;

/**
 * Strips Ethiopic and standard punctuation from text.
 * @param {string} text
 * @returns {string}
 */
export function stripPunctuation(text) {
  if (!text) return "";
  return text
    .replace(ETHIOPIC_PUNCT_REGEX, " ")
    .replace(/\[CHECK\]/gi, " ")
    .replace(GENERAL_PUNCT_REGEX, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Tokenises text according to the language:
 * - English: lowercased words with stop-words removed.
 * - Amharic/Tigrinya: character 2-grams and 3-grams, Ethiopic punctuation stripped.
 *
 * @param {string} text
 * @param {string} lang
 * @returns {string[]}
 */
export function tokenize(text, lang = "en") {
  if (!text || typeof text !== "string") return [];
  const cleaned = stripPunctuation(text);

  if (lang === "am" || lang === "ti") {
    const words = cleaned.split(/\s+/).filter(Boolean);
    const tokens = [];

    for (const word of words) {
      if (ETHIOPIC_CHAR_REGEX.test(word)) {
        const len = word.length;
        // 2-grams
        for (let i = 0; i <= len - 2; i++) {
          tokens.push(word.slice(i, i + 2));
        }
        // 3-grams
        for (let i = 0; i <= len - 3; i++) {
          tokens.push(word.slice(i, i + 3));
        }
      } else {
        // Non-Ethiopic words/acronyms (e.g. "VA", "AI")
        const lower = word.toLowerCase();
        if (!STOP_WORDS.has(lower) && lower.length > 1) {
          tokens.push(lower);
        }
      }
    }
    return tokens;
  }

  // Keep non-English Latin/Arabic tokens intact instead of applying English stop words.
  const words = cleaned.toLowerCase().split(/\s+/).filter(Boolean);
  if (lang !== "en") return words.filter((word) => word.length > 1);
  const filtered = words.filter((w) => !STOP_WORDS.has(w) && w.length > 1);
  return filtered.length > 0 ? filtered : words;
}

/**
 * Scores section match based on weighted token overlap (title matches weigh more).
 * Returns normalised score between 0.0 and 1.0.
 *
 * @param {string[]} queryTokens
 * @param {object} section
 * @param {string} lang
 * @returns {number}
 */
export function scoreSection(queryTokens, section, lang = "en") {
  if (!queryTokens || queryTokens.length === 0 || !section) return 0;

  const translation = section.translations?.[lang];
  const titleText = section.titles?.[lang]
    || translation?.title
    || (lang === "am" && section.id && AMHARIC_TITLES[section.id])
    || (lang === "en" ? (typeof section.title === "object" ? section.title?.en : section.title) : "")
    || (["ti", "om", "so"].includes(lang) ? "" : (typeof section.title === "object" ? section.title?.en : section.title))
    || "";

  let bodyText = "";
  if (section.text) {
    bodyText = typeof section.text === "string"
      ? section.text
      : (section.text[lang] || (["ti", "om", "so"].includes(lang) ? "" : section.text.en) || "");
  }

  const titleTokens = new Set(tokenize(titleText, lang));
  const bodyTokens = new Set(tokenize(bodyText, lang));

  const uniqueQ = Array.from(new Set(queryTokens));
  let matchWeight = 0;

  for (const token of uniqueQ) {
    const inTitle = titleTokens.has(token);
    const inBody = bodyTokens.has(token);

    if (inTitle && inBody) {
      matchWeight += 1.0;
    } else if (inTitle) {
      matchWeight += 0.85;
    } else if (inBody) {
      matchWeight += 0.60;
    }
  }

  const normalized = matchWeight / uniqueQ.length;
  return Math.min(1.0, Math.max(0.0, Number(normalized.toFixed(4))));
}

/**
 * Searches sections for the given question and language.
 *
 * @param {string} question
 * @param {Array<object>} sections
 * @param {string} lang
 * @returns {{ best: { section: object, score: number } | null, others: Array<{ section: object, score: number }> }}
 */
export function search(question, sections = [], lang = "en") {
  if (!question || !Array.isArray(sections) || sections.length === 0) {
    return { best: null, others: [] };
  }

  const qTokens = tokenize(question, lang);
  if (qTokens.length === 0) {
    const allZero = sections.map((sec) => ({ section: sec, score: 0 }));
    return { best: null, others: allZero };
  }

  const scored = sections.map((sec) => {
    const score = scoreSection(qTokens, sec, lang);
    return { section: sec, score };
  });

  scored.sort((a, b) => b.score - a.score);

  const top = scored[0];
  if (top && top.score >= THRESHOLD) {
    return {
      best: { section: top.section, score: top.score },
      others: scored.slice(1)
    };
  }

  return {
    best: null,
    others: scored
  };
}

export function hasCourseContext(searchResult) {
  return Boolean(searchResult?.best?.score > 0)
    || Boolean(searchResult?.others?.some((match) => match.score > 0));
}

if (typeof globalThis !== "undefined") {
  globalThis.DbSearch = { search, hasCourseContext, THRESHOLD, tokenize, stripPunctuation, scoreSection, STOP_WORDS, AMHARIC_TITLES };
}

export default search;
