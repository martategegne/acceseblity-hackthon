/* <db-assistant> — isolated, framework-free learning assistant. */
(() => {
  const scriptUrl = document.currentScript?.src || new URL("./db-assistant.js", document.baseURI).href;
  const i18nBase = new URL("./i18n/", scriptUrl);

  function normalizeEthiopianPhone(value) {
    const compact = String(value || "").replace(/[\s()-]/g, "");
    const national = compact.replace(/^\+251/, "0");
    if (/^09\d{8}$/.test(national)) return `+251${national.slice(1)}`;
    if (/^07\d{8}$/.test(national)) return `+251${national.slice(1)}`;
    return "";
  }

  const en = { lang: "en", dir: "ltr", strings: {} };
  const am = { lang: "am", dir: "ltr", strings: {} };
  const bundled = {};

  const AMHARIC_TITLES = {
    "what-is-shaping-the-future-of-va-work": "የቨርቹዋል አሲስታንት ሥራን ወደፊት ምን እየቀየረው ነው",
    "artificial-intelligence-and-the-future-of-va-work": "አርቴፊሻል ኢንተለጀንስ እና የቨርቹዋል አሲስታንት ሥራ ወደፊት",
    "what-clients-are-likely-to-value-more-and-more": "ቀጣሪዎች ወደፊት ይበልጥ ትኩረት የሚሰጡባቸው ነገሮች",
    "what-this-means-for-aspiring-virtual-assistants": "ይህ ለአዳዲስ ቨርቹዋል አሲስታንቶች ምን ትርጉም አለው",
    "so-is-the-future-of-va-promising": "ታዲያ የቨርቹዋል አሲስታንት ሥራ የወደፊት ተስፋው ጥሩ ነው"
  };

  function getFirstSentences(text, maxSentences = 3) {
    if (!text || typeof text !== "string") return "";
    const matches = text.match(/[^.!?።]+[.!?።]*/g);
    if (!matches || matches.length === 0) return text.trim();
    const clean = matches.map((s) => s.trim()).filter(Boolean);
    return clean.slice(0, maxSentences).join(" ");
  }

  function isDebugMode() {
    try {
      const search = window.location?.search || "";
      return new URLSearchParams(search).get("debug") === "1";
    } catch {
      return false;
    }
  }

  class DbAssistant extends HTMLElement {
    static get observedAttributes() {
      return ["lang", "api", "content", "theme", "debug", "contrast", "text-scale"];
    }

    constructor() {
      super();
      this.attachShadow({ mode: "open" });
      this._built = false;
      this._loadToken = 0;
      this._pack = null;
      this._errorKey = "";
      this._messages = [];
      this._studyPack = [];
      this._sections = [];
      this._lessonContentStatus = "loading";
      this._englishStrings = {};
      this._jobs = [];
      this._searchModule = null;
      this._recognition = null;
      this._voiceMode = "";
      this._voiceCommandRecording = false;
      this._voiceCommandDraft = null;
      this._voiceActionQueue = [];
      this._voiceBlob = null;
      this._voiceObjectUrl = "";
      this._voiceCaptionsUrl = "";
      this._ignoreRecognitionEnd = false;
      this._voiceGeneration = 0;
      this._screenStream = null;
      this._screenPeer = null;
      this._screenTicketId = "";
      this._screenShareGeneration = 0;
      this._screenShareStarting = false;
      this._lastPageFocusedElement = null;
      this._learnerTickets = [];
      this._pendingTutorTicketId = "";
      this._cloudConsentRequired = false;
      this._assistantConfigToken = 0;
      this._submittingQuestion = false;
      this._retryingQuestionIds = new Set();
      this._flushingQuestionQueue = false;
      this._hostAnswerWaiters = new Map();
      this._hostAnswerHandler = (event) => this._handleHostAnswer(event);
      this._textScale = 1;
      this._contrastMode = false;
      this._accessibilityReady = false;
      this._focusBeforeOpen = null;
      this._announcementToken = 0;
      this._speechStatusNode = null;
      this._rememberPageFocus = (event) => {
        const target = event.composedPath?.()[0] || event.target;
        if (!this.shadowRoot?.contains(target)) this._lastPageFocusedElement = target;
      };
    }

    connectedCallback() {
      document.addEventListener("focusin", this._rememberPageFocus, true);
      this.addEventListener("db-assistant:answer", this._hostAnswerHandler);
      if (this._onlineHandler) window.addEventListener("online", this._onlineHandler);
      if (this._escapeHandler) document.addEventListener("keydown", this._escapeHandler);
      if (this._built) return;
      this._built = true;
      this._storageKey = `db-assistant:${location.pathname}:${this.id || "default"}`;
      this._queueKey = `${this._storageKey}:offline-questions`;
      this._studyPackKey = `${this._storageKey}:study-pack`;
      this._accessibilityKey = `${this._storageKey}:accessibility`;
      this._restoreAccessibilityPreferences();
      try { this._studyPack = JSON.parse(localStorage.getItem(this._studyPackKey) || "[]"); } catch { this._studyPack = []; }
      if (!Array.isArray(this._studyPack)) this._studyPack = [];
      this._pendingTutorKey = `${this._storageKey}:pending-tutor-ticket`;
      this._voiceDraftKey = `${this._storageKey}:voice-command-draft`;
      this._voiceQueueKey = `${this._storageKey}:voice-command-queue`;
      this._restoreVoiceCommandState();
      this._restore();
      this._render();
      this._restorePendingTutorTicket();
      this._restoreLearnerTickets();
      this._bind();
      this._renderQuestionQueue();
      this._loadAssistantConfig();
      this._registerServiceWorker();
      this._loadI18n();
      this._initSearchAndContent();
      if (navigator.onLine) { this._flushQuestionQueue(); this._flushVoiceActionQueue(); }
    }

    disconnectedCallback() {
      document.removeEventListener("focusin", this._rememberPageFocus, true);
      this.removeEventListener("db-assistant:answer", this._hostAnswerHandler);
      document.removeEventListener("keydown", this._escapeHandler);
      document.removeEventListener("keydown", this._shortcutHandler);
      this._stopScreenShare(false);
      try { this._recognition?.stop(); } catch { /* Recognition may already be closed. */ }
      try { if (this._mediaRecorder?.state === "recording") this._mediaRecorder.stop(); } catch { /* Recorder may already be closed. */ }
      for (const track of this._mediaStream?.getTracks?.() || []) track.stop();
      this._mediaStream = null;
      window.speechSynthesis?.cancel?.();
      window.removeEventListener("online", this._onlineHandler);
      if (this._voiceObjectUrl) URL.revokeObjectURL(this._voiceObjectUrl);
      if (this._voiceCaptionsUrl) URL.revokeObjectURL(this._voiceCaptionsUrl);
      for (const waiter of this._hostAnswerWaiters.values()) {
        clearTimeout(waiter.timer);
        waiter.resolve(null);
      }
      this._hostAnswerWaiters.clear();
      this._speechStatusNode = null;
    }

    attributeChangedCallback(name, oldValue, newValue) {
      if (!this._built || oldValue === newValue) return;
      if (name === "lang") this._loadI18n();
      if (name === "theme") this._applyTheme();
      if (name === "content") this._loadContent();
      if (name === "api") {
        this._els.cloudConsent.checked = false;
        this._loadAssistantConfig();
      }
      if (name === "contrast") {
        this._contrastMode = newValue === "high";
        this._applyAccessibilityPreferences(false);
      }
      if (name === "text-scale") {
        this._textScale = this._normalizeTextScale(newValue);
        this._applyAccessibilityPreferences(false);
      }
    }

    async _initSearchAndContent() {
      try {
        if (typeof globalThis !== "undefined" && globalThis.DbSearch?.search) {
          this._searchModule = globalThis.DbSearch;
        } else {
          const searchUrl = new URL("./search.js", scriptUrl).href;
          this._searchModule = await import(searchUrl);
        }
      } catch (err) {
        console.warn("Could not load search module:", err);
      }
      await this._loadContent();
    }

    _registerServiceWorker() {
      if (!window.isSecureContext || !navigator.serviceWorker) return;
      const appRoot = new URL("../", scriptUrl);
      const workerUrl = new URL("sw.js", appRoot);
      const safeScope = appRoot.pathname;
      navigator.serviceWorker.register(workerUrl.href, { scope: safeScope }).catch(() => {});
    }

    async _loadContent() {
      const attr = this.getAttribute("content");
      const url = attr
        ? new URL(attr, document.baseURI).href
        : new URL("../demo/data/content.json", scriptUrl).href;
      this._lessonContentStatus = "loading";
      this._renderLessonSuggestions();
      let contentLoaded = false;
      try {
        const resp = await fetch(url);
        if (!resp.ok) throw new Error(`Lesson content returned HTTP ${resp.status}`);
        const sections = await resp.json();
        this._sections = Array.isArray(sections) ? sections.map((section) => ({ ...section, type: section.type || "lesson" })) : [];
        contentLoaded = true;
        try { localStorage.setItem(`${this._storageKey}:content`, JSON.stringify(this._sections)); } catch { /* Storage may be disabled or full. */ }
      } catch (err) {
        console.warn("Could not load content sections from", url, err);
        try {
          const cachedContent = localStorage.getItem(`${this._storageKey}:content`);
          if (cachedContent) {
            const cached = JSON.parse(cachedContent);
            if (Array.isArray(cached)) {
              this._sections = cached;
              contentLoaded = true;
            }
          }
        } catch { /* Keep an empty source when local storage is unavailable. */ }
      }
      try {
        const response = await fetch(new URL("../demo/data/jobs.json", scriptUrl));
        if (!response.ok) throw new Error("Jobs source unavailable");
        this._jobs = await response.json();
        try { localStorage.setItem(`${this._storageKey}:jobs`, JSON.stringify(this._jobs)); } catch { /* Storage may be disabled or full. */ }
        this._sections = [...(Array.isArray(this._sections) ? this._sections.filter((item) => item.type !== "job") : []), ...this._jobSections()];
        this._populateAccommodationChoices();
      } catch (err) {
        console.warn("Could not load jobs source", err);
        try {
          const cachedJobs = JSON.parse(localStorage.getItem(`${this._storageKey}:jobs`) || "[]");
          this._jobs = Array.isArray(cachedJobs) ? cachedJobs : [];
          this._sections = [...(Array.isArray(this._sections) ? this._sections.filter((item) => item.type !== "job") : []), ...this._jobSections()];
          this._populateAccommodationChoices();
        } catch { /* An empty jobs source is still usable for lesson questions. */ }
      }
      this._lessonContentStatus = contentLoaded ? "ready" : "error";
      this._renderLessonSuggestions();
    }

    _jobSections() {
      return this._jobs.map((job) => {
        const titles = { en: job.title, am: job.translations?.am?.title || job.title };
        const text = {};
        const englishDetails = [
          job.description,
          job.location,
          ...(job.accommodations || [])
        ].filter(Boolean).join(". ");
        text.en = englishDetails;
        text.am = englishDetails;
        for (const language of ["am", "ti", "om", "so"]) {
          const translated = job.translations?.[language];
          if (!translated || typeof translated.description !== "string" || !translated.description.trim()) continue;
          titles[language] = translated.title;
          text[language] = [
            translated.description,
            job.location,
            ...(Array.isArray(translated.accommodations) ? translated.accommodations : [])
          ].filter(Boolean).join(". ");
        }
        return { ...job, type: "job", title: job.title, titles, text };
      });
    }

    _renderLessonSuggestions() {
      const e = this._els;
      if (!e?.lessonExplore || !this._pack) return;

      const strings = this._pack.strings;
      const english = this._englishStrings;
      const nativeStrings = new Set(this._pack.localizedStrings || []);
      const isNative = (key) => this._pack.lang === "en" || nativeStrings.has(key);
      const write = (node, key) => {
        node.textContent = strings[key] || english[key] || "";
        node.lang = isNative(key) ? this._pack.lang : "en";
        node.dir = node.lang === "ar" ? "rtl" : "ltr";
      };

      write(e.lessonExploreHeading, "exploreHeading");
      write(e.lessonExploreDescription, "exploreDescription");
      write(e.lessonExploreRetry, "exploreRetry");
      e.lessonExploreList.replaceChildren();
      e.lessonExploreFallback.hidden = true;
      e.lessonExploreFallback.textContent = "";
      e.lessonExploreStatus.textContent = "";

      const state = this._lessonContentStatus;
      e.lessonExplore.setAttribute("aria-busy", String(state === "loading"));
      e.lessonExploreRetry.hidden = state !== "error";
      e.lessonExploreRetry.disabled = state === "loading";
      if (state === "loading") {
        write(e.lessonExploreStatus, "exploreLoading");
        return;
      }
      if (state === "error") {
        write(e.lessonExploreStatus, "exploreError");
        return;
      }

      const currentPath = window.location.pathname;
      const sections = this._sections.filter((section) => {
        if (!section || section.type === "job" || typeof section.url !== "string") return false;
        try {
          const source = new URL(section.url, window.location.href);
          return source.origin === window.location.origin &&
            source.pathname === currentPath &&
            typeof section.text?.en === "string" && section.text.en.trim();
        } catch {
          return false;
        }
      }).slice(0, 3);

      if (!sections.length) {
        write(e.lessonExploreStatus, "exploreEmpty");
        return;
      }

      const language = this._pack.lang;
      const hasLocalizedTemplate = language === "en" || nativeStrings.has("exploreQuestionTemplate");
      let usedFallback = false;
      for (const section of sections) {
        const localizedTitle = section.titles?.[language];
        const localizedText = section.text?.[language];
        const useLocalized = hasLocalizedTemplate &&
          typeof localizedTitle === "string" && localizedTitle.trim() &&
          typeof localizedText === "string" && localizedText.trim();
        const questionLanguage = useLocalized ? language : "en";
        const fallbackTitle = section.titles?.en || section.title;
        const title = useLocalized
          ? localizedTitle.trim()
          : (typeof fallbackTitle === "string" ? fallbackTitle.trim() : "");
        const template = useLocalized
          ? strings.exploreQuestionTemplate
          : english.exploreQuestionTemplate;
        if (!title || !template) continue;
        if (!useLocalized) usedFallback = true;

        const item = document.createElement("li");
        const button = document.createElement("button");
        button.type = "button";
        button.className = "lesson-suggestion";
        button.textContent = template.replace("{title}", title);
        button.dataset.question = button.textContent;
        button.lang = questionLanguage;
        button.dir = questionLanguage === "ar" ? "rtl" : "auto";
        item.append(button);
        e.lessonExploreList.append(item);
      }

      if (usedFallback) {
        write(e.lessonExploreFallback, "exploreFallback");
        e.lessonExploreFallback.hidden = false;
      }
      if (!e.lessonExploreList.childElementCount) write(e.lessonExploreStatus, "exploreEmpty");
    }

    _populateAccommodationChoices() {
      const jobSelect = this._els?.accommodationJob;
      if (!jobSelect || !this._jobs.length) return;
      const current = jobSelect.value;
      jobSelect.replaceChildren();
      for (const job of this._jobs) {
        const title = job.translations?.[this._pack?.lang]?.title || job.title;
        const option = document.createElement("option"); option.value = job.id; option.textContent = `${title} — ${job.location}`;
        jobSelect.append(option);
      }
      if (this._jobs.some((job) => job.id === current)) jobSelect.value = current;
      this._populateAccommodationOptions();
    }

    _populateAccommodationOptions() {
      const job = this._jobs.find((item) => item.id === this._els.accommodationJob.value) || this._jobs[0];
      const select = this._els.accommodationChoice;
      if (!select) return;
      const current = select.value;
      select.replaceChildren();
      const accommodations = job?.translations?.[this._pack?.lang]?.accommodations || job?.accommodations || [];
      for (const item of accommodations) {
        const option = document.createElement("option"); option.value = item; option.textContent = item; select.append(option);
      }
      const other = document.createElement("option"); other.value = "Other"; other.textContent = this._pack?.strings.otherAccommodation || "Other"; select.append(other);
      if ([...select.options].some((option) => option.value === current)) select.value = current;
    }

    _render() {
      this.shadowRoot.innerHTML = `
        <style>
      :host {
            --guide-paper: #f7faf7;
            --guide-surface: #ffffff;
            --guide-ink: #17352a;
            --guide-muted: #5c7065;
            --guide-line: #d8e4dc;
            --guide-wash: #eef5f0;
            --guide-accent: #0f766e;
            --guide-accent-soft: #e5f4f2;
            --guide-shadow: 0 24px 70px rgba(20, 46, 31, .2);
        all: initial;
        display: block;
        color: var(--assistant-foreground, var(--guide-ink));
            font: 15px/1.55 var(--bs-body-font-family, "Segoe UI", "Noto Sans Ethiopic", "Nyala", system-ui, sans-serif);
        font-size: calc(15px * var(--assistant-text-scale, 1));
        color-scheme: light;
      }
      :host([lang="am"]), :host([lang="ti"]) { line-height: 1.75; }
      :host([theme="dark"]) {
            --guide-paper: #101a14;
            --guide-surface: #18251d;
            --guide-ink: #f1f4ee;
            --guide-muted: #d0dbd1;
            --guide-line: #4b5b4e;
            --guide-wash: #223328;
        --guide-accent: #7dd3c7;
        --guide-accent-soft: #1d3432;
        --guide-shadow: 0 20px 56px rgba(0, 0, 0, .55);
        --assistant-focus: #ffd8a8;
        color-scheme: dark;
      }
      :host([contrast="high"]) {
        --guide-paper: #000 !important;
        --guide-surface: #000 !important;
        --guide-ink: #fff !important;
        --guide-muted: #fff !important;
        --guide-line: #fff !important;
        --guide-wash: #000 !important;
        --guide-accent: #ffff00 !important;
        --guide-accent-soft: #000 !important;
        --assistant-primary: #000 !important;
        --assistant-primary-contrast: #fff !important;
        --assistant-foreground: #fff !important;
        --assistant-focus: #00ffff !important;
        --guide-shadow: none !important;
        color-scheme: dark;
      }
      :host([contrast="high"]) .panel,
      :host([contrast="high"]) .message,
      :host([contrast="high"]) .study-card,
      :host([contrast="high"]) .offline-queue,
      :host([contrast="high"]) .study-pack,
      :host([contrast="high"]) .screen-share,
      :host([contrast="high"]) .ask-card { box-shadow: none; }
      :host([contrast="high"]) button,
      :host([contrast="high"]) textarea,
      :host([contrast="high"]) select,
      :host([contrast="high"]) input,
      :host([contrast="high"]) .panel,
      :host([contrast="high"]) .message,
      :host([contrast="high"]) .course-link { border-width: 2px; border-color: #fff !important; }
      :host([contrast="high"]) button,
      :host([contrast="high"]) textarea,
      :host([contrast="high"]) select,
      :host([contrast="high"]) input { background: #000 !important; color: #fff !important; }
      :host([contrast="high"]) button,
      :host([contrast="high"]) textarea,
      :host([contrast="high"]) select,
      :host([contrast="high"]) input { background-color: #000 !important; color: #fff !important; }
      :host([contrast="high"]) .launcher,
      :host([contrast="high"]) #send,
      :host([contrast="high"]) .person,
      :host([contrast="high"]) .person-action { background: #000 !important; color: #fff !important; border-color: #ffff00 !important; }
      :host([contrast="high"]) .course-link { color: #ffff00 !important; }
      :host([contrast="high"]) #greeting,
      :host([contrast="high"]) .lesson-explore-description,
      :host([contrast="high"]) .lesson-explore-fallback,
      :host([contrast="high"]) .lesson-explore-status { color: #fff !important; }
      *, *::before, *::after { box-sizing: border-box; }
      button, input, textarea, select { font: inherit; letter-spacing: normal; text-transform: none; }
          button { min-width: 44px; min-height: 44px; padding: 9px 13px; border: 1px solid transparent; border-radius: 12px; cursor: pointer; transition: background-color .16s ease, border-color .16s ease, box-shadow .16s ease, transform .16s ease; }
          button:disabled { cursor: wait; opacity: .72; }
          button:focus-visible, summary:focus-visible, input:focus-visible, textarea:focus-visible, select:focus-visible, [tabindex="-1"]:focus-visible, a:focus-visible { outline: 3px solid var(--assistant-focus, #0f766e); outline-offset: 3px; }
          button:hover:not(:disabled) { transform: translateY(-1px); }
          button:active:not(:disabled) { transform: translateY(0); }
          .launcher { position: fixed; z-index: 2147483647; inset-inline-end: 24px; inset-block-end: 24px; display: inline-flex; align-items: center; justify-content: center; gap: 11px; max-width: calc(100vw - 32px); padding: 12px 19px; border: 1px solid var(--assistant-primary, #245c3b); border-radius: 999px; background: var(--assistant-primary, #245c3b); color: var(--assistant-primary-contrast, #fff); font-weight: 750; text-align: start; box-shadow: 0 10px 28px rgba(20, 46, 31, .24); }
          .launcher::before { content: ""; width: 18px; height: 18px; flex: none; border: 2px solid currentColor; border-radius: 60% 22% 60% 22%; transform: rotate(-35deg); opacity: .9; }
          .launcher:hover:not(:disabled) { filter: brightness(1.08); box-shadow: 0 13px 32px rgba(20, 46, 31, .3); }
          .panel { position: fixed; z-index: 2147483646; inset-inline-end: clamp(12px, 2vw, 24px); inset-block-end: 84px; display: block; width: min(32rem, calc(100vw - 32px)); max-height: min(86dvh, 58rem); overflow: hidden; overscroll-behavior: contain; border: 1px solid var(--guide-line); border-block-start: 4px solid var(--guide-accent); border-radius: 24px; background: linear-gradient(145deg, var(--guide-paper), var(--guide-surface)); color: var(--assistant-foreground, var(--guide-ink)); padding: 0; box-shadow: var(--guide-shadow); animation: assistant-panel-enter .2s ease-out both; }
      .panel[hidden] { display: none; }
          .panel-inner { display: flex; flex-direction: column; gap: 16px; max-height: inherit; overflow-y: auto; overscroll-behavior: contain; padding: 16px; scrollbar-color: #829481 transparent; }
          .header { position: sticky; inset-block-start: -16px; z-index: 2; display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 14px; margin: -16px -16px 0; padding: 16px 16px 13px; border-block-end: 1px solid var(--guide-line); background: color-mix(in srgb, var(--guide-paper) 94%, transparent); backdrop-filter: blur(12px); }
          .header-title { flex: 1 1 12rem; min-width: 0; }
          .header-actions { display: flex; flex: 1 1 auto; align-items: center; justify-content: flex-end; gap: 8px; min-width: 0; flex-wrap: wrap; }
          .accessibility-controls { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
          .accessibility-controls button { min-width: 40px; min-height: 40px; padding: 7px 9px; }
          .text-size-controls { display: flex; align-items: center; gap: 4px; }
          .text-size-controls button { font-weight: 750; }
          .accessibility-label { margin: 0; color: var(--guide-muted); font-size: .78em; font-weight: 700; }
          .sr-only { position: absolute !important; width: 1px !important; height: 1px !important; padding: 0 !important; margin: -1px !important; overflow: hidden !important; clip: rect(0, 0, 0, 0) !important; white-space: nowrap !important; border: 0 !important; }
          .assistant-toolbar { display: grid; gap: 8px; }
          .conversation-region { display: grid; gap: 12px; min-width: 0; }
          .ask-card { position: relative; display: grid; gap: 12px; padding: 15px; border: 1px solid var(--guide-line); border-inline-start: 4px solid var(--assistant-primary, #245c3b); border-radius: 16px; background: var(--guide-surface); box-shadow: 0 4px 14px rgba(20, 46, 31, .05); }
          .composer-actions { display: grid; gap: 10px; }
          .composer-actions #send { width: 100%; }
      h2, p { margin: 0; overflow-wrap: anywhere; }
          .header-title h2 { overflow-wrap: break-word; word-break: normal; }
          h2 { position: relative; padding-inline-start: 13px; color: var(--assistant-foreground, var(--guide-ink)); font-family: inherit; font-size: clamp(1.2rem, 4vw, 1.45rem); font-weight: 750; line-height: 1.35; letter-spacing: -.015em; }
      h2::before { content: ""; position: absolute; inset-block: 3px; inset-inline-start: 0; width: 3px; background: var(--guide-accent); }
          #close { min-width: 44px; padding-inline: 10px; border-radius: 12px; background: var(--guide-surface); color: var(--assistant-foreground, var(--guide-ink)); border-color: var(--guide-line); }
          #close:hover:not(:disabled) { background: var(--guide-wash); }
          .person { max-width: 12rem; background: var(--guide-accent-soft); color: var(--assistant-foreground, var(--guide-ink)); border: 1px solid var(--guide-accent); border-inline-start: 4px solid var(--guide-accent); border-radius: 12px; font-weight: 750; text-align: start; }
          .person:hover:not(:disabled), .accommodation-open:hover:not(:disabled) { background: var(--guide-wash); }
          .accommodation-open { justify-self: start; margin: 0; background: transparent; color: var(--guide-muted); border-color: transparent; text-align: start; }
          .secondary { background: var(--guide-surface); color: var(--assistant-foreground, var(--guide-ink)); border-color: #718276; }
          .secondary:hover:not(:disabled) { background: var(--guide-wash); border-color: var(--assistant-primary, #245c3b); }
          .language { display: grid; grid-template-columns: auto minmax(0, 1fr); align-items: center; gap: 8px 12px; margin: 0; padding: 8px 10px; border: 1px solid var(--guide-line); border-radius: 12px; background: var(--guide-wash); }
          .language-label, label { font-weight: 650; }
          [aria-pressed="true"] { outline: 2px solid currentColor; outline-offset: 1px; }
          #locale-status { margin-block: 0 10px; padding: 9px 11px; border: 1px solid var(--guide-line); border-inline-start: 3px solid var(--guide-accent); border-radius: 10px; background: var(--guide-wash); color: var(--assistant-foreground, var(--guide-ink)); }
          #greeting { padding: 11px 13px; border: 1px solid var(--guide-line); border-inline-start: 4px solid var(--guide-accent); border-radius: 12px; background: var(--guide-accent-soft); color: #253d30; font-size: .96em; }
          :host([theme="dark"]) #greeting { color: #e7eee9; }
          .log { display: flex; flex-direction: column; gap: 13px; max-height: min(42dvh, 30rem); min-height: 2.5rem; overflow-y: auto; padding: 12px 4px 14px; border: 1px solid var(--guide-line); border-radius: 16px; background: color-mix(in srgb, var(--guide-wash) 52%, var(--guide-surface)); scroll-behavior: smooth; }
          .log:empty { min-height: 0; padding-block: 0; border: 0; }
          .offline-queue { display: grid; gap: 10px; margin: 0; padding: 14px; border: 1px solid var(--guide-line); border-inline-start: 3px solid var(--guide-accent); border-radius: 14px; background: var(--guide-wash); }
          .study-pack { display: grid; gap: 10px; margin: 0; padding: 14px; border: 1px solid var(--guide-line); border-inline-start: 3px solid var(--assistant-primary, #245c3b); border-radius: 14px; background: var(--guide-wash); }
      .study-pack h3, .study-pack p { margin: 0; }
      .study-card { display: grid; gap: 6px; padding: 12px; border: 1px solid var(--guide-line); border-radius: 11px; background: var(--guide-surface); }
      .study-card p { white-space: pre-wrap; }
      .lesson-explore { display: grid; gap: 10px; margin: 0; padding: 11px 13px; border: 1px solid var(--guide-line); border-radius: 14px; background: var(--guide-wash); }
      .lesson-explore p { margin: 0; }
      .lesson-explore-summary { display: flex; min-height: 44px; align-items: center; justify-content: space-between; gap: 12px; list-style: none; cursor: pointer; }
      .lesson-explore-summary::-webkit-details-marker { display: none; }
      .lesson-explore-summary:focus-visible { border-radius: 8px; }
      .lesson-explore-heading { color: var(--assistant-foreground, var(--guide-ink)); font-size: 1rem; font-weight: 750; line-height: 1.45; }
      .lesson-explore-chevron { width: 10px; height: 10px; flex: none; border-inline-end: 2px solid var(--assistant-primary, #245c3b); border-block-end: 2px solid var(--assistant-primary, #245c3b); transform: rotate(45deg); transition: transform .16s ease; }
      .lesson-explore[open] .lesson-explore-chevron { transform: rotate(225deg); }
      .lesson-explore-description { color: #435448; font-size: .9em; line-height: 1.55; }
      :host([theme="dark"]) .lesson-explore-description { color: #d0dbd1; }
      .lesson-suggestions { display: grid; grid-template-columns: minmax(0, 1fr); gap: 9px; margin: 0; padding: 0; list-style: none; }
      .lesson-suggestions li { min-width: 0; }
      .lesson-suggestion { width: 100%; min-height: 56px; padding: 12px 14px; border: 1px solid var(--guide-line); border-inline-start: 3px solid var(--guide-accent); border-radius: 12px; background: var(--guide-surface); color: var(--assistant-foreground, var(--guide-ink)); font-family: "Noto Sans Ethiopic", "Nyala", system-ui, sans-serif; font-size: .96em; font-weight: 600; line-height: 1.6; text-align: start; white-space: normal; overflow-wrap: anywhere; }
      .lesson-suggestion:lang(am) { line-height: 1.85; }
      .lesson-suggestion:hover:not(:disabled) { border-color: var(--assistant-primary, #245c3b); background: var(--guide-paper); }
      .lesson-explore-fallback, .lesson-explore-status { padding: 8px 10px; border-radius: 9px; background: var(--guide-surface); color: var(--assistant-foreground, var(--guide-ink)); font-size: .9em; }
      .lesson-explore-fallback { border-inline-start: 3px solid var(--guide-accent); }
      .lesson-explore-retry { justify-self: start; }
      .offline-queue[hidden] { display: none; }
      .offline-queue h3, .queue-question { margin: 0; overflow-wrap: anywhere; }
      .offline-queue h3 { font-size: 1rem; }
          .queue-list { display: grid; gap: 10px; margin: 0; padding: 0; list-style: none; }
          .queue-item { display: grid; gap: 8px; padding: 12px; border: 1px solid var(--guide-line); border-radius: 11px; background: var(--guide-surface); }
      .queue-status, .queue-live-status { margin: 0; font-size: .9em; }
      .queue-actions { display: flex; flex-wrap: wrap; gap: 8px; }
      .queue-actions button, .queue-editor button { min-height: 40px; }
      .queue-editor { display: grid; gap: 8px; }
      .queue-editor[hidden] { display: none; }
          .queue-editor textarea { width: 100%; min-height: 5rem; padding: 8px; border: 1px solid #718276; background: var(--guide-surface); color: var(--assistant-foreground, var(--guide-ink)); }
          .queue-live-status { color: var(--assistant-foreground, var(--guide-ink)); }
          .message { width: fit-content; max-width: 90%; margin: 0; padding: 12px 14px; border: 1px solid var(--guide-line); border-radius: 16px; overflow-wrap: anywhere; box-shadow: 0 3px 10px rgba(22, 43, 30, .045); }
          .message-user { align-self: flex-end; border-color: var(--assistant-primary, #245c3b); border-inline-end: 3px solid var(--guide-accent); border-radius: 16px 16px 4px 16px; background: var(--assistant-primary, #245c3b); color: var(--assistant-primary-contrast, #fff); }
          .message-assistant { align-self: flex-start; border-inline-start: 3px solid var(--assistant-primary, #245c3b); border-radius: 16px 16px 16px 4px; background: var(--guide-surface); color: var(--assistant-foreground, var(--guide-ink)); }
          .message-body { line-height: 1.7; white-space: pre-wrap; }
          .message-assistant[data-answer-status="off_topic"], .message-assistant[data-answer-status="refused"] { border-inline-start-color: var(--guide-accent); }
          .message-author { font-weight: 750; margin-bottom: 3px; font-size: .86em; color: var(--assistant-primary, #245c3b); }
          .message-user .message-author, .message-user .message-time { color: var(--assistant-primary-contrast, #fff); }
          .message-time { display: block; margin-block-end: 6px; color: var(--guide-muted); font-size: .75em; }
          .evidence-label { margin-top: 10px; padding-top: 8px; border-top: 1px solid var(--guide-line); font-size: .88em; font-weight: 650; color: var(--assistant-foreground, var(--guide-muted)); }
          .course-link { display: flex; align-items: baseline; gap: 8px; min-height: 44px; margin-top: 10px; padding: 10px 12px; border: 1px solid var(--guide-line); border-inline-start: 3px solid var(--assistant-primary, #245c3b); border-radius: 10px; background: var(--guide-wash); color: var(--assistant-primary, #245c3b); font-weight: 750; text-decoration-thickness: 1px; text-underline-offset: 3px; overflow-wrap: anywhere; }
          .course-link::after { content: "↗"; flex: none; font-size: .9em; text-decoration: none; }
      .course-link:hover, .course-link:focus { text-decoration-thickness: 2px; }
      .debug-score { font-size: .8em; color: var(--guide-muted); margin-top: 6px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
          .person-action { display: flex; align-items: center; justify-content: space-between; gap: 12px; width: 100%; min-height: 48px; margin-top: 12px; padding: 11px 14px; background: var(--guide-accent-soft); color: var(--assistant-foreground, var(--guide-ink)); border: 2px solid var(--guide-accent); border-inline-start-width: 5px; border-radius: 10px; font-weight: 800; cursor: pointer; text-align: start; }
          .person-action::after { content: "→"; flex: none; font-size: 1.2em; }
          .person-action:hover:not(:disabled), .person-action:focus-visible { background: var(--guide-wash); }
      .voice-controls { display: flex; flex-wrap: wrap; gap: 8px; }
      .answer-actions { display: flex; flex-wrap: wrap; gap: 7px; margin-block-start: 11px; padding-block-start: 10px; border-block-start: 1px solid var(--guide-line); }
      .answer-actions button, .message > .voice-controls button { min-height: 40px; padding-block: 7px; border-radius: 10px; }
      .message > .voice-controls { margin-block-start: 10px; padding-block-start: 10px; border-block-start: 1px solid var(--guide-line); }
      .answer-copy-status { margin-block-start: 6px; color: var(--assistant-foreground, var(--guide-ink)); font-size: .9em; }
      .answer-copy-status:empty { display: none; }
      .listen-button { display: inline-flex; }
      .voice-status { min-height: 1.5em; margin: 0; }
      .voice-status:empty { display: none; }
      .voice-note audio { display: block; width: 100%; margin-block: 8px; }
      .voice-transcript { display: grid; gap: 5px; margin-block-start: 8px; padding: 9px 11px; border: 1px solid var(--guide-line); border-inline-start: 3px solid var(--guide-accent); border-radius: 10px; background: var(--guide-wash); }
      .voice-transcript[hidden] { display: none; }
      .voice-transcript strong { font-size: .86em; }
      .voice-transcript p { white-space: pre-wrap; }
          .escalation { display: flex; flex-direction: column; gap: 11px; margin: 0; padding: 15px; border: 1px solid var(--guide-line); border-inline-start: 4px solid var(--guide-accent); border-radius: 16px; background: var(--guide-surface); box-shadow: 0 4px 14px rgba(22, 43, 30, .04); }
      .escalation[hidden], [hidden] { display: none !important; }
      .consent { display: flex; align-items: flex-start; gap: 10px; }
      .consent input { width: 24px; height: 24px; flex: none; margin: 2px 0 0; accent-color: var(--assistant-primary, #245c3b); }
          .screen-share { display: flex; flex-direction: column; gap: 10px; border: 1px solid var(--guide-line); border-radius: 12px; padding: 12px; background: var(--guide-wash); }
      .screen-share h3 { margin: 0; color: var(--assistant-foreground, var(--guide-ink)); font-size: 1rem; }
      .screen-share input[type="file"] { max-width: 100%; min-height: 44px; }
          .screen-share-bar { position: fixed; z-index: 2147483647; inset-block-start: 8px; inset-inline: 8px; margin-inline: auto; max-width: 36rem; display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 14px; border: 2px solid #166534; border-radius: 4px; background: #ecf6ee; color: #174b2d; font-weight: 700; box-shadow: 0 8px 24px #0003; }
      .screen-share-bar[hidden] { display: none !important; }
      .screen-share-bar button { flex: none; color: #fff; background: #0f766e; border: 2px solid #0f766e; }
      .voice-button[aria-pressed="true"] { background: #0f766e; color: #fff; border-color: #0f766e; }
      form, .field { display: flex; flex-direction: column; gap: 8px; }
      .error:empty { display: none; }
          #form { margin: 0; padding: 0; border: 0; background: transparent; }
          select { min-height: 44px; max-width: 100%; padding: 9px 12px; color: var(--assistant-foreground, var(--guide-ink)); background: var(--guide-surface); border: 1px solid #718276; border-radius: 10px; }
          textarea { width: 100%; min-height: 4.5rem; max-height: 35vh; resize: vertical; padding: 12px 13px; border: 1px solid #718276; border-radius: 12px; background: var(--guide-surface); color: var(--assistant-foreground, var(--guide-ink)); line-height: 1.55; }
      textarea:focus, select:focus, input[type="tel"]:focus { border-color: var(--assistant-primary, #245c3b); }
          input[type="tel"] { width: 100%; min-height: 44px; padding: 10px 12px; border: 1px solid #718276; border-radius: 10px; background: var(--guide-surface); color: var(--assistant-foreground, var(--guide-ink)); }
      textarea::placeholder { color: var(--guide-muted); opacity: 1; }
          .error { margin: 0; padding: 9px 11px; border: 1px solid #e4c77e; border-inline-start: 3px solid #b7791f; border-radius: 10px; background: #fff8e6; color: #6b4b0d; }
          :host([theme="dark"]) .error { border-color: #806b3d; border-inline-start-color: #e5c27a; background: #302b1d; color: #f3d58f; }
          #voice-help { margin: 0; color: var(--guide-muted); font-size: .82em; line-height: 1.5; }
          #send { display: inline-flex; align-items: center; justify-content: center; gap: 10px; min-height: 50px; background: #1e5638; color: #fff; border: 1px solid #1e5638; border-radius: 12px; font-weight: 750; box-shadow: 0 5px 14px rgba(24, 63, 39, .18); }
          #send:hover:not(:disabled) { background: #17452d; border-color: #17452d; box-shadow: 0 8px 18px rgba(24, 63, 39, .24); }
          #send[aria-busy="true"]::after { content: ""; width: 14px; height: 14px; border: 2px solid currentColor; border-inline-end-color: transparent; border-radius: 50%; animation: guide-spin .8s linear infinite; }
          @keyframes guide-spin { to { transform: rotate(360deg); } }
          @keyframes assistant-panel-enter { from { opacity: 0; } to { opacity: 1; } }
          .course-link, .message-body, .queue-question { overflow-wrap: anywhere; }
          @media (max-width: 720px) {
                .panel { inset-inline: 0; inset-block-end: 0; width: 100%; max-height: min(88dvh, calc(100dvh - 2rem)); border-radius: 24px 24px 0 0; }
                .panel-inner { gap: 14px; padding: 15px max(16px, env(safe-area-inset-right)) calc(14px + env(safe-area-inset-bottom)) max(16px, env(safe-area-inset-left)); }
                .header { inset-block-start: -15px; margin: -15px -16px 0; padding: 15px 16px 12px; }
                .header-actions { gap: 5px; }
                .person { max-width: 9rem; }
                .log { max-height: min(34dvh, 22rem); }
                .ask-card { box-shadow: none; }
            .launcher { position: fixed; inset-inline-end: 12px; inset-block-end: calc(12px + env(safe-area-inset-bottom)); display: inline-flex; margin: 0; max-width: calc(100vw - 24px); }
                .language { grid-template-columns: auto minmax(0, 1fr); gap: 8px; margin-block: 8px; padding: 7px 9px; }
          }
          @media (max-width: 360px) {
            .panel-inner { padding-inline: 11px; }
            .header { flex-wrap: wrap; gap: 10px; margin-inline: -11px; padding-inline: 11px; }
            .header-title { flex: 1 1 100%; }
            .header-actions { width: 100%; justify-content: flex-end; }
            .header-actions { flex-wrap: wrap; }
            .accessibility-controls { order: 3; width: 100%; justify-content: flex-end; }
            .message { padding: 10px; }
            .message { max-width: 94%; }
            .composer-actions #send { width: 100%; }
            .composer-actions .voice-controls { justify-content: flex-start; }
            .accommodation-open { width: 100%; }
          }
          @media (prefers-reduced-motion: reduce) { :host, :host * { animation: none !important; transition: none !important; scroll-behavior: auto !important; } }
          @media (forced-colors: active) { button, textarea, select, input, .panel, .message, .offline-queue, .study-pack, .screen-share { border: 2px solid CanvasText; } .person, #send, .person-action, .launcher { background: ButtonFace; color: ButtonText; } .course-link { color: LinkText; } }
        </style>
        <button type="button" class="launcher" id="launcher" disabled aria-label="Open learning assistant" aria-haspopup="dialog" aria-controls="panel" aria-expanded="false">Ask Savanna</button>
        <section class="panel" id="panel" role="dialog" aria-labelledby="panel-title" aria-describedby="panel-instructions" aria-modal="true" hidden>
          <div class="panel-inner">
            <header class="header">
              <div class="header-title"><h2 id="panel-title" tabindex="-1"></h2></div>
              <div class="header-actions">
                <button type="button" class="person" id="person"></button>
                <div class="accessibility-controls" role="group" aria-labelledby="accessibility-label">
                  <span class="accessibility-label sr-only" id="accessibility-label"></span>
                  <button type="button" class="secondary" id="contrast-toggle" aria-pressed="false"></button>
                  <div class="text-size-controls" role="group" aria-labelledby="text-size-label">
                    <span class="accessibility-label sr-only" id="text-size-label"></span>
                    <button type="button" class="secondary" id="text-decrease"></button>
                    <button type="button" class="secondary" id="text-reset"></button>
                    <button type="button" class="secondary" id="text-increase"></button>
                  </div>
                </div>
                <button type="button" class="secondary" id="close"></button>
              </div>
            </header>
            <p id="panel-instructions" class="sr-only"></p>
            <div class="assistant-toolbar">
              <div class="language">
                <label class="language-label" id="language-label" for="language-select"></label>
                <select id="language-select" aria-labelledby="language-label">
                  <option value="en" lang="en">English</option>
                  <option value="am" lang="am">አማርኛ</option>
                  <option value="ti" lang="ti">ትግርኛ</option>
                  <option value="om" lang="om">Afaan Oromoo</option>
                  <option value="so" lang="so">Soomaali</option>
                  <option value="ar" lang="ar">العربية</option>
                </select>
              </div>
              <p id="locale-status" role="status" aria-live="polite" hidden></p>
            </div>
            <section class="conversation-region" aria-label="Conversation">
              <p id="greeting" dir="auto"></p>
              <div class="log" id="messages" role="log" aria-live="polite" aria-relevant="additions"></div>
            </section>
            <section class="study-pack" id="study-pack" aria-labelledby="study-pack-heading" hidden>
              <h3 id="study-pack-heading" tabindex="-1"></h3>
              <div id="study-pack-list"></div>
              <button type="button" class="secondary" id="study-pack-export" hidden></button>
              <p id="study-pack-status" role="status" aria-live="polite"></p>
            </section>
            <section class="offline-queue" id="offline-queue" aria-labelledby="offline-queue-heading" hidden>
              <h3 id="offline-queue-heading"></h3>
              <ul class="queue-list" id="offline-queue-list"></ul>
            </section>
            <p class="queue-live-status" id="offline-queue-status" role="status" aria-live="polite" aria-atomic="true"></p>
            <details class="lesson-explore" id="lesson-explore" aria-busy="true">
              <summary class="lesson-explore-summary">
                <span class="lesson-explore-heading" id="lesson-explore-heading" role="heading" aria-level="3"></span>
                <span class="lesson-explore-chevron" aria-hidden="true"></span>
              </summary>
              <p class="lesson-explore-description" id="lesson-explore-description"></p>
              <p class="lesson-explore-fallback" id="lesson-explore-fallback" role="status" aria-live="polite" hidden></p>
              <p class="lesson-explore-status" id="lesson-explore-status" role="status" aria-live="polite" aria-atomic="true"></p>
              <ul class="lesson-suggestions" id="lesson-explore-list" aria-describedby="lesson-explore-description"></ul>
              <button type="button" class="secondary lesson-explore-retry" id="lesson-explore-retry" hidden></button>
            </details>
            <section class="ask-card" aria-label="Ask about this lesson">
            <form id="form" novalidate>
              <div class="field"><label id="question-label" for="question"></label>
              <textarea id="question" name="question" dir="auto" autocomplete="off" aria-required="true" aria-describedby="question-help"></textarea>
                <p id="question-help" class="sr-only"></p>
                <p id="question-error" class="error" role="alert" dir="auto"></p></div>
              <label class="consent" id="cloud-consent-row" for="cloud-consent" hidden>
                <input id="cloud-consent" type="checkbox"><span id="cloud-consent-label"></span>
              </label>
              <div class="composer-actions">
                <button type="submit" id="send"></button>
                <div class="voice-controls">
                  <button type="button" class="secondary voice-button" id="microphone" aria-pressed="false"></button>
                  <button type="button" class="secondary voice-button" id="voice-command" aria-pressed="false"></button>
                  <button type="button" class="secondary" id="voice-guide"></button>
                  <button type="button" class="secondary" id="stop-voice" hidden></button>
                  <button type="button" class="secondary" id="read-back" hidden></button>
                </div>
              </div>
              <p id="voice-help" role="note"></p>
              <p id="voice-status" class="voice-status" role="status" aria-live="polite" aria-atomic="true"></p>
              <div class="voice-note" id="voice-note" hidden><strong id="voice-note-label"></strong><audio id="voice-player" aria-labelledby="voice-note-label" aria-describedby="voice-transcript-text" controls><track id="voice-captions" kind="captions" default></audio></div>
              <div class="voice-transcript" id="voice-transcript" role="region" aria-labelledby="voice-transcript-label" hidden>
                <strong id="voice-transcript-label"></strong>
                <p id="voice-transcript-text" dir="auto" aria-live="polite"></p>
              </div>
            </form>
            </section>
            <button type="button" class="secondary accommodation-open" id="accommodation-open"></button>
            <form id="accommodation-form" class="escalation" novalidate hidden>
              <p id="accommodation-privacy" role="note"></p>
              <label for="accommodation-job" id="accommodation-job-label"></label>
              <select id="accommodation-job" required></select>
              <label for="accommodation-choice" id="accommodation-choice-label"></label>
              <select id="accommodation-choice" required></select>
              <label for="accommodation-note" id="accommodation-note-label"></label>
              <textarea id="accommodation-note" rows="2" dir="auto"></textarea>
              <p id="accommodation-status" class="error" role="status" aria-live="polite"></p>
              <button type="submit" id="accommodation-send"></button>
            </form>
            <form id="escalation" class="escalation" novalidate hidden>
              <label for="escalation-reason" id="escalation-reason-label"></label>
              <select id="escalation-reason" name="handoffReason" required aria-required="true">
                <option value=""></option>
                <option value="answer_not_found"></option>
                <option value="learner_requested_person"></option>
                <option value="answer_flagged_incorrect"></option>
                <option value="other"></option>
              </select>
              <p id="escalation-reason-error" class="error" role="alert" hidden></p>
              <label for="escalation-phone" id="escalation-phone-label"></label>
              <input id="escalation-phone" name="phone" type="tel" autocomplete="tel" inputmode="tel">
              <p id="phone-error" class="error" role="alert" hidden></p>
              <label for="escalation-note" id="escalation-note-label"></label>
              <textarea id="escalation-note" name="note" rows="2" dir="auto" aria-required="false"></textarea>
              <p id="escalation-other-error" class="error" role="alert" hidden></p>
              <label class="consent" for="consent"><input id="consent" type="checkbox"><span id="consent-label"></span></label>
              <p id="tutor-availability" role="note"></p>
              <section class="screen-share" aria-labelledby="screen-share-title">
                <h3 id="screen-share-title"></h3>
                <p id="screen-share-note" role="note"></p>
                <label class="consent" for="screen-share-consent"><input id="screen-share-consent" type="checkbox"><span id="screen-share-consent-label"></span></label>
                <button type="button" class="secondary" id="screen-share-start" hidden></button>
                <label for="screen-screenshot" id="screen-screenshot-label" hidden></label>
                <input id="screen-screenshot" type="file" accept="image/*" hidden>
                <button type="button" class="secondary" id="screen-context-start" hidden></button>
                <p id="screen-share-status" class="error" role="status" aria-live="polite"></p>
              </section>
              <p id="escalation-status" class="error" role="status" aria-live="polite"></p>
              <button type="button" class="secondary" id="check-tutor-reply" hidden></button>
              <section id="ticket-data" class="screen-share" aria-labelledby="ticket-data-title" hidden>
                <h3 id="ticket-data-title"></h3>
                <label for="ticket-data-select" id="ticket-data-label"></label>
                <select id="ticket-data-select"></select>
                <p id="ticket-data-note" role="note"></p>
                <div class="voice-controls">
                  <button type="button" class="secondary" id="export-ticket-data"></button>
                  <button type="button" class="secondary" id="delete-ticket-data"></button>
                </div>
                <p id="ticket-data-status" role="status" aria-live="polite"></p>
              </section>
              <button type="button" class="secondary" id="clear-local-data"></button>
              <button type="submit" id="send-escalation"></button>
            </form>
          </div>
        </section>
        <div id="screen-share-bar" class="screen-share-bar" role="status" aria-live="polite" aria-atomic="true" hidden>
          <span id="screen-share-bar-text"></span>
          <button type="button" id="screen-share-stop"></button>
        </div>`;
      const announcer = document.createElement("p");
      announcer.id = "assistant-announcer";
      announcer.className = "sr-only";
      announcer.setAttribute("role", "status");
      announcer.setAttribute("aria-live", "polite");
      announcer.setAttribute("aria-atomic", "true");
      this.shadowRoot.append(announcer);
      const isAndroidChrome = typeof navigator !== "undefined" &&
        /Android/i.test(navigator.userAgent) && /Chrome|Chromium/i.test(navigator.userAgent);
      const screenCaptureAvailable = !isAndroidChrome && typeof navigator !== "undefined" &&
        typeof navigator.mediaDevices?.getDisplayMedia === "function";
      const $ = (id) => this.shadowRoot.getElementById(id);
      this._els = {
        launcher: $("launcher"),
        panel: $("panel"),
        title: $("panel-title"),
        close: $("close"),
        person: $("person"),
        contrastToggle: $("contrast-toggle"), textDecrease: $("text-decrease"), textReset: $("text-reset"), textIncrease: $("text-increase"),
        panelInstructions: $("panel-instructions"), accessibilityLabel: $("accessibility-label"), textSizeLabel: $("text-size-label"),
        questionHelp: $("question-help"), announcer,
        accommodationOpen: $("accommodation-open"),
        languageLabel: $("language-label"),
        languageSelect: $("language-select"),
        localeStatus: $("locale-status"),
        greeting: $("greeting"),
        log: $("messages"),
        studyPack: $("study-pack"), studyPackHeading: $("study-pack-heading"),
        studyPackList: $("study-pack-list"), studyPackExport: $("study-pack-export"), studyPackStatus: $("study-pack-status"),
        questionQueue: $("offline-queue"),
        questionQueueHeading: $("offline-queue-heading"),
        questionQueueList: $("offline-queue-list"),
        questionQueueStatus: $("offline-queue-status"),
        lessonExplore: $("lesson-explore"),
        lessonExploreHeading: $("lesson-explore-heading"),
        lessonExploreDescription: $("lesson-explore-description"),
        lessonExploreFallback: $("lesson-explore-fallback"),
        lessonExploreStatus: $("lesson-explore-status"),
        lessonExploreList: $("lesson-explore-list"),
        lessonExploreRetry: $("lesson-explore-retry"),
        form: $("form"),
        label: $("question-label"),
        input: $("question"),
        error: $("question-error"),
        cloudConsentRow: $("cloud-consent-row"), cloudConsent: $("cloud-consent"),
        cloudConsentLabel: $("cloud-consent-label"),
        send: $("send"), microphone: $("microphone"), voiceCommand: $("voice-command"), voiceGuide: $("voice-guide"), stopVoice: $("stop-voice"), readBack: $("read-back"),
        voiceStatus: $("voice-status"), voiceNote: $("voice-note"), voiceNoteLabel: $("voice-note-label"), voicePlayer: $("voice-player"),
        voiceHelp: $("voice-help"), voiceTranscript: $("voice-transcript"), voiceTranscriptLabel: $("voice-transcript-label"), voiceTranscriptText: $("voice-transcript-text"), voiceCaptions: $("voice-captions"),
        escalation: $("escalation"), escalationNoteLabel: $("escalation-note-label"), escalationNote: $("escalation-note"),
        escalationReasonLabel: $("escalation-reason-label"), escalationReason: $("escalation-reason"),
        escalationReasonError: $("escalation-reason-error"), escalationOtherError: $("escalation-other-error"),
        escalationPhoneLabel: $("escalation-phone-label"), escalationPhone: $("escalation-phone"), phoneError: $("phone-error"),
        consent: $("consent"), consentLabel: $("consent-label"), escalationStatus: $("escalation-status"),
        tutorAvailability: $("tutor-availability"),
        checkTutorReply: $("check-tutor-reply"), sendEscalation: $("send-escalation"),
        ticketData: $("ticket-data"), ticketDataTitle: $("ticket-data-title"),
        ticketDataLabel: $("ticket-data-label"), ticketDataSelect: $("ticket-data-select"),
        ticketDataNote: $("ticket-data-note"), ticketDataStatus: $("ticket-data-status"),
        exportTicketData: $("export-ticket-data"), deleteTicketData: $("delete-ticket-data"),
        clearLocalData: $("clear-local-data"),
        screenShareTitle: $("screen-share-title"), screenShareNote: $("screen-share-note"),
        screenShareConsent: $("screen-share-consent"), screenShareConsentLabel: $("screen-share-consent-label"),
        screenShareStart: $("screen-share-start"), screenScreenshotLabel: $("screen-screenshot-label"),
        screenScreenshot: $("screen-screenshot"), screenContextStart: $("screen-context-start"),
        screenShareStatus: $("screen-share-status"), screenShareBar: $("screen-share-bar"),
        screenShareBarText: $("screen-share-bar-text"), screenShareStop: $("screen-share-stop"),
        accommodationForm: $("accommodation-form"), accommodationPrivacy: $("accommodation-privacy"),
        accommodationJobLabel: $("accommodation-job-label"), accommodationJob: $("accommodation-job"),
        accommodationChoiceLabel: $("accommodation-choice-label"), accommodationChoice: $("accommodation-choice"),
        accommodationNoteLabel: $("accommodation-note-label"), accommodationNote: $("accommodation-note"),
        accommodationStatus: $("accommodation-status"), accommodationSend: $("accommodation-send")
      };
      this._els.screenShareStart.hidden = !screenCaptureAvailable;
      this._els.screenContextStart.hidden = screenCaptureAvailable;
      this._els.screenScreenshotLabel.hidden = screenCaptureAvailable;
      this._els.screenScreenshot.hidden = screenCaptureAvailable;
      this._applyTheme();
      this._applyAccessibilityPreferences(false);
      this._renderMessages();
    }

    _applyTheme() {
      const themes = {
        light: ["var(--bs-primary, #166534)", "var(--bs-body-bg, #fff)", "var(--bs-body-color, #17251d)", "#92400e", "#fff"],
        dark: ["#4ade80", "#171d19", "#f1f5f2", "#bbf7d0", "#052e16"]
      };
      const values = themes[this.getAttribute("theme")] || themes.light;
      this.style.setProperty("--assistant-primary", values[0]);
      this.style.setProperty("--assistant-background", values[1]);
      this.style.setProperty("--assistant-foreground", values[2]);
      this.style.setProperty("--assistant-focus", values[3]);
      this.style.setProperty("--assistant-primary-contrast", values[4]);
    }

    _normalizeTextScale(value) {
      const scale = Number.parseFloat(value);
      if (!Number.isFinite(scale)) return 1;
      return Math.min(1.35, Math.max(.9, Number(scale.toFixed(2))));
    }

    _restoreAccessibilityPreferences() {
      let saved = null;
      try { saved = JSON.parse(localStorage.getItem(this._accessibilityKey) || "null"); } catch { /* Use defaults when storage is unavailable. */ }
      this._textScale = this._normalizeTextScale(saved?.textScale ?? this.getAttribute("text-scale") ?? 1);
      this._contrastMode = saved?.contrast === "high" || this.getAttribute("contrast") === "high";
    }

    _persistAccessibilityPreferences() {
      try {
        localStorage.setItem(this._accessibilityKey, JSON.stringify({ textScale: this._textScale, contrast: this._contrastMode ? "high" : "normal" }));
      } catch { /* Preferences remain active for this page when storage is unavailable. */ }
    }

    _applyAccessibilityPreferences(announce = false) {
      if (!this._els) return;
      this.style.setProperty("--assistant-text-scale", String(this._textScale));
      if (this._contrastMode) this.setAttribute("contrast", "high");
      else if (this.getAttribute("contrast") === "high") this.removeAttribute("contrast");
      this.setAttribute("text-scale", String(this._textScale));
      this._els.contrastToggle.setAttribute("aria-pressed", String(this._contrastMode));
      this._els.contrastToggle.setAttribute("aria-label", this._contrastMode
        ? (this._pack?.strings.highContrastOn || en.strings.highContrastOn)
        : (this._pack?.strings.highContrast || en.strings.highContrast));
      this._els.contrastToggle.textContent = this._contrastMode
        ? (this._pack?.strings.highContrastOn || en.strings.highContrastOn)
        : (this._pack?.strings.highContrast || en.strings.highContrast);
      this._els.textDecrease.disabled = this._textScale <= .9;
      this._els.textIncrease.disabled = this._textScale >= 1.35;
      this._els.textReset.disabled = this._textScale === 1;
      if (announce) {
        const sizeKey = this._textScale < 1 ? "textSizeSmaller" : this._textScale > 1 ? "textSizeLarger" : "textSizeDefault";
        const sizeText = this._pack?.strings[sizeKey] || en.strings[sizeKey];
        const contrastText = this._contrastMode
          ? (this._pack?.strings.highContrastOn || en.strings.highContrastOn)
          : (this._pack?.strings.highContrastOff || en.strings.highContrastOff);
        this._announce(`${sizeText}. ${contrastText}`);
      }
    }

    _setTextScale(value) {
      const next = this._normalizeTextScale(value);
      if (next === this._textScale) return;
      this._textScale = next;
      this._persistAccessibilityPreferences();
      this._applyAccessibilityPreferences(true);
    }

    _setContrastMode(enabled) {
      const next = Boolean(enabled);
      if (next === this._contrastMode) return;
      this._contrastMode = next;
      this._persistAccessibilityPreferences();
      this._applyAccessibilityPreferences(true);
    }

    _announce(text, assertive = false) {
      if (!this._els?.announcer || !text) return;
      const token = ++this._announcementToken;
      this._els.announcer.setAttribute("aria-live", assertive ? "assertive" : "polite");
      this._els.announcer.textContent = "";
      window.setTimeout(() => {
        if (token === this._announcementToken && this._els?.announcer) this._els.announcer.textContent = text;
      }, 20);
    }

    _focusablePanelElements() {
      if (!this._els?.panel || this._els.panel.hidden) return [];
      const selector = [
        "button:not([disabled])", "a[href]", "input:not([disabled])", "select:not([disabled])",
        "textarea:not([disabled])", "summary", "[tabindex]:not([tabindex=\"-1\"])"
      ].join(",");
      return [...this._els.panel.querySelectorAll(selector)].filter((element) => {
        if (element.hidden || element.closest("[hidden]")) return false;
        return element.getAttribute("aria-hidden") !== "true";
      });
    }

    _bind() {
      const e = this._els;
      e.launcher.addEventListener("click", () => this._open());
      e.close.addEventListener("click", () => this._close());
      e.contrastToggle.addEventListener("click", () => this._setContrastMode(!this._contrastMode));
      e.textDecrease.addEventListener("click", () => this._setTextScale(this._textScale - .1));
      e.textReset.addEventListener("click", () => this._setTextScale(1));
      e.textIncrease.addEventListener("click", () => this._setTextScale(this._textScale + .1));
      e.studyPackExport.addEventListener("click", () => this._exportStudyPack());
      e.lessonExploreList.addEventListener("click", (event) => {
        const button = event.target.closest?.("button[data-question]");
        if (!button || !e.lessonExploreList.contains(button)) return;
        e.input.value = button.dataset.question;
        e.input.dispatchEvent(new Event("input", { bubbles: true }));
        e.input.focus();
        e.lessonExploreStatus.textContent = this._pack?.strings.exploreInserted || this._englishStrings.exploreInserted || "";
        e.lessonExploreStatus.lang = this._pack?.localizedStrings?.includes("exploreInserted") ? this._pack.lang : "en";
        e.lessonExploreStatus.dir = e.lessonExploreStatus.lang === "ar" ? "rtl" : "ltr";
      });
      e.lessonExploreRetry.addEventListener("click", () => this._loadContent());
      e.form.addEventListener("submit", (event) => this._onSubmit(event));
      this._onlineHandler = () => { this._flushQuestionQueue(); this._flushVoiceActionQueue(); };
      window.addEventListener("online", this._onlineHandler);
      e.input.addEventListener("keydown", (event) => {
        if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
          event.preventDefault();
          e.form.requestSubmit();
        }
      });
      e.input.addEventListener("input", () => {
        if (this._errorKey) this._setError("");
      });
      e.escalationPhone.addEventListener("input", () => {
        e.phoneError.hidden = true;
        e.escalationPhone.removeAttribute("aria-invalid");
        e.escalationPhone.removeAttribute("aria-describedby");
      });
      e.escalationReason.addEventListener("change", () => {
        e.escalationReasonError.hidden = true;
        e.escalationReason.removeAttribute("aria-invalid");
        e.escalationReason.removeAttribute("aria-describedby");
        e.escalationOtherError.hidden = true;
        e.escalationNote.removeAttribute("aria-invalid");
        e.escalationNote.removeAttribute("aria-describedby");
        this._updateEscalationReasonState();
      });
      e.escalationNote.addEventListener("input", () => {
        if (e.escalationNote.value.trim()) {
          e.escalationOtherError.hidden = true;
          e.escalationNote.removeAttribute("aria-invalid");
          e.escalationNote.removeAttribute("aria-describedby");
        }
      });
      e.languageSelect.addEventListener("change", () => this.setAttribute("lang", e.languageSelect.value));
      e.person.addEventListener("click", () => this._openEscalation());
      e.accommodationOpen.addEventListener("click", () => this._openAccommodation());
      e.screenShareStart.addEventListener("click", () => this._startScreenShare());
      e.screenContextStart.addEventListener("click", () => this._sharePageContext());
      e.screenShareStop.addEventListener("click", () => this._stopScreenShare());
      e.microphone.addEventListener("click", () => this._startVoiceInput());
      e.voiceCommand.addEventListener("click", () => this._startVoiceCommand());
      e.voiceGuide.addEventListener("click", () => this._loadVoiceGuide());
      e.stopVoice.addEventListener("click", () => this._stopVoice());
      e.readBack.addEventListener("click", () => this._speakText(e.input.value, this._pack.lang, e.voiceStatus));
      e.escalation.addEventListener("submit", (event) => this._submitEscalation(event));
      e.checkTutorReply.addEventListener("click", () => this._checkTutorReply());
      e.ticketDataSelect.addEventListener("change", () => { e.ticketDataStatus.textContent = ""; });
      e.exportTicketData.addEventListener("click", () => this._exportLearnerTicket());
      e.deleteTicketData.addEventListener("click", () => this._deleteLearnerTicket());
      e.clearLocalData.addEventListener("click", () => this._clearLocalData());
      e.accommodationForm.addEventListener("submit", (event) => this._submitAccommodation(event));
      e.accommodationJob.addEventListener("change", () => this._populateAccommodationOptions());
      this._escapeHandler = (event) => {
        if (e.panel.hidden) return;
        if (event.key === "Escape") {
          event.preventDefault();
          this._close();
          return;
        }
        if (event.key !== "Tab") return;
        const focusable = this._focusablePanelElements();
        if (!focusable.length) {
          event.preventDefault();
          e.title.focus();
          return;
        }
        const active = this.shadowRoot.activeElement;
        const activeIndex = focusable.indexOf(active);
        if (event.shiftKey && (activeIndex <= 0 || activeIndex === -1)) {
          event.preventDefault();
          focusable[focusable.length - 1].focus();
        } else if (!event.shiftKey && (activeIndex === focusable.length - 1 || activeIndex === -1)) {
          event.preventDefault();
          focusable[0].focus();
        }
      };
      this._shortcutHandler = (event) => {
        if (event.altKey && event.shiftKey && event.key.toLowerCase() === "a") {
          event.preventDefault();
          if (e.panel.hidden) this._open();
          else this._close();
        }
      };
      document.addEventListener("keydown", this._escapeHandler);
      document.addEventListener("keydown", this._shortcutHandler);
    }

    _restore() {
      try {
        const saved = JSON.parse(localStorage.getItem(this._storageKey) || "[]");
        if (Array.isArray(saved)) {
          this._messages = saved.filter((m) => m && typeof m.text === "string").slice(-200);
        }
      } catch {
        this._messages = [];
      }
    }

    _restorePendingTutorTicket() {
      try {
        this._pendingTutorTicketId = localStorage.getItem(this._pendingTutorKey) || "";
      } catch {
        this._pendingTutorTicketId = "";
      }
      this._els.checkTutorReply.hidden = !this._pendingTutorTicketId;
    }

    _restoreLearnerTickets() {
      try {
        const saved = JSON.parse(localStorage.getItem(`${this._storageKey}:learner-tickets`) || "[]");
        if (Array.isArray(saved)) {
          this._learnerTickets = saved.filter((ticket) =>
            ticket && typeof ticket.ticketId === "string" && typeof ticket.accessToken === "string"
          );
        }
      } catch {
        this._learnerTickets = [];
      }
      this._renderLearnerTickets();
    }

    _rememberLearnerTicket(result) {
      if (typeof result.ticketId !== "string" || !result.ticketId ||
          typeof result.accessToken !== "string" || !result.accessToken) {
        throw new Error("Learner ticket credentials were missing.");
      }
      this._learnerTickets = [
        { ticketId: result.ticketId, accessToken: result.accessToken },
        ...this._learnerTickets.filter((ticket) => ticket.ticketId !== result.ticketId)
      ];
      try {
        localStorage.setItem(`${this._storageKey}:learner-tickets`, JSON.stringify(this._learnerTickets));
      } catch { /* Keep ticket management available for this page session. */ }
      this._renderLearnerTickets();
    }

    _renderLearnerTickets() {
      const e = this._els;
      if (!e?.ticketData) return;
      if (!this._pack) {
        e.ticketData.hidden = true;
        return;
      }
      const selectedId = e.ticketDataSelect.value || this._learnerTickets[0]?.ticketId;
      e.ticketDataSelect.replaceChildren();
      for (const [index, ticket] of this._learnerTickets.entries()) {
        const option = document.createElement("option");
        option.value = ticket.ticketId;
        option.textContent = this._pack.strings.ticketRequestLabel
          .replace("{number}", String(index + 1))
          .replace("{code}", ticket.ticketId.slice(-6));
        e.ticketDataSelect.append(option);
      }
      if (this._learnerTickets.some((ticket) => ticket.ticketId === selectedId)) {
        e.ticketDataSelect.value = selectedId;
      }
      e.ticketData.hidden = this._learnerTickets.length === 0;
    }

    _selectedLearnerTicket() {
      return this._learnerTickets.find((ticket) => ticket.ticketId === this._els.ticketDataSelect.value);
    }

    async _exportLearnerTicket() {
      const e = this._els;
      const ticket = this._selectedLearnerTicket();
      if (!ticket) return;
      e.exportTicketData.disabled = true;
      e.ticketDataStatus.textContent = "";
      try {
        const base = (this.getAttribute("api") || location.origin).replace(/\/$/, "");
        const response = await fetch(`${base}/api/v1/escalations/${encodeURIComponent(ticket.ticketId)}/data`, {
          headers: { "X-Learner-Token": ticket.accessToken }
        });
        if (!response.ok) throw new Error("Ticket export failed.");
        const blob = new Blob([JSON.stringify(await response.json(), null, 2)], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = `tutor-request-${ticket.ticketId}.json`;
        link.hidden = true;
        document.body.append(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      } catch {
        e.ticketDataStatus.textContent = this._pack.strings.ticketDataFailed;
      } finally {
        e.exportTicketData.disabled = false;
      }
    }

    async _deleteLearnerTicket() {
      const e = this._els;
      const ticket = this._selectedLearnerTicket();
      if (!ticket || !window.confirm(this._pack.strings.ticketDataDeleteConfirm)) return;
      e.deleteTicketData.disabled = true;
      e.ticketDataStatus.textContent = "";
      try {
        const base = (this.getAttribute("api") || location.origin).replace(/\/$/, "");
        const response = await fetch(`${base}/api/v1/escalations/${encodeURIComponent(ticket.ticketId)}/data`, {
          method: "DELETE",
          headers: { "X-Learner-Token": ticket.accessToken }
        });
        if (!response.ok) throw new Error("Ticket deletion failed.");
        this._learnerTickets = this._learnerTickets.filter((item) => item.ticketId !== ticket.ticketId);
        try {
          localStorage.setItem(`${this._storageKey}:learner-tickets`, JSON.stringify(this._learnerTickets));
        } catch { /* The current page still reflects the deletion. */ }
        if (this._pendingTutorTicketId === ticket.ticketId) {
          this._pendingTutorTicketId = "";
          try { localStorage.removeItem(this._pendingTutorKey); } catch { /* Ignore unavailable storage. */ }
          e.checkTutorReply.hidden = true;
        }
        this._renderLearnerTickets();
        e.ticketDataStatus.textContent = this._pack.strings.ticketDataDeleted;
      } catch {
        e.ticketDataStatus.textContent = this._pack.strings.ticketDataFailed;
      } finally {
        e.deleteTicketData.disabled = false;
      }
    }

    _clearLocalData() {
      const e = this._els;
      if (!window.confirm(this._pack.strings.clearLocalDataConfirm)) return;
      try {
        const keys = Object.keys(localStorage).filter((key) =>
          key === this._storageKey || key.startsWith(`${this._storageKey}:`)
        );
        for (const key of keys) localStorage.removeItem(key);
      } catch {
        e.escalationStatus.textContent = this._pack.strings.clearLocalDataFailed;
        return;
      }
      this._messages = [];
      this._learnerTickets = [];
      this._pendingTutorTicketId = "";
      this._voiceCommandDraft = null;
      this._voiceActionQueue = [];
      this._textScale = 1;
      this._contrastMode = false;
      this._applyAccessibilityPreferences(false);
      try { localStorage.removeItem(this._voiceDraftKey); localStorage.removeItem(this._voiceQueueKey); } catch { /* Existing clear operation removed all assistant keys. */ }
      e.checkTutorReply.hidden = true;
      e.escalationStatus.textContent = this._pack.strings.clearLocalDataDone;
      e.questionQueueStatus.textContent = "";
      this._renderMessages();
      this._renderLearnerTickets();
      this._renderQuestionQueue();
    }

    _save() {
      try {
        localStorage.setItem(this._storageKey, JSON.stringify(this._messages));
      } catch {
        /* Storage may be unavailable or quota exceeded. */
      }
    }

    _renderMessages() {
      if (!this._els) return;
      this._els.log.replaceChildren();
      for (const message of this._messages) {
        this._appendMessage(message, false);
      }
    }

    _appendMessage(message, persist = true) {
      const lang = message.lang || this._pack?.lang || "en";
      const isTutor = message.role === "tutor";
      const isAssistant = message.role === "assistant" || isTutor;
      const div = document.createElement("div");
      div.className = `message ${isAssistant || isTutor ? "message-assistant" : "message-user"}`;
      if (message.answerStatus) div.dataset.answerStatus = message.answerStatus;
      div.dir = "auto";
      div.lang = lang;

      const author = document.createElement("div");
      author.className = "message-author";
      const authorName = isTutor
        ? (this._pack?.strings.tutor || (lang === "am" ? am.strings.tutor : en.strings.tutor))
        : isAssistant
        ? (this._pack?.strings.assistant || (lang === "am" ? am.strings.assistant : en.strings.assistant))
        : (this._pack?.strings.you || (lang === "am" ? am.strings.you : en.strings.you));
      author.textContent = authorName;
      div.appendChild(author);

      const timestamp = message.timestamp || new Date().toISOString();
      const time = document.createElement("time");
      time.className = "message-time";
      time.dateTime = timestamp;
      try {
        const calendarLocale = lang === "am" ? "am-ET-u-ca-ethiopic" : lang;
        time.textContent = new Intl.DateTimeFormat(calendarLocale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(timestamp));
      } catch { time.textContent = new Date(timestamp).toLocaleString(); }
      div.appendChild(time);

      const content = document.createElement("div");
      content.className = "message-body";
      content.textContent = message.text;
      div.appendChild(content);

      const strings = this._pack?.strings || en.strings;
      const evidenceText = message.answerStatus === "not_found"
        ? strings.notFoundEvidence
        : message.cachedCourseContent
          ? strings.cachedAnswerEvidence
          : "";
      if (isAssistant && evidenceText) {
        const evidence = document.createElement("p");
        evidence.className = "evidence-label";
        evidence.textContent = evidenceText;
        div.appendChild(evidence);
      }

      if (isAssistant) {
        const answerActions = document.createElement("div");
        answerActions.className = "answer-actions";
        const copy = document.createElement("button");
        copy.type = "button";
        copy.className = "secondary copy-answer";
        copy.textContent = strings.copyAnswer || en.strings.copyAnswer;
        const actionLanguage = this._pack?.lang === "en" || this._pack?.localizedStrings?.includes("copyAnswer")
          ? this._pack.lang
          : "en";
        copy.lang = actionLanguage;
        const copyStatus = document.createElement("p");
        copyStatus.className = "answer-copy-status";
        copyStatus.setAttribute("role", "status");
        copyStatus.setAttribute("aria-live", "polite");
        copyStatus.setAttribute("aria-atomic", "true");
        copyStatus.lang = actionLanguage;
        copyStatus.dir = actionLanguage === "ar" ? "rtl" : "ltr";
        copy.addEventListener("click", async () => {
          copy.disabled = true;
          copyStatus.textContent = "";
          if (typeof navigator.clipboard?.writeText !== "function") {
            copyStatus.textContent = strings.copyAnswerFailed || en.strings.copyAnswerFailed;
            copy.disabled = false;
            return;
          }
          try {
            await navigator.clipboard.writeText(content.textContent || "");
            copyStatus.textContent = strings.answerCopied || en.strings.answerCopied;
          } catch {
            copyStatus.textContent = strings.copyAnswerFailed || en.strings.copyAnswerFailed;
          } finally {
            copy.disabled = false;
          }
        });
        const listen = document.createElement("button");
        listen.type = "button";
        listen.className = "secondary listen-button";
        listen.textContent = this._pack?.strings.listen || (lang === "am" ? am.strings.listen : en.strings.listen);
        listen.lang = actionLanguage;
        const listenStatus = document.createElement("p");
        listenStatus.className = "voice-status";
        listenStatus.setAttribute("role", "status");
        listenStatus.setAttribute("aria-live", "polite");
        listen.addEventListener("click", () => this._speakText(content.textContent, lang, listenStatus));
        answerActions.append(copy, listen);
        div.append(answerActions, copyStatus, listenStatus);
      }

      const links = Array.isArray(message.links)
        ? message.links
        : (message.linkUrl && message.linkTitle ? [{ url: message.linkUrl, title: message.linkTitle }] : []);
      for (const source of isAssistant ? links : []) {
        if (!source?.url || !source?.title) continue;
        const link = document.createElement("a");
        link.className = "course-link";
        link.href = source.url;
        const prefix = this._pack?.strings.readInCourse || (lang === "am" ? am.strings.readInCourse : en.strings.readInCourse);
        link.textContent = `${prefix}: ${source.title}`;
        div.appendChild(link);
      }

      if (isAssistant && message.type !== "system") {
        if (message.answerStatus !== "not_found" && (message.links?.length || message.linkUrl)) {
          const save = document.createElement("button");
          save.type = "button";
          save.className = "secondary study-pack-button";
          const saved = this._studyPack.some((item) => item.id === this._studyCardId(message));
          save.textContent = strings[saved ? "removeFromReview" : "saveForReview"];
          save.setAttribute("aria-pressed", saved ? "true" : "false");
          save.dataset.studyCardId = this._studyCardId(message);
          save.addEventListener("click", () => this._toggleStudyCard(message));
          div.append(save);
        }
        const feedback = document.createElement("div");
        feedback.className = "voice-controls";
        for (const reason of ["unhelpful", "incorrect"]) {
          const button = document.createElement("button");
          button.type = "button";
          button.className = "secondary";
          button.textContent = reason === "incorrect" ? strings.feedbackIncorrect : strings.feedbackUnhelpful;
          button.addEventListener("click", async () => {
            button.disabled = true;
            try {
              const base = (this.getAttribute("api") || location.origin).replace(/\/$/, "");
              const response = await fetch(`${base}/api/v1/answer-feedback`, {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ kind: links.length ? "source" : "answer", reason, sourceUrl: links[0]?.url || "" })
              });
              if (!response.ok) throw new Error("Feedback could not be sent.");
              feedbackStatus.textContent = strings.feedbackSent;
              for (const option of feedback.querySelectorAll("button")) option.disabled = true;
            } catch {
              feedbackStatus.textContent = strings.feedbackFailed;
              button.disabled = false;
            }
          });
          feedback.append(button);
        }
        const feedbackStatus = document.createElement("p");
        feedbackStatus.setAttribute("role", "status");
        feedbackStatus.setAttribute("aria-live", "polite");
        feedback.append(feedbackStatus);
        div.append(feedback);
      }

      const showDebug = isDebugMode() || this.hasAttribute("debug");
      if (isAssistant && showDebug && typeof message.score === "number") {
        const debug = document.createElement("div");
        debug.className = "debug-score";
        debug.textContent = `[debug] match score: ${message.score.toFixed(4)}`;
        div.appendChild(debug);
      }

      const needsHumanHelp = ["not_found", "off_topic", "refused"].includes(message.answerStatus);
      if (isAssistant && (message.showPerson || needsHumanHelp)) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "person-action";
        btn.textContent = this._pack?.strings.person || (lang === "am" ? am.strings.person : en.strings.person);
        btn.addEventListener("click", () => this._openEscalation());
        div.appendChild(btn);
      }

      this._els.log.appendChild(div);
      this._renderStudyPack();
      this._els.log.scrollTop = this._els.log.scrollHeight;
      if (persist) {
        const announcement = message.role === "user"
          ? `${this._pack?.strings.questionSubmitted || en.strings.questionSubmitted}: ${message.text}`
          : `${authorName}: ${message.text}`;
        this._announce(announcement);
      }

      if (persist) {
        this._messages.push({
          role: message.role || "user",
          type: message.type || "lesson",
          text: message.text,
          lang: message.lang || this._pack?.lang || "en",
          timestamp,
          linkUrl: message.linkUrl,
          linkTitle: message.linkTitle,
          links: message.links,
          sectionId: message.sectionId,
          ticketId: message.ticketId,
          score: message.score,
          showPerson: message.showPerson,
          cachedCourseContent: message.cachedCourseContent,
          answerStatus: message.answerStatus
        });
        this._save();
      }
    }

    _studyCardId(message) {
      return `${message.sectionId || message.linkUrl || message.links?.[0]?.url || "answer"}:${message.lang || "en"}`;
    }

    _toggleStudyCard(message, cardId = this._studyCardId(message), fromStudyCard = false) {
      const id = cardId;
      const index = this._studyPack.findIndex((item) => item.id === id);
      const strings = this._pack?.strings || en.strings;
      if (index >= 0) {
        this._studyPack.splice(index, 1);
        this._els.studyPackStatus.textContent = strings.studyPackRemoved;
      } else {
        this._studyPack.push({ id, text: message.text, lang: message.lang || "en", title: message.linkTitle || "", url: message.linkUrl || message.links?.[0]?.url || "", savedAt: new Date().toISOString() });
        this._els.studyPackStatus.textContent = strings.studyPackSaved;
      }
      try { localStorage.setItem(this._studyPackKey, JSON.stringify(this._studyPack)); } catch { this._els.studyPackStatus.textContent = strings.clearLocalDataFailed; }
      for (const button of this._els.log.querySelectorAll("button[data-study-card-id]")) {
        if (button.dataset.studyCardId !== id) continue;
        const saved = this._studyPack.some((item) => item.id === id);
        button.textContent = strings[saved ? "removeFromReview" : "saveForReview"];
        button.setAttribute("aria-pressed", saved ? "true" : "false");
      }
      this._renderStudyPack();
      if (fromStudyCard) this._els.studyPackHeading.focus();
    }

    _renderStudyPack() {
      if (!this._els?.studyPack) return;
      const e = this._els;
      const strings = this._pack?.strings || en.strings;
      e.studyPack.hidden = this._studyPack.length === 0;
      e.studyPackHeading.textContent = strings.studyPackTitle;
      e.studyPackList.replaceChildren();
      e.studyPackExport.hidden = this._studyPack.length === 0;
      e.studyPackExport.textContent = strings.studyPackExport;
      if (!this._studyPack.length) return;
      for (const item of this._studyPack) {
        const card = document.createElement("article");
        card.className = "study-card";
        const title = document.createElement("strong");
        title.textContent = item.title || strings.assistant;
        const body = document.createElement("p");
        body.lang = item.lang || "en";
        body.dir = "auto";
        body.textContent = item.text;
        card.append(title, body);
        if (item.url) {
          const link = document.createElement("a");
          link.href = item.url;
          link.textContent = `${strings.readInCourse}: ${item.title || strings.assistant}`;
          card.append(link);
        }
        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "secondary";
        remove.textContent = strings.removeFromReview;
        remove.addEventListener("click", () => this._toggleStudyCard(item, item.id, true));
        card.append(remove);
        e.studyPackList.append(card);
      }
    }

    _exportStudyPack() {
      if (!this._studyPack.length) return;
      const text = this._studyPack.map((item) => `${item.title || "Study note"}\n${item.text}${item.url ? `\nSource: ${item.url}` : ""}`).join("\n\n---\n\n");
      const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = "offline-study-pack.txt";
      link.click();
      URL.revokeObjectURL(url);
    }

    async _loadI18n() {
      const requested = (this.getAttribute("lang") || "en").toLowerCase();
      const token = ++this._loadToken;
      const readPack = async (code) => {
        try {
          const response = await fetch(new URL(`${code}.json`, i18nBase));
          if (!response.ok) throw new Error(`Locale ${code} returned HTTP ${response.status}`);
          const result = await response.json();
          if (!result?.strings || result.lang !== code) throw new Error(`Locale ${code} is invalid`);
          try { localStorage.setItem(`${this._storageKey}:i18n:${code}`, JSON.stringify(result)); } catch { /* Storage may be disabled or full. */ }
          return result;
        } catch (error) {
          let cached;
          try { cached = JSON.parse(localStorage.getItem(`${this._storageKey}:i18n:${code}`) || "null"); } catch { /* Ignore unavailable storage. */ }
          if (cached?.strings && cached.lang === code) return cached;
          throw error;
        }
      };
      let pack;
      let english;
      this._translationUnavailable = false;
      try {
        [pack, english] = await Promise.all([readPack(requested), readPack("en")]);
      } catch (error) {
        console.error("Could not load assistant locale:", error);
        return;
      }
      if (token !== this._loadToken) return;
      const missingStrings = Object.keys(english.strings).filter((key) => !pack.strings?.[key]);
      this._englishStrings = english.strings;
      this._applyPack({
        ...pack,
        lang: requested,
        strings: { ...english.strings, ...(pack.strings || {}) },
        localizedStrings: Object.keys(pack.strings || {}),
        incomplete: pack.incomplete === true || missingStrings.length > 0
      });
    }

    _applyPack(pack) {
      this._pack = pack;
      this.dir = pack.dir || "ltr";
      const s = pack.strings;
      const e = this._els;
      const write = (node, key) => {
        node.textContent = s[key] || "";
        node.lang = pack.lang;
      };
      write(e.launcher, "launcher");
      e.launcher.setAttribute("aria-label", s.launcher || "Open learning assistant");
      e.launcher.title = s.launcher || "Open learning assistant";
      write(e.title, "dialogTitle");
      write(e.close, "close");
      write(e.person, "person");
      write(e.accessibilityLabel, "accessibilityOptions");
      write(e.textSizeLabel, "textSize");
      e.panelInstructions.textContent = s.panelInstructions || en.strings.panelInstructions;
      e.panelInstructions.lang = pack.lang;
      e.contrastToggle.setAttribute("aria-label", s.highContrast || en.strings.highContrast);
      e.textDecrease.setAttribute("aria-label", s.textSizeSmaller || en.strings.textSizeSmaller);
      e.textReset.setAttribute("aria-label", s.textSizeDefault || en.strings.textSizeDefault);
      e.textIncrease.setAttribute("aria-label", s.textSizeLarger || en.strings.textSizeLarger);
      write(e.accommodationOpen, "accommodationButton");
      write(e.languageLabel, "language");
      e.localeStatus.textContent = pack.incomplete ? (s.translationIncomplete || s.translationUnavailable || "") : "";
      e.localeStatus.lang = pack.lang;
      e.localeStatus.hidden = !e.localeStatus.textContent;
      write(e.greeting, "greeting");
      if (this._translationUnavailable) e.greeting.textContent += ` ${s.translationUnavailable || en.strings.translationUnavailable}`;
      write(e.label, "questionLabel");
      e.questionHelp.textContent = s.questionHelp || en.strings.questionHelp;
      e.questionHelp.lang = pack.lang;
      write(e.cloudConsentLabel, "cloudConsent");
      write(e.send, "ask");
      write(e.microphone, "microphone");
      e.microphone.setAttribute("aria-label", s.microphone);
      e.microphone.lang = pack.lang;
      write(e.voiceCommand, "voiceCommand");
      e.voiceCommand.setAttribute("aria-label", s.voiceCommand || en.strings.voiceCommand);
      e.voiceCommand.lang = pack.lang;
      write(e.voiceGuide, "voiceGuide");
      e.voiceGuide.lang = pack.lang;
      write(e.voiceHelp, "speechLimitations");
      write(e.stopVoice, "stop");
      write(e.readBack, "readBack");
      write(e.voiceNoteLabel, "voiceNote");
      write(e.voiceTranscriptLabel, "transcript");
      e.voiceTranscriptText.lang = pack.lang;
      write(e.escalationReasonLabel, "escalationReasonLabel");
      const reasonOptions = [
        ["", "escalationReasonChoose"],
        ["answer_not_found", "escalationReasonAnswerNotFound"],
        ["learner_requested_person", "escalationReasonPerson"],
        ["answer_flagged_incorrect", "escalationReasonIncorrect"],
        ["other", "escalationReasonOther"]
      ];
      for (const [value, key] of reasonOptions) {
        const option = e.escalationReason.querySelector(`option[value="${value}"]`);
        write(option, key);
        option.lang = pack.lang;
      }
      write(e.escalationReasonError, "escalationReasonRequired");
      write(e.escalationOtherError, "escalationOtherRequired");
      write(e.escalationPhoneLabel, "phoneLabel");
      write(e.consentLabel, "consent");
      write(e.sendEscalation, "sendEscalation");
      write(e.tutorAvailability, "tutorAvailability");
      write(e.checkTutorReply, "checkTutorReply");
      write(e.ticketDataTitle, "ticketDataTitle");
      write(e.ticketDataLabel, "ticketDataLabel");
      write(e.ticketDataNote, "ticketDataNote");
      write(e.exportTicketData, "exportTicketData");
      write(e.deleteTicketData, "deleteTicketData");
      write(e.clearLocalData, "clearLocalData");
      write(e.screenShareTitle, "screenShareTitle");
      write(e.screenShareNote, "screenShareNote");
      write(e.screenShareConsentLabel, "screenShareConsent");
      write(e.screenShareStart, "screenShareStart");
      write(e.screenScreenshotLabel, "screenScreenshot");
      write(e.screenContextStart, "screenContextStart");
      write(e.screenShareStop, "screenShareStop");
      e.screenShareBarText.textContent = s.screenShareOn || "";
      e.screenShareBarText.lang = pack.lang;
      write(e.accommodationPrivacy, "accommodationPrivacy");
      write(e.accommodationJobLabel, "whichJob");
      write(e.accommodationChoiceLabel, "whichAccommodation");
      write(e.accommodationNoteLabel, "accommodationNote");
      write(e.accommodationSend, "sendAccommodation");
      e.input.lang = pack.lang;
      e.input.placeholder = s.questionPlaceholder || "";
      e.panel.lang = pack.lang;
      e.panel.dir = pack.dir || "ltr";
      e.launcher.disabled = false;
      e.languageSelect.value = pack.lang;
      e.checkTutorReply.hidden = !this._pendingTutorTicketId;
      this._updateEscalationReasonState();
      this._renderLearnerTickets();
      this._populateAccommodationChoices();
      if (this._errorKey) this._setError(this._errorKey);
      this._renderMessages();
      this._renderStudyPack();
      this._renderQuestionQueue();
      this._renderLessonSuggestions();
      this._applyAccessibilityPreferences(false);
      this._emit("ready", { lang: pack.lang, dir: this.dir });
    }

    _open() {
      if (!this._pack || !this._els.panel.hidden) return;
      this._focusBeforeOpen = this.shadowRoot.activeElement || document.activeElement;
      this._els.panel.hidden = false;
      this._els.launcher.setAttribute("aria-expanded", "true");
      this._els.title.focus();
      this._announce(this._pack.strings.dialogOpened || en.strings.dialogOpened);
      this._emit("open", {});
    }

    _close() {
      if (this._els.panel.hidden) return;
      this._els.panel.hidden = true;
      this._els.launcher.setAttribute("aria-expanded", "false");
      this._announce(this._pack?.strings.dialogClosed || en.strings.dialogClosed);
      this._emit("close", {});
      const returnFocus = this._focusBeforeOpen?.isConnected && this._focusBeforeOpen !== this._els.panel
        ? this._focusBeforeOpen
        : this._els.launcher;
      this._focusBeforeOpen = null;
      returnFocus.focus?.();
    }

    _readQuestionQueue() {
      try {
        const queue = JSON.parse(localStorage.getItem(this._queueKey) || "[]");
        if (!Array.isArray(queue)) return [];
        const validQueue = queue.filter((item) => item && typeof item.question === "string");
        const normalized = validQueue
          .map((item) => ({
            ...item,
            id: typeof item.id === "string" ? item.id : this._newQuestionQueueId(),
            status: item.status === "retry-failed" ? "retry-failed" : "waiting"
          }));
        if (normalized.length !== queue.length || normalized.some((item, index) => item.id !== queue[index]?.id)) {
          this._writeQuestionQueue(normalized);
        }
        return normalized;
      } catch {
        if (this._els?.questionQueueStatus) {
          this._els.questionQueueStatus.textContent = this._pack?.strings.offlineQueueStorageFailed || en.strings.offlineQueueStorageFailed;
        }
        return [];
      }
    }

    _writeQuestionQueue(queue) {
      try {
        localStorage.setItem(this._queueKey, JSON.stringify(queue));
        return true;
      } catch {
        return false;
      }
    }

    _newQuestionQueueId() {
      return globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    }

    _renderQuestionQueue() {
      if (!this._els) return;
      const { questionQueue, questionQueueHeading, questionQueueList } = this._els;
      const strings = this._pack?.strings || en.strings;
      const queue = this._readQuestionQueue();
      questionQueue.hidden = queue.length === 0;
      questionQueueHeading.textContent = `${strings.offlineQueueTitle} (${queue.length})`;
      questionQueueList.replaceChildren();

      for (const queued of queue) {
        const row = document.createElement("li");
        row.className = "queue-item";

        const question = document.createElement("p");
        question.className = "queue-question";
        question.dir = "auto";
        question.textContent = queued.question;

        const status = document.createElement("p");
        status.className = "queue-status";
        status.setAttribute("role", "status");
        status.setAttribute("aria-live", "polite");
        status.textContent = this._retryingQuestionIds.has(queued.id)
          ? strings.offlineQueueRetrying
          : queued.status === "retry-failed" ? strings.offlineQueueRetryFailed : strings.offlineQueueWaiting;

        const actions = document.createElement("div");
        actions.className = "queue-actions";
        const editing = this._retryingQuestionIds.has(queued.id);
        const edit = document.createElement("button");
        edit.type = "button";
        edit.className = "secondary";
        edit.textContent = strings.offlineQueueEdit;
        edit.disabled = editing;

        const retry = document.createElement("button");
        retry.type = "button";
        retry.className = "secondary";
        retry.textContent = strings.offlineQueueRetry;
        retry.disabled = editing;

        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "secondary";
        remove.textContent = strings.offlineQueueRemove;
        remove.disabled = editing;

        const editor = document.createElement("form");
        editor.className = "queue-editor";
        editor.hidden = true;
        const label = document.createElement("label");
        const input = document.createElement("textarea");
        input.id = `queued-question-${queued.id}`;
        input.value = queued.question;
        input.dir = "auto";
        label.htmlFor = input.id;
        label.textContent = strings.offlineQueueEditLabel;
        const editorActions = document.createElement("div");
        editorActions.className = "queue-actions";
        const save = document.createElement("button");
        save.type = "submit";
        save.className = "secondary";
        save.textContent = strings.offlineQueueSave;
        const cancel = document.createElement("button");
        cancel.type = "button";
        cancel.className = "secondary";
        cancel.textContent = strings.offlineQueueCancel;
        editorActions.append(save, cancel);
        editor.append(label, input, editorActions);

        edit.addEventListener("click", () => {
          editor.hidden = false;
          input.focus();
        });
        cancel.addEventListener("click", () => {
          editor.hidden = true;
          edit.focus();
        });
        editor.addEventListener("submit", (event) => {
          event.preventDefault();
          const revised = input.value.trim();
          if (!revised) {
            status.textContent = strings.errorEmpty;
            input.focus();
            return;
          }
          const latest = this._readQuestionQueue();
          const current = latest.find((item) => item.id === queued.id);
          if (!current) return;
          current.question = revised;
          current.status = "waiting";
          if (!this._writeQuestionQueue(latest)) {
            status.textContent = strings.offlineQueueStorageFailed;
            return;
          }
          this._els.questionQueueStatus.textContent = strings.offlineQueueSaved;
          this._renderQuestionQueue();
        });
        retry.addEventListener("click", () => this._retryQueuedQuestion(queued.id));
        remove.addEventListener("click", () => this._removeQueuedQuestion(queued.id));

        actions.append(edit, retry, remove);
        row.append(question, status, actions, editor);
        questionQueueList.append(row);
      }
    }

    _removeQueuedQuestion(id) {
      if (this._retryingQuestionIds.has(id)) return;
      const strings = this._pack?.strings || en.strings;
      const queue = this._readQuestionQueue();
      const remaining = queue.filter((item) => item.id !== id);
      if (remaining.length === queue.length) return;
      if (!this._writeQuestionQueue(remaining)) {
        this._els.questionQueueStatus.textContent = strings.offlineQueueStorageFailed;
        return;
      }
      this._renderQuestionQueue();
    }

    async _retryQueuedQuestion(id) {
      if (this._retryingQuestionIds.has(id)) return false;
      const strings = this._pack?.strings || en.strings;
      const queued = this._readQuestionQueue().find((item) => item.id === id);
      if (!queued) return false;
      if (!navigator.onLine) {
        queued.status = "retry-failed";
        const queue = this._readQuestionQueue().map((item) => item.id === id ? queued : item);
        if (!this._writeQuestionQueue(queue)) {
          this._els.questionQueueStatus.textContent = strings.offlineQueueStorageFailed;
        }
        this._renderQuestionQueue();
        return false;
      }

      this._retryingQuestionIds.add(id);
      this._renderQuestionQueue();
      const result = await this._askServer(queued.question, queued.language, queued.externalAiConsent === true);
      this._retryingQuestionIds.delete(id);

      const queue = this._readQuestionQueue();
      const index = queue.findIndex((item) => item.id === id);
      let queueUpdated = true;
      if (index >= 0) {
        if (result.ok) queue.splice(index, 1);
        else queue[index].status = "retry-failed";
        queueUpdated = this._writeQuestionQueue(queue);
      }
      if (!queueUpdated) this._els.questionQueueStatus.textContent = strings.offlineQueueStorageFailed;
      else if (result.ok) this._els.questionQueueStatus.textContent = strings.offlineQueueSent;
      else if (index >= 0) this._els.questionQueueStatus.textContent = strings.offlineQueueRetryFailed;
      this._renderQuestionQueue();
      return result.ok && queueUpdated;
    }

    async _loadAssistantConfig() {
      const token = ++this._assistantConfigToken;
      const base = (this.getAttribute("api") || location.origin).replace(/\/$/, "");
      try {
        const response = await fetch(`${base}/api/v1/config`);
        if (!response.ok || token !== this._assistantConfigToken) return;
        const config = await response.json();
        if (token !== this._assistantConfigToken) return;
        this._cloudConsentRequired = config.externalAiConsentRequired === true;
        this._els.cloudConsentRow.hidden = !this._cloudConsentRequired;
        if (!this._cloudConsentRequired) this._els.cloudConsent.checked = false;
      } catch {
        if (token !== this._assistantConfigToken) return;
        this._cloudConsentRequired = false;
        this._els.cloudConsentRow.hidden = true;
        this._els.cloudConsent.checked = false;
      }
    }

    async _askServer(question, language, externalAiConsent = false) {
      const base = (this.getAttribute("api") || location.origin).replace(/\/$/, "");
      try {
        const response = await fetch(`${base}/api/v1/ask`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ question, language, externalAiConsent })
        });
        if (!response.ok) return { ok: false, retryable: response.status >= 500 || response.status === 408 || response.status === 429 };
        const result = await response.json();
        if (typeof result.answer !== "string" || !result.answer.trim()) return { ok: false, retryable: true };
        const links = Array.isArray(result.sources)
          ? result.sources.filter((source) => typeof source?.url === "string" && source.url)
            .map((source) => ({ url: source.url, title: source.title || source.type || "Source" }))
          : [];
        this._appendMessage({ role: "assistant", text: result.answer, lang: language,
          links, answerStatus: result.answerStatus,
          showPerson: ["not_found", "off_topic"].includes(result.answerStatus) });
        return { ok: true, retryable: false };
      } catch { return { ok: false, retryable: true }; }
    }

    _createHostAnswerWaiter(requestId) {
      let resolveAnswer;
      const promise = new Promise((resolve) => { resolveAnswer = resolve; });
      const waiter = {
        resolve: resolveAnswer,
        timer: setTimeout(() => {
          if (this._hostAnswerWaiters.get(requestId) !== waiter) return;
          this._hostAnswerWaiters.delete(requestId);
          resolveAnswer(null);
        }, 10000)
      };
      this._hostAnswerWaiters.set(requestId, waiter);
      return {
        promise,
        cancel: () => {
          if (this._hostAnswerWaiters.get(requestId) !== waiter) return;
          clearTimeout(waiter.timer);
          this._hostAnswerWaiters.delete(requestId);
          resolveAnswer(null);
        }
      };
    }

    _handleHostAnswer(event) {
      const detail = event.detail && typeof event.detail === "object" ? event.detail : {};
      const requestId = typeof detail.requestId === "string" ? detail.requestId : "";
      const waiter = requestId ? this._hostAnswerWaiters.get(requestId) : null;
      if (!waiter) return;
      clearTimeout(waiter.timer);
      this._hostAnswerWaiters.delete(requestId);
      waiter.resolve(detail);
    }

    _appendHostAnswer(detail, language, requestId) {
      if (!detail || detail.error) {
        this._emit("error", { code: "host-answer-failed", requestId });
        return false;
      }
      const text = typeof detail.answer === "string" ? detail.answer.trim() : "";
      if (!text) {
        this._emit("error", { code: "host-answer-invalid", requestId });
        return false;
      }
      const answerStatus = ["answered", "not_found", "off_topic", "refused"].includes(detail.answerStatus)
        ? detail.answerStatus
        : undefined;
      const links = answerStatus === "not_found"
        ? []
        : Array.isArray(detail.sources)
          ? detail.sources
            .filter((source) => typeof source?.url === "string" && source.url)
            .map((source) => ({ url: source.url, title: source.title || source.type || "Source" }))
          : [];
      this._appendMessage({
        role: "assistant",
        text,
        lang: typeof detail.language === "string" ? detail.language : language,
        links,
        answerStatus,
        showPerson: ["not_found", "off_topic", "refused"].includes(answerStatus)
      });
      return true;
    }

    _queueQuestion(question, language, externalAiConsent) {
      const queue = this._readQuestionQueue();
      const id = this._newQuestionQueueId();
      queue.push({ id, question, language, externalAiConsent, queuedAt: new Date().toISOString(), status: "waiting" });
      if (!this._writeQuestionQueue(queue)) {
        this._els.questionQueueStatus.textContent = this._pack.strings.offlineQueueStorageFailed;
        return null;
      }
      this._renderQuestionQueue();
      return id;
    }

    async _flushQuestionQueue() {
      if (!navigator.onLine || this._flushingQuestionQueue) return;
      this._flushingQuestionQueue = true;
      try {
        const queuedIds = this._readQuestionQueue().map((item) => item.id);
        for (const id of queuedIds) {
          if (!navigator.onLine || !await this._retryQueuedQuestion(id)) break;
        }
      } finally {
        this._flushingQuestionQueue = false;
      }
    }

    _appendOfflineSaved(language) {
      const strings = this._pack?.strings || en.strings;
      this._appendMessage({ role: "assistant", text: strings.offlineSaved || en.strings.offlineSaved, lang: language });
    }

    async _onSubmit(event) {
      event.preventDefault();
      if (this._submittingQuestion) return;
      this._submittingQuestion = true;
      this._els.send.disabled = true;
      this._els.form.setAttribute("aria-busy", "true");
      this._els.send.setAttribute("aria-busy", "true");
      try {
        await this._submitQuestion();
      } finally {
        this._submittingQuestion = false;
        this._els.send.disabled = false;
        this._els.form.removeAttribute("aria-busy");
        this._els.send.removeAttribute("aria-busy");
      }
    }

    async _submitQuestion() {
      const text = this._els.input.value.trim();
      if (!text) {
        this._setError("errorEmpty");
        this._emit("error", { code: "empty-question" });
        this._els.input.focus();
        return;
      }
      this._setError("");
      this._els.input.value = "";

      const currentLang = (this.getAttribute("lang") || "en").toLowerCase();
      const externalAiConsent = this._els.cloudConsent.checked;

      // 1. Append user's question
      this._appendMessage({ role: "user", text, lang: currentLang });
      const requestId = this._newQuestionQueueId();
      const hostAnswer = this._createHostAnswerWaiter(requestId);
      const questionDetail = {
        text,
        language: currentLang,
        input: "text",
        requestId,
        externalAiConsent,
        hostHandled: false
      };
      this._emit("question", questionDetail);
      if (questionDetail.hostHandled) {
        const hostResult = await hostAnswer.promise;
        if (this._appendHostAnswer(hostResult, currentLang, requestId)) return;
      } else {
        hostAnswer.cancel();
      }

      const isOffline = !navigator.onLine;
      let wasQueued = false;
      if (isOffline) {
        wasQueued = Boolean(this._queueQuestion(text, currentLang, externalAiConsent));
      } else {
        const result = await this._askServer(text, currentLang, externalAiConsent);
        if (result.ok) return;
        if (result.retryable) wasQueued = Boolean(this._queueQuestion(text, currentLang, externalAiConsent));
        else this._setError("questionSendFailed");
      }

      // 2. Ensure content and search function are ready
      if (!this._sections || this._sections.length === 0) {
        await this._loadContent();
      }
      if (!this._searchModule) {
        try {
          if (typeof globalThis !== "undefined" && globalThis.DbSearch?.search) {
            this._searchModule = globalThis.DbSearch;
          } else {
            const searchUrl = new URL("./search.js", scriptUrl).href;
            this._searchModule = await import(searchUrl);
          }
        } catch {
          // ignore
        }
      }

      const searchFn = this._searchModule?.search || globalThis.DbSearch?.search;
      const searchResult = searchFn
        ? searchFn(text, this._sections, currentLang)
        : { best: null, others: [] };

      // 3. Process result
      const allMatches = searchResult.best
        ? [searchResult.best, ...(searchResult.others || [])]
        : (searchResult.others || []);
      const threshold = this._searchModule?.THRESHOLD || 0.25;
      const matchingJobs = allMatches.filter((item) => item.section?.type === "job" && item.score >= threshold).slice(0, 5);
      if (matchingJobs.length) {
        for (const match of matchingJobs) {
          const job = match.section;
          const translated = job.translations?.[currentLang];
          const jobTitle = job.titles?.[currentLang] || job.title;
          const description = translated?.description || job.description;
          const accommodations = translated?.accommodations || job.accommodations || [];
          const detail = [
            `${job.employer} · ${job.location} · ${job.remote ? this._pack.strings.jobRemote : this._pack.strings.jobOnSite}`,
            description,
            `${this._pack.strings.jobAccommodations}: ${accommodations.join(", ")}`
          ].join("\n");
          this._appendMessage({
            role: "assistant", type: "job", text: `${jobTitle}\n${detail}`, lang: currentLang,
            linkUrl: job.url, linkTitle: jobTitle, sectionId: job.id, score: match.score,
            cachedCourseContent: true
          });
        }
        if (wasQueued) this._appendOfflineSaved(currentLang);
        return;
      }

      if (searchResult.best) {
        const bestSection = searchResult.best.section;
        const score = searchResult.best.score;
        const strictTranslation = ["ti", "om", "so"].includes(currentLang);
        const fullText = (bestSection.text && (
          bestSection.text[currentLang] || (!strictTranslation && bestSection.text.en)
        )) || "";
        const snippet = getFirstSentences(fullText, 3);

        let linkTitle = bestSection.titles?.[currentLang] || (strictTranslation ? "" : bestSection.title);
        if (currentLang === "am" && !bestSection.titles?.[currentLang]) {
          if (typeof bestSection.title === "object" && bestSection.title.am) {
            linkTitle = bestSection.title.am;
          } else if (AMHARIC_TITLES[bestSection.id]) {
            linkTitle = AMHARIC_TITLES[bestSection.id];
          }
        } else if (!strictTranslation && typeof bestSection.title === "object" && bestSection.title.en) {
          linkTitle = bestSection.title.en;
        }

        this._appendMessage({
          role: "assistant",
          text: snippet,
          lang: currentLang,
          linkUrl: bestSection.url,
          linkTitle,
          sectionId: bestSection.id,
          score,
          showPerson: false,
          cachedCourseContent: true
        });
      } else {
        const hasCourseContext = this._searchModule?.hasCourseContext
          ? this._searchModule.hasCourseContext(searchResult)
          : allMatches.some((match) => match.score > 0);
        const scopeIsKnown = Boolean(searchFn && this._sections.length);
        const answerStatus = scopeIsKnown && !hasCourseContext ? "off_topic" : "not_found";
        const responseText = hasCourseContext
          ? (this._pack?.strings.notFound || (currentLang === "am" ? am.strings.notFound : en.strings.notFound))
          : (this._pack?.strings.offTopic || en.strings.offTopic);
        const topScore = searchResult.others?.[0]?.score || 0;

        if (this._els.person) this._els.person.hidden = false;

        this._appendMessage({
          role: "assistant",
          text: responseText,
          lang: currentLang,
          score: topScore,
          showPerson: true,
          answerStatus
        });
      }
      if (wasQueued) this._appendOfflineSaved(currentLang);
    }

    _setVoiceState(active, mode = "") {
      this._voiceMode = mode;
      const commandMode = mode.startsWith("voice-command");
      this._els.microphone.setAttribute("aria-pressed", active && !commandMode ? "true" : "false");
      this._els.voiceCommand.setAttribute("aria-pressed", active && commandMode ? "true" : "false");
      this._els.stopVoice.hidden = !active;
      this._els.voiceStatus.setAttribute("aria-busy", String(active));
    }

    _setTranscript(text, visible = true) {
      const transcript = typeof text === "string" ? text.trim() : "";
      this._els.voiceTranscriptText.textContent = transcript;
      this._els.voiceTranscript.hidden = !visible || !transcript;
      if (this._voiceCaptionsUrl) URL.revokeObjectURL(this._voiceCaptionsUrl);
      this._voiceCaptionsUrl = "";
      this._els.voiceCaptions.removeAttribute("src");
      const unavailable = transcript === (this._pack?.strings.audioTranscriptUnavailable || en.strings.audioTranscriptUnavailable);
      if (transcript && !unavailable) {
        const cues = `WEBVTT\n\n00:00.000 --> 59:59.000\n${transcript}\n`;
        this._voiceCaptionsUrl = URL.createObjectURL(new Blob([cues], { type: "text/vtt" }));
        this._els.voiceCaptions.src = this._voiceCaptionsUrl;
        this._els.voiceCaptions.srclang = this._pack?.lang || "en";
        this._els.voiceCaptions.label = this._pack?.strings.transcript || en.strings.transcript;
      }
      if (transcript) this._announce(`${this._pack?.strings.transcript || en.strings.transcript}: ${transcript}`);
    }

    _startVoiceCommand() {
      if (this._voiceMode) {
        this._stopVoice();
        return;
      }
      this._setTranscript("", false);
      // Use browser capture and local server transcription for task commands.
      // The Web Speech API may send audio to a browser vendor, so it is reserved
      // for the separate, user-invoked dictation control.
      this._startVoiceRecorder({ voiceCommand: true });
    }

    _restoreVoiceCommandState() {
      try {
        this._voiceCommandDraft = JSON.parse(localStorage.getItem(this._voiceDraftKey) || "null");
        if (!this._voiceCommandDraft?.draftToken || !this._voiceCommandDraft?.idempotencyKey) this._voiceCommandDraft = null;
      } catch { this._voiceCommandDraft = null; }
      try {
        const queue = JSON.parse(localStorage.getItem(this._voiceQueueKey) || "[]");
        this._voiceActionQueue = Array.isArray(queue) ? queue.filter((item) => item && typeof item.id === "string") : [];
      } catch { this._voiceActionQueue = []; }
    }

    _newVoiceActionKey() {
      return globalThis.crypto?.randomUUID?.() || `voice-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    }

    async _loadVoiceGuide() {
      const strings = this._pack?.strings || en.strings;
      this._els.voiceGuide.disabled = true;
      this._els.voiceStatus.textContent = strings.listening;
      try {
        const base = (this.getAttribute("api") || location.origin).replace(/\/$/, "");
        const response = await fetch(`${base}/api/v1/voice/guide?language=${encodeURIComponent(this._pack?.lang || "en")}`, { cache: "no-store" });
        if (!response.ok) throw new Error("Guide request failed");
        const guide = await response.json();
        const text = typeof guide.text === "string" ? guide.text : (guide.steps || []).join("\n");
        this._appendMessage({ role: "assistant", text, lang: guide.language || this._pack.lang });
        if (guide.speakText) this._speakText(guide.speakText, guide.language || this._pack.lang, this._els.voiceStatus);
      } catch {
        this._els.voiceStatus.textContent = strings.voiceCommandGuideFailed || en.strings.voiceCommandGuideFailed;
      } finally {
        this._els.voiceGuide.disabled = false;
      }
    }

    async _submitVoiceCommand(command) {
      const strings = this._pack?.strings || en.strings;
      const language = this._pack?.lang || "en";
      const transcript = typeof command.transcript === "string" ? command.transcript.trim() : "";
      const draft = this._voiceCommandDraft;
      const idempotencyKey = draft?.idempotencyKey || this._newVoiceActionKey();
      const payload = {
        language,
        shareConsent: Boolean(this._els.consent.checked),
        page: draft?.draftToken ? undefined : location.href,
        ...(transcript ? { transcript } : {}),
        ...(Number.isFinite(command.confidence) ? { confidence: command.confidence } : {}),
        ...(command.audioDataUrl ? { audioDataUrl: command.audioDataUrl, audioMimeType: command.audioMimeType } : {}),
        ...(draft?.draftToken ? { draftToken: draft.draftToken } : {})
      };
      if (!draft?.draftToken && this._els.consent.checked) {
        payload.conversation = this._messages
          .filter((message) => ["user", "assistant"].includes(message.role) && typeof message.text === "string")
          .slice(-20)
          .map((message) => ({ role: message.role, text: message.text.slice(0, 4000) }));
      }
      const pendingTicket = this._learnerTickets.find((ticket) => ticket.ticketId === this._pendingTutorTicketId);
      if (/reply|status|ምላሽ|መልሲ|رد/i.test(transcript) && pendingTicket) {
        payload.ticketId = pendingTicket.ticketId;
        payload.ticketAccessToken = pendingTicket.accessToken;
      }
      if (/accommodation|accessibility accommodation|ማስተካከያ|تيسير/i.test(transcript)) {
        if (this._els.accommodationJob.value) payload.jobId = this._els.accommodationJob.value;
        if (this._els.accommodationChoice.value) payload.accommodation = this._els.accommodationChoice.value;
      }
      if (transcript) {
        this._setTranscript(transcript);
        this._appendMessage({ role: "user", text: transcript, lang: language });
        this._emit("question", { text: transcript, language, input: "voice", requestId: this._newQuestionQueueId() });
        if (payload.conversation) payload.conversation = payload.conversation.concat({ role: "user", text: transcript.slice(0, 4000) }).slice(-20);
      }
      this._els.voiceStatus.textContent = strings.voiceCommandListening || en.strings.voiceCommandListening;
      if (!navigator.onLine) {
        this._queueVoiceAction({ ...payload, idempotencyKey }, strings);
        return;
      }
      try {
        const base = (this.getAttribute("api") || location.origin).replace(/\/$/, "");
        const response = await fetch(`${base}/api/v1/voice/commands`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...(draft?.draftToken ? { "Idempotency-Key": idempotencyKey } : {}) },
          body: JSON.stringify(payload),
          cache: "no-store"
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok) {
          if (payload.audioDataUrl && response.status === 503) {
            this._els.voiceStatus.textContent = strings.voiceCommandUnavailable || en.strings.voiceCommandUnavailable;
            return;
          }
          if ((response.status >= 500 && !payload.audioDataUrl) || response.status === 429) {
            this._queueVoiceAction({ ...payload, idempotencyKey }, strings);
            return;
          }
          this._els.voiceStatus.textContent = typeof result.detail === "string" ? result.detail : (strings.voiceCommandFailed || en.strings.voiceCommandFailed);
          return;
        }
        this._handleVoiceCommandResult(result, transcript ? true : false);
      } catch (error) {
        if (error instanceof TypeError) this._queueVoiceAction({ ...payload, idempotencyKey }, strings);
        else this._els.voiceStatus.textContent = strings.voiceCommandFailed || en.strings.voiceCommandFailed;
      }
    }

    _queueVoiceAction(payload, strings = this._pack?.strings || en.strings) {
      const item = {
        ...payload,
        id: this._newVoiceActionKey(),
        idempotencyKey: payload.idempotencyKey || this._newVoiceActionKey(),
        expiresAt: Math.floor(Date.now() / 1000) + 24 * 60 * 60
      };
      if (item.draftToken && this._voiceCommandDraft?.expiresAt) item.expiresAt = Math.min(item.expiresAt, this._voiceCommandDraft.expiresAt);
      if (typeof item.audioDataUrl === "string" && item.audioDataUrl.length > 1_600_000) {
        this._els.voiceStatus.textContent = strings.voiceCommandFailed || en.strings.voiceCommandFailed;
        return false;
      }
      this._voiceActionQueue.push(item);
      this._voiceActionQueue = this._voiceActionQueue.slice(-20);
      try {
        localStorage.setItem(this._voiceQueueKey, JSON.stringify(this._voiceActionQueue));
        this._els.voiceStatus.textContent = strings.voiceCommandQueued || en.strings.voiceCommandQueued;
        if (navigator.onLine) setTimeout(() => this._flushVoiceActionQueue(), 1500);
        return true;
      } catch {
        this._voiceActionQueue.pop();
        this._els.voiceStatus.textContent = strings.voiceCommandFailed || en.strings.voiceCommandFailed;
        return false;
      }
    }

    async _flushVoiceActionQueue() {
      if (!navigator.onLine || this._flushingVoiceActionQueue || !this._voiceActionQueue.length) return;
      this._flushingVoiceActionQueue = true;
      try {
        const base = (this.getAttribute("api") || location.origin).replace(/\/$/, "");
        const response = await fetch(`${base}/api/v1/voice/actions/sync`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ actions: this._voiceActionQueue }), cache: "no-store"
        });
        if (!response.ok) return;
        const result = await response.json();
        const results = Array.isArray(result.results) ? result.results : [];
        const rejectedIds = new Set();
        for (const actionResult of results) {
          if (actionResult.status === "rejected") rejectedIds.add(actionResult.id);
          const queuedItem = this._voiceActionQueue.find((item) => item.id === actionResult.id);
          this._handleVoiceCommandResult(actionResult, Boolean(queuedItem?.transcript));
        }
        this._voiceActionQueue = this._voiceActionQueue.filter((item) => rejectedIds.has(item.id));
        localStorage.setItem(this._voiceQueueKey, JSON.stringify(this._voiceActionQueue));
      } catch {
        // Keep local drafts for the next online event or explicit retry.
      } finally {
        this._flushingVoiceActionQueue = false;
      }
    }

    _handleVoiceCommandResult(result, userAlreadyShown = false) {
      const strings = this._pack?.strings || en.strings;
      const language = result.language || this._pack?.lang || "en";
      if (!userAlreadyShown && result.transcript) {
        this._setTranscript(result.transcript);
        this._appendMessage({ role: "user", text: result.transcript, lang: language });
        this._emit("question", { text: result.transcript, language, input: "voice", requestId: this._newQuestionQueueId() });
      }
      let answerText = result.answerText || strings.voiceCommandFailed || en.strings.voiceCommandFailed;
      if (result.status === "consent_required") {
        answerText = strings.voiceCommandConsent || en.strings.voiceCommandConsent;
        this._els.escalation.hidden = false;
        this._els.consent.focus();
      } else if (result.status === "clarification_required" || result.status === "draft_changed") {
        answerText = result.answerText || strings.voiceCommandClarify || en.strings.voiceCommandClarify;
      } else if (result.status === "draft" && result.draftToken) {
        this._voiceCommandDraft = {
          draftToken: result.draftToken,
          idempotencyKey: this._newVoiceActionKey(),
          expiresAt: Math.floor(Date.now() / 1000) + 5 * 60
        };
        try { localStorage.setItem(this._voiceDraftKey, JSON.stringify(this._voiceCommandDraft)); } catch { /* The signed draft remains in memory. */ }
        const review = (result.draft?.conversation || [])
          .map((message) => `${message.role === "assistant" ? strings.assistant : strings.you}: ${message.text}`)
          .join("\n");
        if (review) answerText += `\n\n${review}`;
      } else if (result.status === "sent" && result.ticket?.ticketId) {
        this._rememberLearnerTicket(result.ticket);
        this._pendingTutorTicketId = result.ticket.ticketId;
        try { localStorage.setItem(this._pendingTutorKey, this._pendingTutorTicketId); } catch { /* Keep in-memory reply checks. */ }
        this._els.checkTutorReply.hidden = false;
        this._els.consent.checked = false;
        this._voiceCommandDraft = null;
        try { localStorage.removeItem(this._voiceDraftKey); } catch { /* Ignore storage failure. */ }
        this._emit("escalated", { ticketId: result.ticket.ticketId, source: "voice" });
      }
      const sources = Array.isArray(result.sources) ? result.sources : [];
      const links = sources.filter((source) => source?.url && source?.title).map((source) => ({ url: source.url, title: source.title }));
      this._appendMessage({
        role: "assistant", text: answerText, lang: language, links,
        answerStatus: result.grounding?.status === "verified" ? "answered" : undefined,
        showPerson: result.action === "ask" && result.status !== "answered" && !links.length
      });
      this._speakText(result.answerText || answerText, language, this._els.voiceStatus);
    }

    _startVoiceInput() {
      if (this._voiceMode) {
        this._stopVoice();
        return;
      }
      this._setTranscript("", false);
      const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (!Recognition) {
        this._startVoiceRecorder();
        return;
      }
      const recognition = new Recognition();
      const recognitionLanguages = { en: "en-US", am: "am-ET", ti: "ti-ET", om: "om-ET", so: "so-SO", ar: "ar-SA" };
      recognition.lang = recognitionLanguages[this._pack?.lang] || "en-US";
      recognition.continuous = false;
      recognition.interimResults = false;
      this._recognition = recognition;
      this._recognitionGotResult = false;
      this._ignoreRecognitionEnd = false;
      this._setVoiceState(true, "recognition");
      this._els.voiceStatus.textContent = this._pack.strings.listening;
      recognition.onresult = (event) => {
        const transcript = Array.from(event.results || []).map((result) => result[0]?.transcript || "").join(" ").trim();
        if (transcript) {
          this._recognitionGotResult = true;
          this._setTranscript(transcript);
          this._els.input.value = transcript;
          this._els.input.dispatchEvent(new Event("input", { bubbles: true }));
          this._els.readBack.hidden = false;
          this._els.voiceStatus.textContent = this._pack.strings.speechAdded;
          this._finishRecognition();
        } else {
          this._recognition = null;
          this._setVoiceState(false);
          this._startVoiceRecorder();
        }
      };
      recognition.onerror = (event) => {
        if (this._recognition !== recognition) return;
        this._recognition = null;
        this._setVoiceState(false);
        if (event?.error === "not-allowed") {
          this._els.voiceStatus.textContent = this._pack.strings.microphonePermissionDenied || en.strings.microphonePermissionDenied;
          return;
        }
        if (!this._recognitionGotResult) this._startVoiceRecorder();
      };
      recognition.onend = () => {
        if (this._recognition !== recognition) return;
        this._recognition = null;
        const shouldFallback = !this._recognitionGotResult && !this._ignoreRecognitionEnd;
        if (shouldFallback) this._startVoiceRecorder();
        else if (!this._recognitionGotResult) this._setVoiceState(false);
      };
      try {
        recognition.start();
      } catch (error) {
        this._recognition = null;
        if (error?.name === "NotAllowedError" || error?.name === "SecurityError") {
          this._setVoiceState(false);
          this._els.voiceStatus.textContent = this._pack.strings.microphonePermissionDenied || en.strings.microphonePermissionDenied;
          return;
        }
        this._startVoiceRecorder();
      }
    }

    _finishRecognition() {
      const recognition = this._recognition;
      this._recognition = null;
      this._setVoiceState(false);
      try { recognition?.stop(); } catch { /* Recognition may already have stopped. */ }
    }

    async _startVoiceRecorder({ voiceCommand = false } = {}) {
      if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder || !window.isSecureContext) {
        this._setVoiceState(false);
        this._els.voiceStatus.textContent = this._pack.strings.voiceUnavailable;
        return;
      }
      this._voiceCommandRecording = voiceCommand;
      this._setVoiceState(true, voiceCommand ? "voice-command-recording-pending" : "recording-pending");
      const generation = ++this._voiceGeneration;
      this._els.voiceStatus.textContent = voiceCommand
        ? (this._pack.strings.voiceCommandListening || en.strings.voiceCommandListening)
        : this._pack.strings.recording;
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        if (generation !== this._voiceGeneration) {
          for (const track of stream.getTracks()) track.stop();
          return;
        }
        this._mediaStream = stream;
        this._voiceChunks = [];
        const recorder = new MediaRecorder(stream);
        this._mediaRecorder = recorder;
        recorder.addEventListener("dataavailable", (event) => {
          if (event.data?.size) this._voiceChunks.push(event.data);
        });
        recorder.addEventListener("stop", () => {
          const blob = new Blob(this._voiceChunks, { type: recorder.mimeType || "audio/webm" });
          const commandRecording = this._voiceCommandRecording;
          this._voiceCommandRecording = false;
          if (!commandRecording) this._voiceBlob = blob.size ? blob : null;
          for (const track of stream.getTracks()) track.stop();
          this._mediaStream = null;
          this._mediaRecorder = null;
          this._setVoiceState(false);
          if (commandRecording && blob.size) {
            this._els.voiceStatus.textContent = this._pack.strings.listening || en.strings.listening;
            void this._blobAsDataUrl(blob).then((audioDataUrl) => this._submitVoiceCommand({
              audioDataUrl,
              audioMimeType: blob.type || "audio/webm"
            })).catch(() => {
              this._els.voiceStatus.textContent = this._pack.strings.voiceCommandFailed || en.strings.voiceCommandFailed;
            });
          } else if (this._voiceBlob) {
            if (this._voiceObjectUrl) URL.revokeObjectURL(this._voiceObjectUrl);
            this._voiceObjectUrl = URL.createObjectURL(this._voiceBlob);
            this._els.voicePlayer.src = this._voiceObjectUrl;
            this._els.voiceNote.hidden = false;
            this._setTranscript(this._pack.strings.audioTranscriptUnavailable || en.strings.audioTranscriptUnavailable);
            this._els.voiceStatus.textContent = this._pack.strings.recordedReady;
          }
        }, { once: true });
        recorder.start();
        this._voiceMode = voiceCommand ? "voice-command-recording" : "recording";
      } catch (error) {
        for (const track of this._mediaStream?.getTracks?.() || []) track.stop();
        this._mediaStream = null;
        this._mediaRecorder = null;
        this._setVoiceState(false);
        const permissionDenied = error?.name === "NotAllowedError" || error?.name === "PermissionDeniedError";
        this._els.voiceStatus.textContent = permissionDenied
          ? this._pack.strings.microphonePermissionDenied || en.strings.microphonePermissionDenied
          : this._pack.strings.voiceUnavailable;
      }
    }

    _stopVoice() {
      if (this._speechStatusNode && window.speechSynthesis?.speaking) {
        window.speechSynthesis.cancel();
        this._speechStatusNode.textContent = this._pack?.strings.stopped || en.strings.stopped;
        this._announce(this._speechStatusNode.textContent);
        this._speechStatusNode = null;
        if (!this._voiceMode) this._els.stopVoice.hidden = true;
        return;
      }
      if (this._voiceMode.endsWith("recognition") && this._recognition) {
        this._ignoreRecognitionEnd = true;
        const recognition = this._recognition;
        this._recognition = null;
        this._setVoiceState(false);
        try { recognition.stop(); } catch { /* Already stopped. */ }
        this._els.voiceStatus.textContent = this._pack.strings.stopped;
        return;
      }
      if ((this._voiceMode === "recording" || this._voiceMode === "recording-pending" || this._voiceMode === "voice-command-recording") && this._mediaRecorder?.state === "recording") {
        this._mediaRecorder.stop();
      } else if (this._voiceMode === "recording-pending" || this._voiceMode === "voice-command-recording-pending") {
        this._voiceGeneration++;
        for (const track of this._mediaStream?.getTracks?.() || []) track.stop();
        this._mediaStream = null;
        this._setVoiceState(false);
        this._els.voiceStatus.textContent = this._pack.strings.stopped;
      }
    }

    _findSpeechVoice(language) {
      const languageTags = { en: "en-US", am: "am-ET", ti: "ti-ET", om: "om-ET", so: "so-SO", ar: "ar-SA" };
      const lang = languageTags[language] || languageTags.en;
      const languageCode = lang.split("-")[0].toLowerCase();
      const find = () => (window.speechSynthesis.getVoices?.() || [])
        .find((item) => (item.lang || "").toLowerCase().split("-")[0] === languageCode);
      const immediate = find();
      if (immediate) return Promise.resolve({ voice: immediate, lang });
      return new Promise((resolve) => {
        let finished = false;
        const complete = () => {
          if (finished) return;
          finished = true;
          window.speechSynthesis.removeEventListener?.("voiceschanged", onVoicesChanged);
          window.clearTimeout(timeout);
          resolve({ voice: find(), lang });
        };
        const onVoicesChanged = () => complete();
        const timeout = window.setTimeout(complete, 1200);
        window.speechSynthesis.addEventListener?.("voiceschanged", onVoicesChanged, { once: true });
      });
    }

    async _speakText(text, language, statusNode) {
      if (!window.speechSynthesis || !window.SpeechSynthesisUtterance) {
        statusNode.textContent = this._pack?.strings.noSpeechVoice || en.strings.noSpeechVoice;
        this._announce(statusNode.textContent, true);
        return;
      }
      statusNode.textContent = this._pack?.strings.speechStarted || en.strings.speechStarted;
      this._announce(statusNode.textContent);
      const { voice, lang } = await this._findSpeechVoice(language);
      if (!voice) {
        statusNode.textContent = this._pack?.strings.noSpeechVoice || en.strings.noSpeechVoice;
        this._announce(statusNode.textContent, true);
        return;
      }
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = lang;
      utterance.voice = voice;
      this._speechStatusNode = statusNode;
      this._els.stopVoice.hidden = false;
      utterance.onend = () => {
        if (this._speechStatusNode !== statusNode) return;
        statusNode.textContent = this._pack?.strings.speechFinished || en.strings.speechFinished;
        this._speechStatusNode = null;
        if (!this._voiceMode) this._els.stopVoice.hidden = true;
      };
      utterance.onerror = () => {
        if (this._speechStatusNode === statusNode) this._speechStatusNode = null;
        statusNode.textContent = this._pack?.strings.voiceUnavailable || en.strings.voiceUnavailable;
        this._announce(statusNode.textContent, true);
        if (!this._voiceMode) this._els.stopVoice.hidden = true;
      };
      window.speechSynthesis.speak(utterance);
    }

    _openEscalation() {
      this._els.escalation.hidden = false;
      this._els.checkTutorReply.hidden = !this._pendingTutorTicketId;
      this._els.escalationReason.focus();
      this._emit("person", {});
    }

    _updateEscalationReasonState() {
      const e = this._els;
      const strings = this._pack?.strings || en.strings;
      const requiresDetails = e.escalationReason.value === "other";
      e.escalationNoteLabel.textContent = requiresDetails
        ? strings.escalationOtherDetails || en.strings.escalationOtherDetails
        : strings.escalationNote || en.strings.escalationNote;
      e.escalationNoteLabel.lang = this._pack?.lang || "en";
      e.escalationNote.required = requiresDetails;
      e.escalationNote.setAttribute("aria-required", String(requiresDetails));
    }

    _ticketReference(ticketId) {
      const template = this._pack?.strings.ticketReference || en.strings.ticketReference;
      return template.replace("{ticketId}", ticketId);
    }

    async _checkTutorReply() {
      const e = this._els;
      if (!this._pendingTutorTicketId) return;
      e.checkTutorReply.disabled = true;
      e.escalationStatus.textContent = this._pack.strings.checkingTutorReply;
      try {
        const base = (this.getAttribute("api") || location.origin).replace(/\/$/, "");
        const ticketAccess = this._learnerTickets.find((ticket) => ticket.ticketId === this._pendingTutorTicketId);
        const headers = ticketAccess ? { "X-Learner-Token": ticketAccess.accessToken } : {};
        const response = await fetch(
          `${base}/api/v1/escalations/${encodeURIComponent(this._pendingTutorTicketId)}`,
          { headers }
        );
        if (!response.ok) throw new Error("Tutor reply could not be checked.");
        const ticket = await response.json();
        if (typeof ticket.reply === "string" && ticket.reply.trim()) {
          const previousUpdate = this._messages.some((message) =>
            message.role === "tutor" && message.ticketId === this._pendingTutorTicketId && message.text === ticket.reply.trim()
          );
          if (!previousUpdate) {
            this._appendMessage({
              role: "tutor", text: ticket.reply.trim(), lang: ticket.language || this._pack.lang,
              ticketId: this._pendingTutorTicketId
            });
          }
          if (ticket.status === "answered") {
            e.escalationStatus.textContent = this._pack.strings.tutorReplyAvailable;
            this._pendingTutorTicketId = "";
            try { localStorage.removeItem(this._pendingTutorKey); } catch { /* The reply is still shown in this chat. */ }
            e.checkTutorReply.hidden = true;
          } else {
            e.escalationStatus.textContent = previousUpdate
              ? this._pack.strings.tutorReplyPending
              : this._pack.strings.tutorUpdateAvailable;
          }
        } else if (ticket.status === "waiting") {
          e.escalationStatus.textContent = this._pack.strings.tutorReplyPending;
        } else {
          throw new Error("Tutor reply could not be checked.");
        }
      } catch {
        e.escalationStatus.textContent = this._pack.strings.checkTutorReplyFailed;
      } finally {
        e.checkTutorReply.disabled = false;
      }
    }

    _openAccommodation() {
      this._els.accommodationForm.hidden = false;
      this._populateAccommodationChoices();
      this._els.accommodationJob.focus();
    }

    _blobAsDataUrl(blob) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error || new Error("Could not read the voice note."));
        reader.readAsDataURL(blob);
      });
    }

    async _createScreenTicket(type, screenContext = null) {
      const base = (this.getAttribute("api") || location.origin).replace(/\/$/, "");
      const payload = {
        type,
        conversation: [],
        language: this._pack.lang,
        page: location.href,
        note: type === "screen-share" ? "Demo WebRTC screen share; no recording." : ""
      };
      if (screenContext) payload.screenContext = screenContext;
      const response = await fetch(`${base}/api/v1/escalations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      if (!response.ok) throw new Error("Screen-share request could not be created.");
      const result = await response.json();
      if (typeof result.ticketId !== "string") throw new Error("Screen-share ticket ID was missing.");
      this._rememberLearnerTicket(result);
      return { base, ticketId: result.ticketId };
    }

    _waitForIceGathering(peer) {
      if (peer.iceGatheringState === "complete") return Promise.resolve();
      return new Promise((resolve) => {
        const finish = () => {
          clearTimeout(timeout);
          peer.removeEventListener("icegatheringstatechange", checkState);
          resolve();
        };
        const checkState = () => {
          if (peer.iceGatheringState === "complete") finish();
        };
        const timeout = setTimeout(finish, 10000);
        peer.addEventListener("icegatheringstatechange", checkState);
      });
    }

    async _waitForScreenAnswer(base, ticketId, generation) {
      for (let attempt = 0; attempt < 60 && generation === this._screenShareGeneration; attempt++) {
        const response = await fetch(
          `${base}/api/v1/escalations/${encodeURIComponent(ticketId)}/signal?type=answer`
        );
        if (!response.ok) throw new Error("The tutor's WebRTC answer could not be loaded.");
        const result = await response.json();
        if (typeof result.sdp === "string" && result.sdp) return result.sdp;
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      if (generation !== this._screenShareGeneration) return "";
      throw new Error("Timed out waiting for the tutor's WebRTC answer.");
    }

    async _startScreenShare() {
      const e = this._els;
      if (!e.screenShareConsent.checked) {
        e.screenShareStatus.textContent = this._pack.strings.screenShareConsentRequired;
        e.screenShareConsent.focus();
        return;
      }
      if (typeof navigator.mediaDevices?.getDisplayMedia !== "function" ||
          (/Android/i.test(navigator.userAgent) && /Chrome|Chromium/i.test(navigator.userAgent))) {
        e.screenShareStatus.textContent = this._pack.strings.screenShareError;
        return;
      }
      if (this._screenShareStarting || this._screenStream) return;

      this._screenShareStarting = true;
      e.screenShareStart.disabled = true;
      e.screenShareStatus.textContent = this._pack.strings.screenShareStarting;
      const generation = ++this._screenShareGeneration;
      let stream;
      try {
        stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
        if (generation !== this._screenShareGeneration) {
          for (const track of stream.getTracks()) track.stop();
          return;
        }
        this._screenStream = stream;
        e.screenShareBar.hidden = false;
        e.screenShareBarText.textContent = this._pack.strings.screenShareOn;
        e.screenShareStatus.textContent = this._pack.strings.screenShareConnecting;
        for (const track of stream.getTracks()) {
          track.addEventListener("ended", () => {
            if (this._screenStream === stream) this._stopScreenShare();
          }, { once: true });
        }

        const { base, ticketId } = await this._createScreenTicket("screen-share");
        this._screenTicketId = ticketId;
        if (generation !== this._screenShareGeneration) {
          await this._cleanupScreenTicket(base, ticketId);
          this._screenTicketId = "";
          return;
        }

        const peer = new RTCPeerConnection();
        this._screenPeer = peer;
        peer.onconnectionstatechange = () => {
          if (peer.connectionState === "failed" || peer.connectionState === "disconnected") {
            e.screenShareStatus.textContent = this._pack.strings.screenShareDisconnected;
          }
        };
        for (const track of stream.getTracks()) peer.addTrack(track, stream);
        const offer = await peer.createOffer();
        await peer.setLocalDescription(offer);
        await this._waitForIceGathering(peer);
        if (generation !== this._screenShareGeneration) return;

        const signalUrl = `${base}/api/v1/escalations/${encodeURIComponent(ticketId)}/signal`;
        const offerResponse = await fetch(signalUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "offer", sdp: peer.localDescription.sdp })
        });
        if (!offerResponse.ok) throw new Error("The WebRTC offer could not be sent.");

        const answer = await this._waitForScreenAnswer(base, ticketId, generation);
        if (generation !== this._screenShareGeneration) return;
        await peer.setRemoteDescription({ type: "answer", sdp: answer });
        e.screenShareStatus.textContent = this._pack.strings.screenShareConnected;
        try {
          const clearResponse = await fetch(
            `${base}/api/v1/escalations/${encodeURIComponent(ticketId)}/signal`,
            { method: "DELETE", keepalive: true }
          );
          if (!clearResponse.ok) throw new Error("Signal cleanup failed.");
        } catch {
          e.screenShareStatus.textContent = this._pack.strings.screenShareCleanupFailed;
        }
      } catch (error) {
        if (generation !== this._screenShareGeneration) return;
        const denied = error?.name === "NotAllowedError";
        const cancelled = error?.name === "AbortError";
        this._stopScreenShare(false);
        e.screenShareStatus.textContent = cancelled
          ? this._pack.strings.screenShareCancelled
          : denied
            ? this._pack.strings.screenSharePermissionDenied
            : error?.message?.includes("Timed out")
              ? this._pack.strings.screenShareDisconnected
              : this._pack.strings.screenShareError;
      } finally {
        this._screenShareStarting = false;
        if (this._els) e.screenShareStart.disabled = Boolean(this._screenStream);
      }
    }

    _stopScreenShare(announce = true) {
      const stream = this._screenStream;
      const peer = this._screenPeer;
      const ticketId = this._screenTicketId;
      this._screenShareGeneration++;
      this._screenStream = null;
      this._screenPeer = null;
      this._screenTicketId = "";
      for (const track of stream?.getTracks?.() || []) track.stop();
      peer?.close();
      if (this._els) {
        this._els.screenShareBar.hidden = true;
        this._els.screenShareConsent.checked = false;
        this._els.screenShareStart.disabled = false;
        if (announce && (stream || ticketId)) {
          this._els.screenShareStatus.textContent = this._pack.strings.screenShareStopped;
        }
      }
      if (ticketId) {
        const base = (this.getAttribute("api") || location.origin).replace(/\/$/, "");
        this._cleanupScreenTicket(base, ticketId).catch(() => {
          if (this._els) this._els.screenShareStatus.textContent = this._pack.strings.screenShareCleanupFailed;
        });
      }
    }

    async _cleanupScreenTicket(base, ticketId) {
      const signalResponse = await fetch(
        `${base}/api/v1/escalations/${encodeURIComponent(ticketId)}/signal`,
        { method: "DELETE", keepalive: true }
      );
      const ticket = this._learnerTickets.find((item) => item.ticketId === ticketId);
      if (!ticket) {
        if (!signalResponse.ok) throw new Error("Screen signaling cleanup failed.");
        return;
      }
      const response = await fetch(
        `${base}/api/v1/escalations/${encodeURIComponent(ticketId)}/data`,
        {
          method: "DELETE",
          headers: { "X-Learner-Token": ticket.accessToken },
          keepalive: true
        }
      );
      if (!response.ok) throw new Error("Screen ticket cleanup failed.");
      this._learnerTickets = this._learnerTickets.filter((item) => item.ticketId !== ticketId);
      try {
        localStorage.setItem(`${this._storageKey}:learner-tickets`, JSON.stringify(this._learnerTickets));
      } catch { /* The server-side ticket is already removed. */ }
      this._renderLearnerTickets();
    }

    _focusedAccessibleName(element) {
      if (!element) return "";
      const root = element.getRootNode();
      const labelledBy = element.getAttribute("aria-labelledby")
        ?.split(/\s+/)
        .map((id) => root.getElementById?.(id) || document.getElementById(id))
        .filter(Boolean)
        .map((node) => node.textContent.trim())
        .join(" ");
      const labels = Array.from(element.labels || []).map((label) => label.textContent.trim()).join(" ");
      return (
        element.getAttribute("aria-label") ||
        labelledBy ||
        labels ||
        element.getAttribute("alt") ||
        element.getAttribute("title") ||
        element.getAttribute("placeholder") ||
        element.textContent ||
        ""
      ).trim().slice(0, 500);
    }

    async _sharePageContext() {
      const e = this._els;
      if (!e.screenShareConsent.checked) {
        e.screenShareStatus.textContent = this._pack.strings.screenShareConsentRequired;
        e.screenShareConsent.focus();
        return;
      }
      const file = e.screenScreenshot.files?.[0];
      if (file && (file.size > 3_000_000 || !["image/jpeg", "image/png", "image/webp", "image/gif"].includes(file.type))) {
        e.screenShareStatus.textContent = this._pack.strings.screenScreenshotTooLarge;
        return;
      }

      e.screenContextStart.disabled = true;
      e.screenShareStatus.textContent = this._pack.strings.screenShareStarting;
      try {
        const focused = (this._lastPageFocusedElement?.isConnected ? this._lastPageFocusedElement : null)
          || this.shadowRoot.activeElement || document.activeElement;
        const screenContext = {
          pageUrl: location.href,
          focusedAccessibleName: this._focusedAccessibleName(focused),
          focusedOuterHTML: typeof focused?.outerHTML === "string" ? focused.outerHTML.slice(0, 500) : "",
          headings: Array.from(document.querySelectorAll("h1, h2, h3, h4, h5, h6"))
            .map((heading) => heading.textContent.trim().slice(0, 300))
            .filter(Boolean)
            .slice(0, 20),
          screenshot: file
            ? { mimeType: file.type, dataUrl: await this._blobAsDataUrl(file) }
            : null
        };
        await this._createScreenTicket("screen-context", screenContext);
        e.screenShareStatus.textContent = this._pack.strings.screenContextSent;
        e.screenShareConsent.checked = false;
        e.screenScreenshot.value = "";
      } catch {
        e.screenShareStatus.textContent = this._pack.strings.screenContextFailed;
      } finally {
        e.screenContextStart.disabled = false;
      }
    }

    async _submitEscalation(event) {
      event.preventDefault();
      const e = this._els;
      const handoffReason = e.escalationReason.value;
      if (!handoffReason) {
        e.escalationReasonError.hidden = false;
        e.escalationReason.setAttribute("aria-invalid", "true");
        e.escalationReason.setAttribute("aria-describedby", "escalation-reason-error");
        e.escalationReason.focus();
        return;
      }
      e.escalationReasonError.hidden = true;
      e.escalationReason.removeAttribute("aria-invalid");
      e.escalationReason.removeAttribute("aria-describedby");
      const rawPhone = e.escalationPhone.value.trim();
      const normalizedPhone = rawPhone ? normalizeEthiopianPhone(rawPhone) : "";
      if (rawPhone && !normalizedPhone) {
        e.phoneError.textContent = this._pack.strings.phoneInvalid || en.strings.phoneInvalid;
        e.phoneError.lang = this._pack.lang;
        e.phoneError.hidden = false;
        e.escalationPhone.setAttribute("aria-invalid", "true");
        e.escalationPhone.setAttribute("aria-describedby", "phone-error");
        e.escalationPhone.focus();
        return;
      }
      if (handoffReason === "other" && !e.escalationNote.value.trim()) {
        e.escalationOtherError.hidden = false;
        e.escalationNote.setAttribute("aria-invalid", "true");
        e.escalationNote.setAttribute("aria-describedby", "escalation-other-error");
        e.escalationNote.focus();
        return;
      }
      e.escalationOtherError.hidden = true;
      e.escalationNote.removeAttribute("aria-invalid");
      e.escalationNote.removeAttribute("aria-describedby");
      try {
        const conversation = e.consent.checked ? this._messages : [];
        const payload = {
          conversation,
          language: this._pack.lang,
          page: location.href,
          handoffReason,
          note: e.escalationNote.value.trim(),
          phone: normalizedPhone
        };
        if (this._voiceBlob) {
          payload.audio = { mimeType: this._voiceBlob.type || "audio/webm", dataUrl: await this._blobAsDataUrl(this._voiceBlob) };
        }
        const base = (this.getAttribute("api") || location.origin).replace(/\/$/, "");
        const response = await fetch(`${base}/api/v1/escalations`, {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload)
        });
        if (!response.ok) throw new Error("Escalation send failed");
        const result = await response.json();
        if (typeof result.ticketId !== "string" || !result.ticketId) throw new Error("Escalation ticket ID was missing");
        this._rememberLearnerTicket(result);
        this._pendingTutorTicketId = result.ticketId;
        try { localStorage.setItem(this._pendingTutorKey, this._pendingTutorTicketId); } catch { /* Keep reply checks available until the page closes. */ }
        e.checkTutorReply.hidden = false;
        e.escalationStatus.textContent = `${this._pack.strings.escalationSent} ${this._ticketReference(result.ticketId)}`;
        this._emit("escalated", { ticketId: result.ticketId });
        e.escalationNote.value = "";
        e.escalationReason.value = "";
        this._updateEscalationReasonState();
        e.escalationPhone.value = "";
        e.consent.checked = false;
        this._voiceBlob = null;
        e.voiceNote.hidden = true;
        e.voicePlayer.removeAttribute("src");
        this._setTranscript("", false);
      } catch {
        e.escalationStatus.textContent = this._pack.strings.escalationFailed;
      }
    }

    async _submitAccommodation(event) {
      event.preventDefault();
      const e = this._els;
      const job = this._jobs.find((item) => item.id === e.accommodationJob.value);
      if (!job || !e.accommodationChoice.value) {
        e.accommodationStatus.textContent = this._pack.strings.accommodationFailed;
        return;
      }
      const note = e.accommodationNote.value.trim();
      if (e.accommodationChoice.value === "Other" && !note) {
        e.accommodationStatus.textContent = this._pack.strings.describeOther;
        e.accommodationNote.focus();
        return;
      }
      try {
        const payload = {
          type: "accommodation",
          jobId: job.id,
          accommodation: e.accommodationChoice.value === "Other" ? `Other: ${note}` : e.accommodationChoice.value,
          conversation: [],
          language: this._pack.lang,
          page: location.href,
          note
        };
        const base = (this.getAttribute("api") || location.origin).replace(/\/$/, "");
        const response = await fetch(`${base}/api/v1/escalations`, {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload)
        });
        if (!response.ok) throw new Error("Escalation send failed");
        const result = await response.json();
        if (typeof result.ticketId !== "string" || !result.ticketId) throw new Error("Escalation ticket ID was missing");
        this._rememberLearnerTicket(result);
        e.accommodationStatus.textContent = `${this._pack.strings.accommodationSent} ${this._ticketReference(result.ticketId)}`;
        this._emit("escalated", { ticketId: result.ticketId, type: "accommodation" });
        e.accommodationNote.value = "";
      } catch {
        e.accommodationStatus.textContent = this._pack.strings.accommodationFailed;
      }
    }

    _setError(key) {
      this._errorKey = key;
      const error = this._els.error;
      const input = this._els.input;
      if (!key || !this._pack) {
        error.textContent = "";
        input.removeAttribute("aria-invalid");
        input.setAttribute("aria-describedby", "question-help");
        return;
      }
      error.textContent = this._pack.strings[key] || "";
      error.lang = this._pack.lang;
      input.setAttribute("aria-invalid", "true");
      input.setAttribute("aria-describedby", "question-help question-error");
      this._announce(error.textContent, true);
    }

    _emit(name, detail) {
      this.dispatchEvent(new CustomEvent(`db-assistant:${name}`, { bubbles: true, composed: true, detail }));
    }
  }

  if (!customElements.get("db-assistant")) customElements.define("db-assistant", DbAssistant);
})();
