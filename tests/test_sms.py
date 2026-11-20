"""Tests for the SMS inbound endpoint (POST /sms/inbound)."""
import hashlib
import json
import re
import sqlite3
from pathlib import Path
from unittest.mock import MagicMock, patch
from urllib.parse import parse_qs
from fastapi.testclient import TestClient
import pytest
from cryptography.fernet import Fernet

from api.main import (
    app,
    DB_PATH,
    _RATE_LIMIT_EVENTS,
    connect,
    decrypt_sms_phone,
    format_sms_message,
    hash_phone,
    normalize_ethiopian_phone,
    send_sms_job_alerts,
    _sms_units,
)
from api.localization import api_message


@pytest.fixture(autouse=True)
def setup_db(tmp_path, monkeypatch):
    test_db = tmp_path / "test_escalations.sqlite3"
    monkeypatch.setattr("api.main.DB_PATH", test_db)
    _RATE_LIMIT_EVENTS.clear()
    from api.main import initialize
    initialize()
    yield test_db


@pytest.fixture
def client():
    return TestClient(app)


def test_sms_inbound_missing_text_returns_400(client):
    res = client.post("/sms/inbound", json={"from": "+251911223344"})
    assert res.status_code == 400
    assert "Send a text message." in res.text

    res_empty = client.post("/sms/inbound", json={"from": "+251911223344", "text": "   "})
    assert res_empty.status_code == 400
    assert "Send a text message." in res_empty.text


def test_sms_inbound_english_question(client):
    res = client.post("/sms/inbound", json={"from": "+12025550199", "text": "Can artificial intelligence draft emails for virtual assistants?"})
    assert res.status_code == 200
    assert res.headers["content-type"].startswith("text/plain")
    assert len(res.text) <= 160
    assert "Course s2" in res.text


def test_sms_inbound_amharic_question(client):
    res = client.post("/sms/inbound", json={"from": "+251911000000", "text": "አርቴፊሻል ኢንተለጀንስ የሰዎችን ሥራ ይተካል?"})
    assert res.status_code == 200
    assert res.headers["content-type"].startswith("text/plain")
    assert len(res.text) <= 160
    assert api_message("am", "sms_source_prefix") in res.text


@pytest.mark.parametrize("language", ["en", "am", "ti", "om", "so"])
def test_sms_language_choice_localizes_course_and_complete_tutor_handoff(client, monkeypatch, language):
    sender = "+251911123456"
    sections = json.loads(
        (Path(__file__).parents[1] / "demo" / "data" / "content.json").read_text(encoding="utf-8")
    )
    section = sections[0]
    selected = client.post("/sms/inbound", json={"from": sender, "text": f"LANG {language.upper()}"})
    assert selected.status_code == 200
    assert selected.text == api_message(language, "sms_language_saved")

    course = client.post(
        "/sms/inbound", json={"from": sender, "text": section["titles"][language]}
    )
    assert course.status_code == 200
    assert api_message(language, "sms_source_prefix") in course.text
    assert "s1" in course.text
    assert _sms_units(course.text) <= 160

    off_topic = client.post("/sms/inbound", json={"from": sender, "text": "How do I bake bread?"})
    assert off_topic.status_code == 200
    assert api_message(language, "sms_person_instruction") in off_topic.text
    assert api_message(language, "sms_source_prefix") not in off_topic.text

    opened = client.post("/sms/inbound", json={"from": sender, "text": "PERSON"})
    reference = re.search(r"STATUS ([A-F0-9]{8})", opened.text)
    assert reference
    assert _sms_units(opened.text) <= 160
    with connect() as db:
        row = db.execute(
            "SELECT id, language FROM escalations WHERE page=? ORDER BY created_at DESC LIMIT 1",
            (f"sms:{hash_phone(sender)}",),
        ).fetchone()
    assert row and row["language"] == language

    monkeypatch.setenv("HELPER_TOKEN", "localized-sms-helper-token")
    helper_headers = {"X-Helper-Token": "localized-sms-helper-token"}
    update = client.post(
        f"/api/v1/escalations/{row['id']}/reply",
        headers=helper_headers,
        json={"text": "Please review the lesson source.", "resolve": False},
    )
    assert update.status_code == 200
    status = client.post(
        "/sms/inbound", json={"from": sender, "text": f"STATUS {reference.group(1)}"}
    )
    assert status.status_code == 200
    assert api_message(language, "sms_tutor_update_prefix") in status.text
    assert "STATUS " + reference.group(1) in status.text
    assert _sms_units(status.text) <= 160

    closed = client.post(
        f"/api/v1/escalations/{row['id']}/reply",
        headers=helper_headers,
        json={"text": "Please review the lesson source."},
    )
    assert closed.status_code == 200
    final = client.post(
        "/sms/inbound", json={"from": sender, "text": f"STATUS {reference.group(1)}"}
    )
    assert api_message(language, "sms_tutor_reply_prefix") in final.text
    assert "STATUS " not in final.text
    assert client.delete(
        f"/api/v1/escalations/{row['id']}", headers=helper_headers
    ).status_code == 200


