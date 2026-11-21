import json
import re

from api import main, telegram_bot


def test_language_detection_and_explicit_language_preference(monkeypatch, tmp_path):
    monkeypatch.setattr(main, "DB_PATH", tmp_path / "bot.sqlite3")
    telegram_bot.initialize_storage()

    assert telegram_bot.detect_language("ሰላም") == "am"
    assert telegram_bot.detect_language("Hello") == "en"
    telegram_bot.set_chat_language(123, "am")
    assert telegram_bot.chat_language(123, "Hello") == "am"


def test_alert_subscription_is_persisted_and_can_be_removed(monkeypatch, tmp_path):
    monkeypatch.setattr(main, "DB_PATH", tmp_path / "bot.sqlite3")
    telegram_bot.initialize_storage()

    assert telegram_bot.handle_text(123, "/alerts on") == "Job alerts are on."
    with main.connect() as db:
        assert db.execute(
            "SELECT chat_id FROM telegram_alert_subscribers"
        ).fetchall()[0]["chat_id"] == 123

    assert telegram_bot.handle_text(123, "/alerts off") == "Job alerts are off."
    with main.connect() as db:
        assert db.execute(
            "SELECT COUNT(*) FROM telegram_alert_subscribers"
        ).fetchone()[0] == 0


def test_person_ticket_contains_recent_chat_and_status_follow_up(monkeypatch, tmp_path):
    monkeypatch.setattr(main, "DB_PATH", tmp_path / "bot.sqlite3")
    telegram_bot.initialize_storage()
    webhook_calls = []
    monkeypatch.setattr(telegram_bot, "notify_webhook", lambda *args: webhook_calls.append(args))
    telegram_bot.record_message(123, "user", "How do I organize email?")
    telegram_bot.record_message(123, "assistant", "Start with clear folders.")

    response = telegram_bot.handle_text(123, "/person")
    assert "23:00" in response
    assert "not guaranteed" in response
    assert "morning" not in response
    reference = re.search(r"/status ([A-F0-9]{8})", response).group(1)
    with main.connect() as db:
        row = db.execute("SELECT conversation, note FROM escalations").fetchone()
        ticket_id = db.execute("SELECT id FROM escalations").fetchone()["id"]
    assert json.loads(row["conversation"]) == [
        {"role": "user", "text": "How do I organize email?"},
        {"role": "assistant", "text": "Start with clear folders."},
    ]
    assert "123" in row["note"]
    assert webhook_calls == [(ticket_id,)]
    assert "No tutor reply yet" in telegram_bot.handle_text(123, f"/status {reference}")
    assert "No matching" in telegram_bot.handle_text(456, f"/status {reference}")
    with main.connect() as db:
        db.execute(
            "UPDATE escalations SET reply=?, status='answered' WHERE id=?",
            ("Please review the lesson source.", ticket_id),
        )
    assert "Please review the lesson source." in telegram_bot.handle_text(123, f"/status {reference}")


def test_regular_message_uses_shared_answer_pipeline(monkeypatch, tmp_path):
    monkeypatch.setattr(main, "DB_PATH", tmp_path / "bot.sqlite3")
    telegram_bot.initialize_storage()
    calls = []

    async def answer_question(question, language, sections, **kwargs):
        calls.append((question, language, sections))
        return {
            "answer": "Use a clear process.",
            "sources": [{"title": "Working well", "url": "lesson.html#work"}],
        }

    monkeypatch.setattr(telegram_bot, "answer_question", answer_question)
    monkeypatch.setattr(telegram_bot, "indexed_sections", lambda: [{"id": "test"}])

    response = telegram_bot.handle_text(123, "How should I work?")

    assert calls == [("How should I work?", "en", [{"id": "test"}])]
    assert "Source:" in response
    assert response.endswith("lesson.html#work")


