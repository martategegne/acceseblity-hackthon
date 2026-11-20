import asyncio
import json
from pathlib import Path
import pytest

from api.qa import (
    NOT_FOUND_TRANSLATIONS,
    OFF_TOPIC,
    OFF_TOPIC_TRANSLATIONS,
    SENSITIVE_REFUSAL,
    SENSITIVE_REFUSAL_TRANSLATIONS,
    answer_question,
)


SECTIONS = [
    {
        "id": "ai-va",
        "title": "Artificial intelligence for virtual assistants",
        "url": "/lesson#ai-va",
        "text": {
            "en": "Artificial intelligence can automate email drafting and spreadsheet organization for virtual assistants.",
            "am": "አርቴፊሻል ኢንተለጀንስ የኢሜይል ረቂቅ እና የስፕሬድሺት አደረጃጀት ለቨርቹዋል አሲስታንቶች ያከናውናል።",
        },
    },
    {
        "id": "future-va",
        "title": "Future of VA Work",
        "url": "/lesson#future-va",
        "text": {
            "en": "The future of virtual assistant work involves strong collaboration and remote tools.",
            "am": "የቨርቹዋል አሲስታንት ሥራ የወደፊት ተስፋ የትብብር መሣሪያዎችን ያካትታል።",
        },
    },
]
TRACK_LANGUAGES = ("en", "am", "ti", "om", "so")
MULTILINGUAL_SECTION = json.loads(
    (Path(__file__).parents[1] / "demo" / "data" / "content.json").read_text(encoding="utf-8")
)[0]


class FakeProvider:
    def __init__(self, result=None, error=None):
        self.result = result
        self.error = error
        self.calls = 0

    async def answer(self, question, sections, language):
        self.calls += 1
        if self.error:
            raise self.error
        return self.result


def test_below_threshold_does_not_call_provider(monkeypatch):
    monkeypatch.setenv("THRESHOLD", "0.5")
    provider = FakeProvider({"text": "unexpected answer"})
    result = asyncio.run(answer_question("What salary range do virtual assistants earn?", "en", SECTIONS, provider))
    assert provider.calls == 0
    assert result["mode"] == "search"
    assert result["answer"] == "I could not find this in the course."
    assert result["sources"] == []
    assert result["answerStatus"] == "not_found"


@pytest.mark.parametrize("language", TRACK_LANGUAGES)
def test_off_topic_questions_offer_a_person_without_fabricated_sources(language):
    provider = FakeProvider({"text": "unsupported answer"})
    result = asyncio.run(
        answer_question("How do I bake bread?", language, [MULTILINGUAL_SECTION], provider)
    )

    assert provider.calls == 0
    assert result["answer"] == OFF_TOPIC_TRANSLATIONS.get(language, OFF_TOPIC)
    assert result["answerStatus"] == "off_topic"
    assert result["sources"] == []
    assert result["grounding"]["evidence"] == []


@pytest.mark.parametrize("language", TRACK_LANGUAGES)
def test_course_answers_use_each_language_and_keep_the_lesson_citation(language):
    section = MULTILINGUAL_SECTION
    result = asyncio.run(
        answer_question(section["titles"][language], language, [section])
    )

    assert result["answerStatus"] == "answered"
    assert result["answer"] == section["text"][language]
    assert result["sources"] == [{"title": section["titles"][language], "url": section["url"]}]
    assert result["grounding"]["status"] == "verified"


@pytest.mark.parametrize("language", TRACK_LANGUAGES)
def test_related_question_below_threshold_uses_localized_not_found_without_source(monkeypatch, language):
    monkeypatch.setenv("THRESHOLD", "1.01")
    section = MULTILINGUAL_SECTION
    result = asyncio.run(
        answer_question(section["titles"][language], language, [section])
    )

    assert result["answer"] == NOT_FOUND_TRANSLATIONS[language]
    assert result["answerStatus"] == "not_found"
    assert result["sources"] == []
    assert result["grounding"]["evidence"] == []


def test_provider_failure_falls_back_to_best_section(monkeypatch):
    monkeypatch.setenv("THRESHOLD", "0.1")
    provider = FakeProvider(error=TimeoutError("provider timed out"))
    result = asyncio.run(answer_question("How does artificial intelligence help virtual assistants?", "en", SECTIONS, provider))
    assert provider.calls == 1
    assert result["mode"] == "search"
    assert "automate email drafting" in result["answer"]
    assert result["sources"] == [{"title": SECTIONS[0]["title"], "url": "/lesson#ai-va"}]
    assert result["answerStatus"] == "answered"


def test_provider_answer_only_returns_its_validated_citation(monkeypatch):
    monkeypatch.setenv("THRESHOLD", "0.1")
    excerpt = "Artificial intelligence can automate email drafting and spreadsheet organization for virtual assistants."
    provider = FakeProvider({"text": excerpt, "source_ids": ["ai-va"]})
    result = asyncio.run(answer_question("How does artificial intelligence help virtual assistants?", "en", SECTIONS, provider))
    assert result["mode"] == "ai"
    assert result["answer"] == excerpt
    assert result["sources"] == [{"title": SECTIONS[0]["title"], "url": "/lesson#ai-va"}]
    assert result["answerStatus"] == "answered"