def test_sms_inbound_person_command(client):
    phone = "+251911123456"
    expected_hash = hash_phone(phone)

    res = client.post("/sms/inbound", json={"from": phone, "text": "PERSON"})
    assert res.status_code == 200
    assert res.headers["content-type"].startswith("text/plain")
    assert _sms_units(res.text) <= 160
    assert "STATUS " in res.text
    assert "23:00" in res.text
    assert "not guaranteed" in res.text

    # Verify that raw phone number is NEVER stored; only phone hash
    with connect() as db:
        row = db.execute("SELECT * FROM escalations ORDER BY created_at DESC LIMIT 1").fetchone()
        assert row is not None
        assert phone not in row["page"]
        assert phone not in row["note"]
        assert phone not in row["conversation"]
        assert expected_hash in row["note"] or expected_hash in row["page"]


def test_sms_person_request_can_check_for_a_tutor_update(client, monkeypatch):
    phone = "+251911123456"
    response = client.post("/sms/inbound", json={"from": phone, "text": "PERSON"})
    reference = response.text.rsplit("STATUS ", 1)[1]
    assert len(reference) == 8
    assert _sms_units(response.text) <= 160

    pending = client.post("/sms/inbound", json={"from": phone, "text": f"STATUS {reference}"})
    assert "No tutor reply yet" in pending.text
    assert "STATUS " + reference in pending.text
    assert _sms_units(pending.text) <= 160

    with connect() as db:
        ticket = db.execute(
            "SELECT id FROM escalations WHERE page=?",
            (f"sms:{hash_phone(phone)}",),
        ).fetchone()
    monkeypatch.setenv("HELPER_TOKEN", "test-helper-token")
    reply = client.post(
        f"/api/v1/escalations/{ticket['id']}/reply",
        headers={"X-Helper-Token": "test-helper-token"},
        json={"text": "Please review the lesson source."},
    )
    assert reply.status_code == 200
    answered = client.post("/sms/inbound", json={"from": phone, "text": f"STATUS {reference}"})
    assert "Please review the lesson source." in answered.text
    assert "STATUS " not in answered.text
    assert _sms_units(answered.text) <= 160

    other_sender = client.post(
        "/sms/inbound",
        json={"from": "+251922334455", "text": f"STATUS {reference}"},
    )
    assert "No matching request" in other_sender.text


def test_sms_inbound_jobs_command(client):
    res_en = client.post("/sms/inbound", json={"from": "+12025550123", "text": "JOBS"})
    assert res_en.status_code == 200
    assert res_en.headers["content-type"].startswith("text/plain")
    assert len(res_en.text) <= 160
    assert "Jobs:" in res_en.text
    assert "1." in res_en.text and "2." in res_en.text and "3." in res_en.text
    assert "Inbox Support Assistant" in res_en.text or "Executive VA" in res_en.text

    res_am = client.post("/sms/inbound", json={"from": "+251911111111", "text": "ክፍት JOBS"})
    assert res_am.status_code == 200
    assert len(res_am.text) <= 160