def test_amharic_voice_note_uses_shared_answer_and_tutor_commands(monkeypatch, tmp_path):
    monkeypatch.setattr(main, "DB_PATH", tmp_path / "bot.sqlite3")
    telegram_bot.initialize_storage()
    telegram_bot.set_chat_language(123, "am")

    class FakeVoice:
        def transcribe(self, audio, language):
            assert audio == b"voice-note"
            assert language == "am"
            return {"transcript": "የቨርቹዋል አሲስታንት ሥራ ምንድነው?", "confidence": 0.94}

        def synthesize(self, text, language):
            assert language == "am"
            return b"wav-answer"

    monkeypatch.setattr(telegram_bot, "local_provider", FakeVoice)

    async def answer_question(question, language, sections, **kwargs):
        assert language == "am"
        return {
            "answer": "የኮርሱ መልስ።",
            "answerStatus": "answered",
            "sources": [{"title": "ሥራ", "url": "lesson.html#work"}],
        }

    monkeypatch.setattr(telegram_bot, "answer_question", answer_question)
    result = telegram_bot.handle_voice(123, b"voice-note")
    assert result["transcript"].startswith("የቨርቹዋል")
    assert "የኮርሱ መልስ" in result["text"]
    assert result["audio"] == b"wav-answer"

    monkeypatch.setattr(
        telegram_bot,
        "local_provider",
        lambda: type("NoVoice", (), {
            "transcribe": lambda self, audio, language: {"transcript": "አስተማሪ ጠይቅ", "confidence": 0.9},
            "synthesize": lambda self, text, language: b"handoff-audio",
        })(),
    )
    handoff = telegram_bot.handle_voice(123, b"voice-note")
    assert "ጥያቄ" in handoff["text"] or "ተመዝግቧል" in handoff["text"]
    with main.connect() as db:
        assert db.execute("SELECT COUNT(*) FROM escalations").fetchone()[0] == 1


def test_answers_include_absolute_source_and_not_found_offers_person(monkeypatch):
    result = {
        "answer": "Use a clear process.",
        "sources": [{"title": "Working well", "url": "savanna/lesson.html#work"}],
    }
    response = telegram_bot.format_answer(result, "en")
    assert "Source: Working well — https://github.com/" in response
    assert response.endswith("savanna/lesson.html#work")

    not_found = telegram_bot.format_answer(
        {"answer": "I could not find this in the course.", "sources": []}, "en"
    )
    assert "I couldn't find" in not_found
    assert "/person" in not_found


def test_jobs_command_reads_json_file(monkeypatch, tmp_path):
    monkeypatch.setattr(main, "DB_PATH", tmp_path / "bot.sqlite3")
    telegram_bot.initialize_storage()
    jobs_file = tmp_path / "jobs.json"
    jobs_file.write_text(
        json.dumps([{
            "title": "Test listing",
            "translations": {
                "am": {"title": "የሙከራ ሥራ", "description": "ልምምድ።"},
            },
            "employer": "Demo team",
            "location": "Remote",
            "remote": True,
            "description": "Practice task.",
            "url": "/savanna/pages/jobs.html#test-listing",
        }]),
        encoding="utf-8",
    )
    monkeypatch.setattr(telegram_bot, "JOBS_FILE", jobs_file)

    response = telegram_bot.handle_text(123, "/jobs")
    assert "Test listing" in response
    assert "Demo team — Remote (Remote)" in response
    assert "Practice task." in response
    expected_url = "https://github.com/hudahussen2424-hash/"
    expected_url += "acceseblity-hackthon/blob/main/savanna/pages/jobs.html#test-listing"
    assert expected_url in response

    telegram_bot.set_chat_language(123, "am")
    amharic_response = telegram_bot.handle_text(123, "/jobs")
    assert "የሙከራ ሥራ ማስታወቂያዎች" in amharic_response
    assert "የሙከራ ሥራ" in amharic_response
    assert "ልምምድ።" in amharic_response
    assert "(ከሩቅ)" in amharic_response
    assert "Test listing" not in amharic_response
