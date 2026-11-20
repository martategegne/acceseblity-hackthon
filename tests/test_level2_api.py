"""Tests for Level 2 API endpoints, status codes, CORS, and webhooks."""
import json
import os
from pathlib import Path
from unittest.mock import MagicMock, patch
from fastapi.testclient import TestClient
import pytest

from api import qa
from api.qa import OFF_TOPIC_TRANSLATIONS, SENSITIVE_REFUSAL_TRANSLATIONS
from api.main import (
    app, DB_PATH, connect, initialize, record_course_gap_analytics,
    save_escalation_record,
)


@pytest.fixture(autouse=True)
def setup_db(tmp_path, monkeypatch):
    test_db = tmp_path / "test_escalations_l2.sqlite3"
    monkeypatch.setattr("api.main.DB_PATH", test_db)
    initialize()
    yield test_db


@pytest.fixture
def client():
    return TestClient(app)


def test_swagger_docs_endpoint(client):
    res = client.get("/docs")
    assert res.status_code == 200
    assert "swagger-ui" in res.text.lower() or "html" in res.headers["content-type"]


def test_demo_site_assets_are_served_by_the_api(client):
    lesson = client.get("/")
    assert lesson.status_code == 200
    assert "<db-assistant" in lesson.text
    assert client.get("/sw.js").status_code == 200
    assert client.get("/module/db-assistant.js").status_code == 200
    assert client.get("/demo/data/content.json").status_code == 200
    assert client.get("/savanna/pages/jobs.html").status_code == 200


def test_health_endpoints_report_database_and_content_readiness(client):
    assert client.get("/health/live").json() == {"status": "ok"}
    assert client.get("/health/ready").json() == {"status": "ready"}


def test_course_gap_radar_is_helper_protected_and_has_an_honest_empty_state(client, monkeypatch):
    monkeypatch.setenv("HELPER_TOKEN", "radar-helper-secret")
    assert client.get("/api/v1/helper/course-gap-radar").status_code == 401

    response = client.get(
        "/api/v1/helper/course-gap-radar",
        headers={"X-Helper-Token": "radar-helper-secret"},
    )
    assert response.status_code == 200
    report = response.json()
    assert report["hasActivity"] is False
    assert report["topAnsweredTopics"] == []
    assert report["notFoundCandidates"] == []
    assert [row["language"] for row in report["byLanguage"]] == ["en", "am", "ti", "om", "so"]
    assert all(row["total"]["count"] == 0 for row in report["byLanguage"])


def test_course_gap_aggregates_group_counts_and_never_store_questions_or_identity(client, monkeypatch):
    monkeypatch.setenv("HELPER_TOKEN", "radar-helper-secret")
    monkeypatch.setenv("AI_PROVIDER", "none")
    monkeypatch.setenv("OFFLINE_MODE", "true")
    sections = json.loads(
        (Path(__file__).parents[1] / "demo" / "data" / "content.json").read_text(encoding="utf-8")
    )
    section = sections[0]
    question = section["titles"]["en"]
    first_answer = client.post("/api/v1/ask", json={"question": question, "language": "en"})
    assert first_answer.status_code == 200
    assert first_answer.json()["answerStatus"] == "answered"

    # Add aggregate-only repeats with a unique canary so accidental prompt persistence is detectable.
    canary = "PRIVATE_QUESTION_CANARY_84f7"
    synthetic_answer = {
        "answerStatus": "answered",
        "sources": [{"url": section["url"], "type": "lesson"}],
    }
    for _ in range(2):
        record_course_gap_analytics(canary, "en", sections, synthetic_answer)

    with connect() as db:
        columns = {row[1] for row in db.execute("PRAGMA table_info(course_gap_aggregates)")}
        rows = [dict(row) for row in db.execute("SELECT * FROM course_gap_aggregates")]
    assert columns == {"day_bucket", "language", "topic_id", "outcome", "count"}
    assert len(rows) == 1
    assert rows[0]["topic_id"] == section["id"]
    assert rows[0]["outcome"] == "answered"
    assert rows[0]["count"] == 3
    assert canary not in json.dumps(rows)
    assert question not in json.dumps(rows)

    report = client.get(
        "/api/v1/helper/course-gap-radar",
        headers={"X-Helper-Token": "radar-helper-secret"},
    ).json()
    assert report["hasActivity"] is True
    assert report["topAnsweredTopics"] == [{"topicId": section["id"], "title": section["titles"]["en"], "count": 3}]
    english = next(row for row in report["byLanguage"] if row["language"] == "en")
    assert english["total"] == {"count": 3, "suppressed": False}
    assert english["outcomes"]["answered"] == {"count": 3, "suppressed": False}