def configure_sms_alerts(monkeypatch):
    monkeypatch.setenv("OFFLINE_MODE", "false")
    monkeypatch.setenv("TWILIO_ACCOUNT_SID", "AC-test-account")
    monkeypatch.setenv("TWILIO_AUTH_TOKEN", "test-auth")
    monkeypatch.setenv("TWILIO_FROM_NUMBER", "+251900000000")
    monkeypatch.setenv("SMS_ENCRYPTION_KEY", Fernet.generate_key().decode("ascii"))


def test_sms_inbound_alert_opt_in_disclosure_and_opt_out(client, monkeypatch):
    phone = "+251922334455"
    p_hash = hash_phone(phone)
    configure_sms_alerts(monkeypatch)

    disclosure = client.post("/sms/inbound", json={"from": phone, "text": "ALERT"})
    assert "+251900000000" in disclosure.text
    assert "carrier rates may apply" in disclosure.text
    with connect() as db:
        assert db.execute("SELECT COUNT(*) FROM sms_alerts").fetchone()[0] == 0

    confirmation = client.post("/sms/inbound", json={"from": phone, "text": "ALERT ON"})
    assert "ALERT YES" in confirmation.text
    assert "+251900000000" in confirmation.text
    assert "carrier rates may apply" in confirmation.text

    with connect() as db:
        row = db.execute("SELECT * FROM sms_alerts WHERE phone_hash = ?", (p_hash,)).fetchone()
        assert row is not None
        assert row["active"] == 2

    res_yes = client.post("/sms/inbound", json={"from": phone, "text": "ALERT YES"})
    assert "Job alerts are on" in res_yes.text
    with connect() as db:
        row = db.execute("SELECT * FROM sms_alerts WHERE phone_hash = ?", (p_hash,)).fetchone()
        assert row["active"] == 1

    res_off = client.post("/sms/inbound", json={"from": phone, "text": "ALERT OFF"})
    assert res_off.status_code == 200
    assert "Job alerts turned off." in res_off.text

    with connect() as db:
        row = db.execute("SELECT * FROM sms_alerts WHERE phone_hash = ?", (p_hash,)).fetchone()
        assert row is not None
        assert row["active"] == 0


def test_sms_job_alert_link_is_preserved_in_one_segment(client, monkeypatch):
    configure_sms_alerts(monkeypatch)
    with connect() as db:
        db.execute(
            "INSERT INTO sms_alerts(phone_hash, active, phone_ciphertext, updated_at) VALUES(?, 1, ?, ?)",
            (hash_phone("+251911223344"), "encrypted-phone", "2026-11-15T00:00:00+00:00"),
        )
    requests = []

    def fake_urlopen(request, timeout=8):
        requests.append(request)
        response = MagicMock()
        response.status = 201
        response.__enter__.return_value = response
        return response

    link = "/savanna/pages/jobs.html#test-listing"
    with patch("api.main.decrypt_sms_phone", return_value="+251911223344"), \
         patch("urllib.request.urlopen", side_effect=fake_urlopen):
        result = send_sms_job_alerts("New: Spreadsheet Helper (TEST) | On site | Addis Ababa", link)

    assert result == {"sent": 1, "failed": 0, "skipped": 0}
    body = parse_qs(requests[0].data.decode("utf-8"))["Body"][0]
    assert body.endswith(
        "https://github.com/hudahussen2424-hash/acceseblity-hackthon/blob/main/"
        "savanna/pages/jobs.html#test-listing"
    )
    assert "Spreadsheet Helper" in body
    assert _sms_units(body) <= 160


def test_sms_truncation_at_word_boundary():
    long_answer = "This is a very long text explanation about virtual assistant work and artificial intelligence that exceeds standard SMS 160 characters length limit easily and needs clean word boundary truncation."
    formatted = format_sms_message(long_answer, "Course s2")
    assert len(formatted) <= 160
    assert formatted.endswith("(Course s2)")
    # Must not truncate mid-word
    assert not formatted.endswith("wor... (Course s2)")


def test_sms_uses_one_segment_budget_for_amharic_and_gsm_text():
    amharic = format_sms_message("የሥራ ማሳወቂያ " * 20, "Course s2")
    english = format_sms_message("A long English update " * 20, "Course s2")
    assert _sms_units(amharic) <= 70
    assert _sms_units(english) <= 160
    assert amharic.endswith("(Course s2)")
    assert english.endswith("(Course s2)")


