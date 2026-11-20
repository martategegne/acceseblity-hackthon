import json
import re
from pathlib import Path

from api.main import SUPPORTED_LANGUAGES, _HANDOFF_REASONS, indexed_sections
from api.qa import OFF_TOPIC_TRANSLATIONS
from api.voice import LANGUAGES


ROOT = Path(__file__).parents[1]
LOCALE_DIR = ROOT / "module" / "i18n"


def test_selector_api_voice_and_locale_files_share_one_language_set():
    locale_files = {
        path.stem for path in LOCALE_DIR.glob("*.json")
        if path.name != "topics.json"
    }
    component = (ROOT / "module" / "db-assistant.js").read_text(encoding="utf-8")
    language_selector = re.search(r'<select id="language-select".*?</select>', component, re.DOTALL)
    assert language_selector
    selector = set(re.findall(r'<option value="([a-z]+)"', language_selector.group()))

    assert locale_files == SUPPORTED_LANGUAGES == set(LANGUAGES) == selector


def test_offered_locales_are_complete_or_explicitly_marked_incomplete():
    english = json.loads((LOCALE_DIR / "en.json").read_text(encoding="utf-8"))
    required_keys = set(english["strings"]) - {"translationIncomplete", "offTopic"}
    request_reason_keys = {
        "escalationReasonLabel",
        "escalationReasonChoose",
        "escalationReasonAnswerNotFound",
        "escalationReasonPerson",
        "escalationReasonIncorrect",
        "escalationReasonOther",
        "escalationReasonRequired",
        "escalationOtherDetails",
        "escalationOtherRequired",
        "microphonePermissionDenied",
        "voiceCommandUnavailable",
    }

    for language in SUPPORTED_LANGUAGES:
        locale = json.loads((LOCALE_DIR / f"{language}.json").read_text(encoding="utf-8"))
        assert request_reason_keys <= set(locale["strings"])
        if language in {"en", "am"}:
            assert locale["strings"]["offTopic"]
        if language == "ar":
            assert locale["incomplete"] is True
            assert locale["strings"]["translationIncomplete"]
        else:
            assert required_keys <= set(locale["strings"])


def test_tutor_request_choices_match_supported_handoff_reasons():
    component = (ROOT / "module" / "db-assistant.js").read_text(encoding="utf-8")
    selector = re.search(r'<select id="escalation-reason".*?</select>', component, re.DOTALL)
    assert selector
    choices = set(re.findall(r'<option value="([^"]+)"', selector.group()))

    assert choices - {""} == _HANDOFF_REASONS


def test_amharic_job_index_uses_localized_titles_and_descriptions():
    jobs = [section for section in indexed_sections() if section.get("type") == "job"]

    assert len(jobs) == 8
    for job in jobs:
        translation = job["translations"]["am"]
        assert job["titles"]["am"] == translation["title"]
        assert translation["description"] in job["text"]["am"]


def test_arabic_sensitive_topics_are_covered_by_the_refusal_guard():
    topics = json.loads((LOCALE_DIR / "topics.json").read_text(encoding="utf-8"))

    assert topics["ar"]


def test_off_topic_copy_matches_api_and_widget_for_reviewed_locale_fields():
    english = json.loads((LOCALE_DIR / "en.json").read_text(encoding="utf-8"))
    amharic = json.loads((LOCALE_DIR / "am.json").read_text(encoding="utf-8"))

    assert english["strings"]["offTopic"] == OFF_TOPIC_TRANSLATIONS["en"]
    assert amharic["strings"]["offTopic"] == amharic["api"]["off_topic"]
    assert amharic["api"]["off_topic"] == OFF_TOPIC_TRANSLATIONS["am"]