def test_course_gap_radar_groups_supported_languages_and_suppresses_small_cells(client, monkeypatch):
    monkeypatch.setenv("HELPER_TOKEN", "radar-helper-secret")
    sections = json.loads(
        (Path(__file__).parents[1] / "demo" / "data" / "content.json").read_text(encoding="utf-8")
    )
    for language in ("en", "am", "ti", "om", "so"):
        for index in range(3):
            record_course_gap_analytics(
                f"off-topic analytics check {language} {index}", language, sections,
                {"answerStatus": "off_topic", "sources": []},
            )
    record_course_gap_analytics(
        "Can I get legal advice?", "en", sections, {"answerStatus": "refused", "sources": []}
    )
    record_course_gap_analytics(
        "A question in Arabic", "ar", sections, {"answerStatus": "answered", "sources": []}
    )

    response = client.get(
        "/api/v1/helper/course-gap-radar",
        headers={"X-Helper-Token": "radar-helper-secret"},
    )
    assert response.status_code == 200
    report = response.json()
    assert [row["language"] for row in report["byLanguage"]] == ["en", "am", "ti", "om", "so"]
    for row in report["byLanguage"]:
        expected_total = 4 if row["language"] == "en" else 3
        assert row["total"] == {"count": expected_total, "suppressed": False}
        assert row["outcomes"]["off_topic"] == {"count": 3, "suppressed": False}
        assert row["outcomes"]["answered"] == {"count": 0, "suppressed": False}
    english = next(row for row in report["byLanguage"] if row["language"] == "en")
    assert english["outcomes"]["refused"] == {"count": None, "suppressed": True}
    assert report["topAnsweredTopics"] == []
    assert report["notFoundCandidates"] == []


def test_not_found_nearest_lesson_is_labeled_as_candidate_not_citation(client, monkeypatch):
    monkeypatch.setenv("HELPER_TOKEN", "radar-helper-secret")
    sections = json.loads(
        (Path(__file__).parents[1] / "demo" / "data" / "content.json").read_text(encoding="utf-8")
    )
    section = sections[0]
    for index in range(3):
        record_course_gap_analytics(
            f"{section['titles']['en']} unmet topic canary {index}", "en", sections,
            {"answerStatus": "not_found", "sources": []},
        )

    report = client.get(
        "/api/v1/helper/course-gap-radar",
        headers={"X-Helper-Token": "radar-helper-secret"},
    ).json()
    assert report["notFoundCandidates"] == [{
        "topicId": section["id"], "title": section["titles"]["en"], "count": 3, "candidateOnly": True,
    }]
    assert report["topAnsweredTopics"] == []


def test_zero_gap_retention_disables_and_clears_aggregates(client, monkeypatch):
    monkeypatch.setenv("HELPER_TOKEN", "radar-helper-secret")
    sections = json.loads(
        (Path(__file__).parents[1] / "demo" / "data" / "content.json").read_text(encoding="utf-8")
    )
    record_course_gap_analytics(
        "anonymous aggregate only", "en", sections,
        {"answerStatus": "off_topic", "sources": []},
    )
    monkeypatch.setenv("COURSE_GAP_RETENTION_DAYS", "0")

    response = client.get(
        "/api/v1/helper/course-gap-radar",
        headers={"X-Helper-Token": "radar-helper-secret"},
    )
    assert response.status_code == 200
    assert response.json()["retentionDays"] == 0
    assert response.json()["hasActivity"] is False
    with connect() as db:
        assert db.execute("SELECT COUNT(*) FROM course_gap_aggregates").fetchone()[0] == 0


