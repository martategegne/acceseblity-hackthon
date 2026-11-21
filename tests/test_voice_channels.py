import base64

import pytest
from fastapi.testclient import TestClient

from api import main


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(main, "DB_PATH", tmp_path / "voice-channels.sqlite3")
    monkeypatch.setenv("OFFLINE_MODE", "true")
    main.initialize()
    return TestClient(main.app)


def test_amharic_voice_note_uses_course_answer_and_returns_read_back_audio(client, monkeypatch):
    class FakeVoice:
        def transcribe(self, audio, language):
            assert audio == b"amharic-note"
            assert language == "am"
            return {"transcript": "የቨርቹዋል አሲስታንት ሥራ ምንድነው?", "confidence": 0.93}

        def synthesize(self, text, language):
            assert language == "am"
            assert text
            return b"wav-answer"

    monkeypatch.setattr(main, "local_provider", FakeVoice)
    data_url = "data:audio/ogg;base64," + base64.b64encode(b"amharic-note").decode("ascii")

    response = client.post(
        "/api/v1/voice/notes",
        json={"audioDataUrl": data_url, "audioMimeType": "audio/ogg", "language": "am"},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["channel"] == "voice-note"
    assert body["language"] == "am"
    assert body["transcript"].startswith("የቨርቹዋል")
    assert body["answerStatus"] == "answered"
    assert body["audio"] == {
        "mimeType": "audio/wav",
        "dataUrl": "data:audio/wav;base64," + base64.b64encode(b"wav-answer").decode("ascii"),
    }


def test_voice_note_keeps_text_answer_available_when_tts_is_not_configured(client, monkeypatch):
    class FakeVoice:
        def transcribe(self, audio, language):
            return {"transcript": "What is virtual assistant work?", "confidence": 0.9}

        def synthesize(self, text, language):
            raise RuntimeError("no Amharic TTS model")

    monkeypatch.setattr(main, "local_provider", FakeVoice)
    data_url = "data:audio/webm;base64," + base64.b64encode(b"note").decode("ascii")

    response = client.post(
        "/api/v1/voice/notes",
        json={"audioDataUrl": data_url, "audioMimeType": "audio/webm", "language": "am"},
    )

    assert response.status_code == 200
    assert response.json()["answerText"]
    assert response.json()["audio"] is None


def test_voice_call_webhooks_gather_amharic_and_share_tutor_handoff(client, monkeypatch):
    monkeypatch.setenv("VOICE_CALL_LANGUAGE", "am")
    inbound = client.post("/voice/inbound")
    assert inbound.status_code == 200
    assert "<Gather" in inbound.text
    assert 'language="am-ET"' in inbound.text

    answer = client.post(
        "/voice/answer",
        data={"SpeechResult": "አስተማሪ ጠይቅ", "Language": "am-ET", "From": "+251911111111"},
    )
    assert answer.status_code == 200
    assert "የአስተማሪ" in answer.text
    assert "<Say" in answer.text
    with main.connect() as db:
        row = db.execute("SELECT language, page, note FROM escalations").fetchone()
    assert row["language"] == "am"
    assert row["page"].startswith("voice-call:")
    assert row["note"] == "Voice call tutor request"