def test_sms_job_alert_calls_configured_twilio_gateway(client, monkeypatch):
    from urllib.parse import parse_qs

    account_sid = "AC-test-account"
    monkeypatch.setenv("OFFLINE_MODE", "false")
    monkeypatch.setenv("TWILIO_ACCOUNT_SID", account_sid)
    monkeypatch.setenv("TWILIO_AUTH_TOKEN", "test-auth")
    monkeypatch.setenv("TWILIO_FROM_NUMBER", "+251900000000")
    with connect() as db:
        db.execute(
            "INSERT INTO sms_alerts(phone_hash, active, phone_ciphertext, updated_at) VALUES(?, 1, ?, ?)",
            (hash_phone("+251911223344"), "encrypted-phone", "2026-11-15T00:00:00+00:00"),
        )

    requests = []

    def fake_urlopen(request, timeout=8):
        requests.append(request)
        response = MagicMock()
        response.status = 201
        response.__enter__.return_value = response
        return response

    with patch("api.main.decrypt_sms_phone", return_value="+251911223344"), \
         patch("urllib.request.urlopen", side_effect=fake_urlopen):
        result = send_sms_job_alerts("New job in Addis Ababa", "https://example.test/jobs/101")

    assert result == {"sent": 1, "failed": 0, "skipped": 0}
    assert len(requests) == 1
    assert requests[0].full_url == f"https://api.twilio.com/2010-04-01/Accounts/{account_sid}/Messages.json"
    assert requests[0].get_header("Authorization").startswith("Basic ")
    payload = parse_qs(requests[0].data.decode("utf-8"))
    assert payload["To"] == ["+251911223344"]
    assert payload["From"] == ["+251900000000"]
    assert payload["Body"] == ["New job in Addis Ababa https://example.test/jobs/101"]


@pytest.mark.parametrize(("entered", "expected"), [
    ("0911223344", "+251911223344"),
    ("0711223344", "+251711223344"),
    ("+251 9 1122 3344", "+251911223344"),
    ("+251711223344", "+251711223344"),
])
def test_ethiopian_phone_normalization(entered, expected):
    assert normalize_ethiopian_phone(entered) == expected


@pytest.mark.parametrize(("entered",), [("09112233",), ("0611223344",), ("+251811223344",)])
def test_rejects_unsupported_ethiopian_phone_shapes(entered):
    assert normalize_ethiopian_phone(entered) is None


def test_sms_alert_subscription_hash_uses_canonical_ethiopian_number(client, monkeypatch):
    configure_sms_alerts(monkeypatch)
    client.post("/sms/inbound", json={"from": "0911223344", "text": "ALERT ON"})
    client.post("/sms/inbound", json={"from": "+251911223344", "text": "ALERT ON"})
    national = client.post("/sms/inbound", json={"from": "0911223344", "text": "ALERT YES"})
    international = client.post("/sms/inbound", json={"from": "+251911223344", "text": "ALERT YES"})
    assert national.status_code == international.status_code == 200
    canonical_hash = hash_phone("+251911223344")
    with connect() as db:
        rows = db.execute("SELECT phone_hash FROM sms_alerts WHERE phone_hash=?", (canonical_hash,)).fetchall()
    assert len(rows) == 1


def test_escalation_stores_canonical_ethiopian_phone(client):
    response = client.post("/api/v1/escalations", json={
        "conversation": [], "language": "en", "page": "http://localhost/lesson",
        "note": "", "phone": "0711223344"
    })
    assert response.status_code == 201
    with connect() as db:
        row = db.execute("SELECT phone FROM escalations WHERE id=?", (response.json()["ticketId"],)).fetchone()
    assert row["phone"] == "+251711223344"


def test_invalid_escalation_phone_is_rejected(client):
    response = client.post("/api/v1/escalations", json={
        "conversation": [], "language": "en", "page": "http://localhost/lesson",
        "note": "", "phone": "0611223344"
    })
    assert response.status_code == 400
    assert "Ethiopian mobile number" in response.json()["detail"]