def test_ask_reports_when_course_evidence_is_not_found(client, monkeypatch):
    monkeypatch.setenv("THRESHOLD", "1.1")
    response = client.post("/api/v1/ask", json={
        "question": "What salary range do virtual assistants earn?",
        "language": "en",
    })
    assert response.status_code == 200
    assert response.json()["answerStatus"] == "not_found"
    assert response.json()["sources"] == []


@pytest.mark.parametrize("language", ["en", "am", "ti", "om", "so"])
def test_ask_localizes_not_found_and_never_returns_a_source(client, monkeypatch, language):
    monkeypatch.setenv("THRESHOLD", "1.01")
    section = json.loads(
        (Path(__file__).parents[1] / "demo" / "data" / "content.json").read_text(encoding="utf-8")
    )[0]
    locale = json.loads(
        (Path(__file__).parents[1] / "module" / "i18n" / f"{language}.json").read_text(encoding="utf-8")
    )
    response = client.post(
        "/api/v1/ask",
        json={"question": section["titles"][language], "language": language},
    )

    assert response.status_code == 200
    assert response.json()["answerStatus"] == "not_found"
    assert response.json()["answer"] == locale["api"]["not_found"]
    assert response.json()["sources"] == []


@pytest.mark.parametrize("language", ["en", "am", "ti", "om", "so"])
def test_ask_reports_localized_off_topic_questions_without_sources(client, language):
    response = client.post("/api/v1/ask", json={
        "question": "Where can I buy train tickets for Madrid?",
        "language": language,
    })

    assert response.status_code == 200
    assert response.json()["answer"] == OFF_TOPIC_TRANSLATIONS[language]
    assert response.json()["answerStatus"] == "off_topic"
    assert response.json()["sources"] == []


@pytest.mark.parametrize("language", ["en", "am", "ti", "om", "so"])
def test_ask_preserves_localized_sensitive_topic_refusal(client, language):
    response = client.post("/api/v1/ask", json={
        "question": "Can you give me legal advice?",
        "language": language,
    })

    assert response.status_code == 200
    assert response.json()["answerStatus"] == "refused"
    assert response.json()["answer"] == SENSITIVE_REFUSAL_TRANSLATIONS[language]
    assert response.json()["sources"] == []


def test_cors_headers_on_api(client):
    res = client.options(
        "/api/v1/ask",
        headers={
            "Origin": "http://localhost:8080",
            "Access-Control-Request-Method": "POST",
        },
    )
    assert res.status_code == 200
    assert res.headers.get("access-control-allow-origin") in ("*", "http://localhost:8080")


def test_answer_feedback_is_private_metadata_and_helper_can_review(client, monkeypatch):
    monkeypatch.setenv("HELPER_TOKEN", "feedback-helper")
    assert client.get("/api/v1/answer-feedback").status_code == 401
    response = client.post("/api/v1/answer-feedback", json={
        "kind": "source", "reason": "incorrect", "sourceUrl": "/lesson#one",
        "question": "This private learner question must not be stored",
    })
    assert response.status_code == 201
    feedback_id = response.json()["feedbackId"]
    rows = client.get("/api/v1/answer-feedback", headers={"X-Helper-Token": "feedback-helper"})
    assert rows.status_code == 200
    assert rows.json()[0]["source_url"] == "/lesson#one"
    assert "question" not in rows.json()[0]
    reviewed = client.post(f"/api/v1/answer-feedback/{feedback_id}/reviewed", headers={"X-Helper-Token": "feedback-helper"})
    assert reviewed.status_code == 200
    assert client.get("/api/v1/answer-feedback", headers={"X-Helper-Token": "feedback-helper"}).json()[0]["reviewed"] == 1
    assert client.post("/api/v1/answer-feedback", json={"kind": "other", "reason": "incorrect"}).status_code == 400


def test_helper_endpoints_fail_closed_when_secret_is_not_configured(client, monkeypatch):
    monkeypatch.setenv("HELPER_TOKEN", "")
    response = client.get("/api/v1/escalations")
    assert response.status_code == 503