@pytest.mark.parametrize("source_ids", [None, [], ["not-retrieved"]])
def test_uncited_or_unknown_provider_sources_fall_back_to_retrieval(monkeypatch, source_ids):
    monkeypatch.setenv("THRESHOLD", "0.1")
    provider = FakeProvider({"text": "Unsupported model claim.", "source_ids": source_ids})
    result = asyncio.run(answer_question("How does artificial intelligence help virtual assistants?", "en", SECTIONS, provider))
    assert result["mode"] == "search"
    assert "automate email drafting" in result["answer"]
    assert result["sources"] == [{"title": SECTIONS[0]["title"], "url": "/lesson#ai-va"}]


def test_unsubstantiated_provider_claim_falls_back_to_best_section(monkeypatch):
    monkeypatch.setenv("THRESHOLD", "0.1")
    # Provider returns a claim with an allowed source_id, but the claim is completely unsubstantiated by the section text
    provider = FakeProvider({"text": "Astronauts travel to Mars in nuclear rocket ships.", "source_ids": ["ai-va"]})
    result = asyncio.run(answer_question("How does artificial intelligence help virtual assistants?", "en", SECTIONS, provider))
    assert result["mode"] == "search"
    assert "automate email drafting" in result["answer"]
    assert result["sources"] == [{"title": SECTIONS[0]["title"], "url": "/lesson#ai-va"}]


def test_provider_near_match_with_unsupported_claim_falls_back(monkeypatch):
    monkeypatch.setenv("THRESHOLD", "0.1")
    # Token overlap alone must not validate a generated factual change.
    unsupported_answer = "Artificial intelligence can automate email drafting and spreadsheet deletion for virtual assistants."
    provider = FakeProvider({"text": unsupported_answer, "source_ids": ["ai-va"]})
    result = asyncio.run(answer_question("How does artificial intelligence help virtual assistants?", "en", SECTIONS, provider))
    assert result["mode"] == "search"
    assert "spreadsheet organization" in result["answer"]
    assert result["sources"] == [{"title": SECTIONS[0]["title"], "url": "/lesson#ai-va"}]


def test_amharic_retrieval_returns_best_section_with_amharic_text_and_link(monkeypatch):
    monkeypatch.setenv("THRESHOLD", "0.1")
    provider = FakeProvider(error=RuntimeError("no ai"))
    result = asyncio.run(answer_question("አርቴፊሻል ኢንተለጀንስ የሰዎችን ሥራ ይተካል?", "am", SECTIONS, provider))
    assert result["mode"] == "search"
    assert "አርቴፊሻል ኢንተለጀንስ" in result["answer"]
    assert len(result["sources"]) == 1
    assert result["sources"][0]["url"] == "/lesson#ai-va"


def test_retrieval_only_returns_single_best_section_link(monkeypatch):
    monkeypatch.setenv("THRESHOLD", "0.05")
    # Both sections score above threshold, but answer must return only the best section link
    result = asyncio.run(answer_question("virtual assistant work and artificial intelligence", "en", SECTIONS))
    assert result["mode"] == "search"
    assert len(result["sources"]) == 1
    assert result["sources"][0]["url"] in ("/lesson#ai-va", "/lesson#future-va")


def test_no_match_and_sensitive_answers_have_no_unrelated_sources(monkeypatch):
    monkeypatch.setenv("THRESHOLD", "0.5")
    unrelated = asyncio.run(answer_question("What salary range do virtual assistants earn?", "en", SECTIONS))
    sensitive = asyncio.run(answer_question("Can you give me legal advice?", "en", SECTIONS))
    assert unrelated["sources"] == []
    assert unrelated["answerStatus"] == "not_found"
    assert sensitive["sources"] == []


@pytest.mark.parametrize("language", TRACK_LANGUAGES)
def test_sensitive_topic_is_refused_without_provider_call(language):
    provider = FakeProvider({"text": "unsafe generated answer"})
    result = asyncio.run(
        answer_question("Can you give me legal advice?", language, SECTIONS, provider)
    )
    assert provider.calls == 0
    expected = SENSITIVE_REFUSAL_TRANSLATIONS.get(language, SENSITIVE_REFUSAL)
    assert result["answer"] == expected
    assert result["mode"] == "search"
    assert result["sources"] == []
    assert result["answerStatus"] == "refused"


@pytest.mark.parametrize("language", TRACK_LANGUAGES[1:])
def test_new_languages_return_localized_no_match_without_provider_fallback(language):
    provider = FakeProvider({"text": "English fallback", "source_ids": []})
    result = asyncio.run(answer_question("x", language, [], provider))

    assert result["answer"] == NOT_FOUND_TRANSLATIONS[language]
    assert result["answer"] != "I could not find this in the course."
    assert provider.calls == 0
    assert result["sources"] == []


@pytest.mark.parametrize(("question", "language"), [
    ("Gorsa fayyaa naaf kenni", "om"),
    ("Talo caafimaad i sii", "so"),
    ("ምኽሪ ሕጊ ሃበኒ", "ti"),
    ("أريد نصيحة قانونية", "ar"),
])
def test_new_languages_use_localized_sensitive_topic_refusal(question, language):
    provider = FakeProvider({"text": "unsafe generated answer"})
    result = asyncio.run(answer_question(question, language, SECTIONS, provider))

    assert provider.calls == 0
    assert result["answer"] == SENSITIVE_REFUSAL_TRANSLATIONS[language]
    assert result["sources"] == []
