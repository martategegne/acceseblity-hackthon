import json
import re
from pathlib import Path

from api.main import SUPPORTED_LANGUAGES, _HANDOFF_REASONS, indexed_sections
from api.localization import api_message
from api.qa import OFF_TOPIC_TRANSLATIONS
from api.voice import LANGUAGES


ROOT = Path(__file__).parents[1]
LOCALE_DIR = ROOT / "module" / "i18n"
TRACK_LANGUAGES = {"en", "am", "ti", "om", "so"}
CORE_API_KEYS = {
    "not_found", "off_topic", "sensitive_refusal", "error_question", "error_language",
    "error_ticket_conversation", "error_ticket_message", "error_ticket_language",
    "error_ticket_page", "error_ticket_note", "error_ticket_phone", "sms_language_saved",
    "sms_language_invalid", "sms_language_instructions", "sms_language_needs_sender", "sms_help",
    "sms_empty_text", "sms_request_queued", "sms_status_instructions", "sms_same_sender",
    "sms_no_match", "sms_tutor_reply_prefix", "sms_tutor_update_prefix", "sms_no_tutor_reply",
    "sms_person_instruction", "sms_jobs_prefix", "sms_source_prefix", "sms_invalid_json",
    "sms_invalid_object", "sms_language_reset", "sms_sender_needed", "sms_alert_unavailable",
    "sms_alert_disclosure", "sms_alert_confirmation", "sms_alert_first", "sms_alert_enabled",
    "sms_alert_off", "sms_alert_sender_needed",
}


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
        if language in TRACK_LANGUAGES:
            assert locale["strings"]["offTopic"]
            assert CORE_API_KEYS <= set(locale["api"])
            assert locale["api"]["off_topic"] == locale["strings"]["offTopic"]
        if language == "ar":
            assert locale["incomplete"] is True
            assert locale["strings"]["translationIncomplete"]
            assert "offTopic" not in locale["strings"]
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


def test_off_topic_copy_matches_api_and_widget_for_all_track_languages():
    for language in TRACK_LANGUAGES:
        locale = json.loads((LOCALE_DIR / f"{language}.json").read_text(encoding="utf-8"))
        assert locale["strings"]["offTopic"] == locale["api"]["off_topic"]
        assert locale["api"]["off_topic"] == OFF_TOPIC_TRANSLATIONS[language]
        assert api_message(language, "off_topic") == locale["strings"]["offTopic"]


def test_arabic_stays_explicitly_incomplete_and_api_off_topic_falls_back_to_english():
    arabic = json.loads((LOCALE_DIR / "ar.json").read_text(encoding="utf-8"))
    english = json.loads((LOCALE_DIR / "en.json").read_text(encoding="utf-8"))
    assert arabic["incomplete"] is True
    assert "offTopic" not in arabic["strings"]
    assert api_message("ar", "off_topic") == english["api"]["off_topic"]