def test_content_endpoints(client, monkeypatch):
    monkeypatch.setenv("HELPER_TOKEN", "")
    # GET initial content
    get_res = client.get("/api/v1/content")
    assert get_res.status_code == 200
    assert isinstance(get_res.json(), list)

    # Content indexing is helper-only.
    assert client.post("/api/v1/content", json=[]).status_code == 503
    assert client.post("/api/v1/content", json=[]).status_code == 503
    monkeypatch.setenv("HELPER_TOKEN", "content-helper")
    headers = {"X-Helper-Token": "content-helper"}
    assert client.post("/api/v1/content", json=[]).status_code == 401
    # POST invalid content -> 400
    bad_res = client.post("/api/v1/content", json="not a list", headers=headers)
    assert bad_res.status_code == 400
    invalid_titles = client.post("/api/v1/content", json=[{
        "id": "invalid-localized-title",
        "title": "Invalid title sample",
        "titles": {"fr": "Unsupported language"},
        "url": "/lesson#invalid-title",
        "text": "Test lesson content.",
    }], headers=headers)
    assert invalid_titles.status_code == 400

    # POST valid content -> 200
    new_sections = [{
        "id": "new-test-sec",
        "title": "Test Section Title",
        "url": "/lesson#test",
        "text": {"en": "Section body in English.", "am": "የሙከራ ክፍል ይዘት"},
    }]
    post_res = client.post("/api/v1/content", json=new_sections, headers=headers)
    assert post_res.status_code == 200
    assert post_res.json()["indexed"] == 1
    content_operation = client.get("/openapi.json").json()["paths"]["/api/v1/content"]["post"]
    assert any(item["name"] == "x-helper-token" for item in content_operation["parameters"])


def test_initialize_replaces_marker_bearing_seed_content():
    seed = json.loads((Path(__file__).parents[1] / "demo" / "data" / "content.json").read_text(encoding="utf-8"))[0]
    changed = {**seed, "text": {**seed["text"], "am": "Needs review [CHECK]."}}
    with connect() as db:
        db.execute(
            "UPDATE content_sections SET section_json=? WHERE id=?",
            (json.dumps(changed, ensure_ascii=False), seed["id"]),
        )
    initialize()
    with connect() as db:
        stored = json.loads(
            db.execute("SELECT section_json FROM content_sections WHERE id=?", (seed["id"],)).fetchone()["section_json"]
        )
    assert stored["text"]["am"] == seed["text"]["am"]
    assert "[CHECK]" not in stored["text"]["am"]


def test_initialize_adds_new_locale_fields_without_replacing_existing_course_text():
    seed = json.loads((Path(__file__).parents[1] / "demo" / "data" / "content.json").read_text(encoding="utf-8"))[0]
    older = {**seed, "titles": {key: value for key, value in seed["titles"].items() if key not in {"ti", "om", "so"}}, "text": {key: value for key, value in seed["text"].items() if key not in {"ti", "om", "so"}}}
    older["text"]["en"] = "Customized English text that must be preserved."
    with connect() as db:
        db.execute(
            "UPDATE content_sections SET section_json=? WHERE id=?",
            (json.dumps(older, ensure_ascii=False), seed["id"]),
        )

    initialize()
    with connect() as db:
        stored = json.loads(
            db.execute("SELECT section_json FROM content_sections WHERE id=?", (seed["id"],)).fetchone()["section_json"]
        )

    assert stored["text"]["en"] == older["text"]["en"]
    assert stored["text"]["ti"] == seed["text"]["ti"]
    assert stored["titles"]["om"] == seed["titles"]["om"]


def test_ask_endpoint(client):
    # Valid question -> 200 JSON with best section and source link
    res = client.post("/api/v1/ask", json={"question": "What is virtual assistant work?", "language": "en"})
    assert res.status_code == 200
    data = res.json()
    assert "answer" in data
    assert "sources" in data
    assert len(data["sources"]) == 1
    assert "url" in data["sources"][0]
    assert "title" in data["sources"][0]

    # Valid Amharic question -> 200 JSON with best section and source link
    res_am = client.post("/api/v1/ask", json={"question": "የቨርቹዋል አሲስታንት ሥራን ወደፊት ምን እየቀየረው ነው?", "language": "am"})
    assert res_am.status_code == 200
    data_am = res_am.json()
    assert "answer" in data_am
    assert len(data_am["sources"]) == 1
    assert "url" in data_am["sources"][0]

    # Missing question -> 400 plain-words
    bad_res = client.post("/api/v1/ask", json={"language": "en"})
    assert bad_res.status_code == 400
    assert "question" in bad_res.text.lower() or "detail" in bad_res.json()

    # Invalid language -> 400
    bad_lang = client.post("/api/v1/ask", json={"question": "Hello", "language": "fr"})
    assert bad_lang.status_code == 400


@pytest.mark.parametrize("language", ["en", "am", "ti", "om", "so"])
def test_ask_returns_localized_course_answer_and_source_title(client, monkeypatch, language):
    monkeypatch.setenv("AI_PROVIDER", "none")
    seeded = json.loads(
        (Path(__file__).parents[1] / "demo" / "data" / "content.json").read_text(encoding="utf-8")
    )
    section = seeded[1]
    response = client.post(
        "/api/v1/ask",
        json={"question": section["titles"][language], "language": language},
    )

    assert response.status_code == 200
    result = response.json()
    assert section["text"][language] in result["answer"]
    assert result["sources"] == [{"title": section["titles"][language], "url": section["url"], "type": "lesson"}]
    assert result["answerStatus"] == "answered"
    assert result["grounding"]["status"] == "verified"


@pytest.mark.parametrize("language", ["en", "am", "ti", "om", "so"])
def test_ask_and_tutor_validation_errors_use_selected_language(client, language):
    locale = json.loads((Path(__file__).parents[1] / "module" / "i18n" / f"{language}.json").read_text(encoding="utf-8"))
    invalid_question = client.post("/api/v1/ask", json={"question": "", "language": language})
    assert invalid_question.status_code == 400
    assert invalid_question.json()["detail"] == locale["api"]["error_question"]

    invalid_phone = client.post("/api/v1/escalations", json={
        "conversation": [], "language": language, "page": "/lesson", "phone": "invalid"
    })
    assert invalid_phone.status_code == 400
    assert invalid_phone.json()["detail"] == locale["api"]["error_ticket_phone"]


def test_content_upload_preserves_localized_titles_for_cited_answers(client, monkeypatch):
    monkeypatch.setenv("HELPER_TOKEN", "content-helper")
    monkeypatch.setenv("AI_PROVIDER", "none")
    sections = json.loads(
        (Path(__file__).parents[1] / "demo" / "data" / "content.json").read_text(encoding="utf-8")
    )
    section = sections[1]
    headers = {"X-Helper-Token": "content-helper"}

    upload = client.post("/api/v1/content", json=sections, headers=headers)
    assert upload.status_code == 200
    stored = next(item for item in client.get("/api/v1/content").json() if item["id"] == section["id"])
    assert stored["titles"] == section["titles"]

    for language in ("en", "am", "ti", "om", "so"):
        answer = client.post("/api/v1/ask", json={
            "question": section["titles"][language],
            "language": language,
        })
        assert answer.status_code == 200
        assert answer.json()["sources"][0]["title"] == section["titles"][language]


def test_ask_returns_a_job_listing_as_a_cited_source(client, monkeypatch):
    monkeypatch.setenv("AI_PROVIDER", "none")
    response = client.post(
        "/api/v1/ask",
        json={"question": "Inbox Support Assistant", "language": "en"},
    )

    assert response.status_code == 200
    assert response.json()["answerStatus"] == "answered"
    assert response.json()["sources"][0]["type"] == "job"
    assert response.json()["sources"][0]["url"].endswith("#test-inbox-support")


@pytest.mark.parametrize("language", ["am", "ti", "om", "so"])
def test_indexed_jobs_include_localized_titles_and_text(language):
    from api.main import indexed_sections

    jobs = [item for item in indexed_sections() if item.get("type") == "job"]
    assert len(jobs) == 8
    for job in jobs:
        assert job["titles"][language] == job["translations"][language]["title"]
        assert job["translations"][language]["description"] in job["text"][language]


def test_cloud_provider_requires_explicit_learner_consent(client, monkeypatch):
    monkeypatch.setenv("OFFLINE_MODE", "false")
    imported = []

    class RetrievalOnlyProvider:
        async def answer(self, question, sections, language):
            return {"text": None}

    def fake_import(name, package):
        imported.append(name)
        return RetrievalOnlyProvider()

    monkeypatch.setenv("AI_PROVIDER", "cloud")
    monkeypatch.setattr(qa.importlib, "import_module", fake_import)
    assert client.get("/api/v1/config").json() == {"externalAiConsentRequired": True}

    without_consent = client.post(
        "/api/v1/ask",
        json={"question": "What is virtual assistant work?", "language": "en"},
    )
    assert without_consent.status_code == 200
    assert imported[-1].endswith(".providers.none")
    assert without_consent.json()["mode"] == "search"

    with_consent = client.post(
        "/api/v1/ask",
        json={
            "question": "What is virtual assistant work?",
            "language": "en",
            "externalAiConsent": True,
        },
    )
    assert with_consent.status_code == 200
    assert imported[-1].endswith(".providers.cloud")

    monkeypatch.setenv("AI_PROVIDER", "none")
    assert client.get("/api/v1/config").json() == {"externalAiConsentRequired": False}


def test_escalation_lifecycle_and_webhook(client, monkeypatch):
    monkeypatch.setenv("OFFLINE_MODE", "false")
    webhook_calls = []

    def mock_urlopen(request, timeout=5):
        if request.get_full_url() == "https://webhook.example.test/opened":
            body = json.loads(request.data.decode("utf-8"))
            webhook_calls.append(body)
        mock_resp = MagicMock()
        mock_resp.status = 200
        mock_resp.__enter__.return_value = mock_resp
        return mock_resp

    monkeypatch.setenv("WEBHOOK_URL", "https://webhook.example.test/opened")
    monkeypatch.setenv("HELPER_TOKEN", "test-secret-token")

    with patch("urllib.request.urlopen", side_effect=mock_urlopen):
        # 1. Create escalation -> 201 Created
        create_res = client.post(
            "/api/v1/escalations",
            json={
                "conversation": [{"from": "user", "text": "Can someone help me with section 1?"}],
                "language": "en",
                "page": "/savanna/pages/concept-with-navigation.html#what-is-shaping-the-future-of-va-work",
                "note": "Needs human guidance",
            },
        )
        assert create_res.status_code == 201
        data = create_res.json()
        assert "ticketId" in data
        assert "accessToken" in data
        ticket_id = data["ticketId"]
        learner_headers = {"X-Learner-Token": data["accessToken"]}

        # Webhook was invoked with { "event": "ticket.opened", "ticketId": ..., "at": ... }
        assert len(webhook_calls) == 1
        payload = webhook_calls[0]
        assert payload["event"] == "ticket.opened"
        assert payload["ticketId"] == ticket_id
        assert "at" in payload

        # 2. List waiting escalations -> 200 with valid helper token
        list_res = client.get("/api/v1/escalations", headers={"X-Helper-Token": "test-secret-token"})
        assert list_res.status_code == 200
        tickets = list_res.json()
        assert any(t["ticketId"] == ticket_id for t in tickets)

        # 3. Get single ticket -> 200
        assert client.get(f"/api/v1/escalations/{ticket_id}").status_code == 404
        get_res = client.get(f"/api/v1/escalations/{ticket_id}", headers=learner_headers)
        assert get_res.status_code == 200
        assert get_res.json()["ticketId"] == ticket_id

        # 4. Send an interim update without closing the request.
        update_res = client.post(
            f"/api/v1/escalations/{ticket_id}/reply",
            headers={"X-Helper-Token": "test-secret-token"},
            json={"text": "I am unavailable right now; I will follow up later.", "resolve": False},
        )
        assert update_res.status_code == 200
        assert update_res.json()["status"] == "waiting"
        waiting_ticket = client.get(f"/api/v1/escalations/{ticket_id}", headers=learner_headers).json()
        assert waiting_ticket["status"] == "waiting"
        assert waiting_ticket["reply"] == "I am unavailable right now; I will follow up later."

        # 5. A final reply closes the waiting request.
        reply_res = client.post(
            f"/api/v1/escalations/{ticket_id}/reply",
            headers={"X-Helper-Token": "test-secret-token"},
            json={"text": "Hello, I am your tutor. Let's review section 1 together."},
        )
        assert reply_res.status_code == 200
        assert reply_res.json()["message"] == "Reply saved."
        assert reply_res.json()["status"] == "answered"
        assert client.get(f"/api/v1/escalations/{ticket_id}", headers=learner_headers).json()["status"] == "answered"

        export_res = client.get(f"/api/v1/escalations/{ticket_id}/data", headers=learner_headers)
        assert export_res.status_code == 200
        assert export_res.json()["note"] == "Needs human guidance"
        assert export_res.json()["conversation"][0]["text"] == "Can someone help me with section 1?"
        assert client.get(f"/api/v1/escalations/{ticket_id}/data").status_code == 400
        assert client.get(
            f"/api/v1/escalations/{ticket_id}/data",
            headers={"X-Learner-Token": "incorrect"},
        ).status_code == 404

        # 5. Non-existent ticket -> 404
        missing_res = client.get("/api/v1/escalations/non-existent-id")
        assert missing_res.status_code == 404

        # 6. Delete ticket -> 200
        del_res = client.delete(
            f"/api/v1/escalations/{ticket_id}",
            headers={"X-Helper-Token": "test-secret-token"},
        )
        assert del_res.status_code == 200

        # Now fetching deleted ticket returns 404
        assert client.get(f"/api/v1/escalations/{ticket_id}").status_code == 404


def test_learner_can_delete_only_their_ticket_data(client):
    created = client.post(
        "/api/v1/escalations",
        json={
            "conversation": [],
            "language": "en",
            "page": "/lesson",
            "note": "Private note",
        },
    ).json()
    ticket_id, access_token = created["ticketId"], created["accessToken"]
    response = client.delete(
        f"/api/v1/escalations/{ticket_id}/data",
        headers={"X-Learner-Token": access_token},
    )
    assert response.status_code == 200
    assert response.json() == {"message": "Ticket data deleted."}
    assert client.get(f"/api/v1/escalations/{ticket_id}/data", headers={"X-Learner-Token": access_token}).status_code == 404


def test_expired_tickets_are_removed_before_the_helper_inbox_lists_them(client, monkeypatch):
    from datetime import datetime, timedelta, timezone

    monkeypatch.setenv("TICKET_RETENTION_DAYS", "30")
    ticket_id = save_escalation_record(
        [], "en", "/lesson", "expired",
        created_at=(datetime.now(timezone.utc) - timedelta(days=31)).isoformat(),
    )
    monkeypatch.setenv("HELPER_TOKEN", "test-secret-token")
    response = client.get("/api/v1/escalations", headers={"X-Helper-Token": "test-secret-token"})
    assert response.status_code == 200
    assert all(ticket["ticketId"] != ticket_id for ticket in response.json())
    with connect() as db:
        assert db.execute("SELECT id FROM escalations WHERE id=?", (ticket_id,)).fetchone() is None


def test_jobs_notify_endpoint(client, monkeypatch):
    monkeypatch.setenv("HELPER_TOKEN", "test-secret-token")

    # Invalid job -> 400
    bad_res = client.post(
        "/api/v1/jobs/notify",
        headers={"X-Helper-Token": "test-secret-token"},
        json={"title": "Incomplete job"},
    )
    assert bad_res.status_code == 400

    # Valid job -> 200
    valid_job = {
        "id": "job-101",
        "title": "Remote VA Specialist",
        "location": "Addis Ababa",
        "url": "https://example.com/jobs/101",
        "description": "Assist with client communications and documentation.",
        "remote": True,
    }
    res = client.post(
        "/api/v1/jobs/notify",
        headers={"X-Helper-Token": "test-secret-token"},
        json={"job": valid_job},
    )
    assert res.status_code == 200
    data = res.json()
    assert "telegram" in data
    assert "sms" in data


def test_sms_inbound_both_routes(client):
    # Both /sms/inbound and /api/v1/sms/inbound work identically
    res1 = client.post("/sms/inbound", json={"from": "+12025550199", "text": "JOBS"})
    assert res1.status_code == 200
    assert "Jobs:" in res1.text

    res2 = client.post("/api/v1/sms/inbound", json={"from": "+12025550199", "text": "JOBS"})
    assert res2.status_code == 200
    assert "Jobs:" in res2.text
