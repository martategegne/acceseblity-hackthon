"""Question answering orchestration shared by the HTTP endpoint and tests."""
from __future__ import annotations

import asyncio
import importlib
import os

from .retrieval import retrieve, sensitive_topic
from .localization import api_message, api_messages

NOT_FOUND = api_message("en", "not_found")
OFF_TOPIC = api_message("en", "off_topic")
SENSITIVE_REFUSAL = api_message("en", "sensitive_refusal")
NOT_FOUND_TRANSLATIONS = api_messages("not_found")
OFF_TOPIC_TRANSLATIONS = api_messages("off_topic")
SENSITIVE_REFUSAL_TRANSLATIONS = api_messages("sensitive_refusal")


def _grounding(
    score: float,
    answer: str,
    sources: list[dict],
    status: str,
    mode: str,
    evidence: list[dict] | None = None,
) -> dict:
    if status != "answered" or not sources:
        return {"status": "unverified", "confidence": "low", "score": round(score, 4), "evidence": []}
    try:
        threshold = float(os.getenv("THRESHOLD", "0.25"))
    except ValueError:
        threshold = 0.25
    confidence = "high" if score >= 0.75 else "medium" if score >= threshold else "low"
    evidence_rows = evidence or [
        {"title": source["title"], "url": source["url"], "quote": answer}
        for source in sources
    ]
    return {
        "status": "verified",
        "method": (
            "retrieval-grounded-model"
            if mode == "ai" and evidence
            else "verbatim-source-excerpt"
            if mode == "ai"
            else "retrieved-course-section"
        ),
        "confidence": confidence,
        "confidenceBasis": "retrieval-similarity-not-probability",
        "score": round(score, 4),
        "evidence": evidence_rows,
    }


def is_substantiated(answer_text: str, section: dict, language: str = "en") -> bool:
    """Accept only a verbatim excerpt from the cited section."""
    if not isinstance(answer_text, str) or not answer_text.strip():
        return False
    section_text = section.get("text", "")
    if isinstance(section_text, dict):
        section_text = section_text.get(language)
        if not section_text and language not in {"ti", "om", "so"}:
            section_text = section.get("text", {}).get("en", "")
    if not isinstance(section_text, str) or not section_text.strip():
        return False
    clean_answer = " ".join(answer_text.split())
    clean_section = " ".join(section_text.split())
    return bool(clean_answer) and clean_answer in clean_section


def is_verbatim_excerpt(excerpt: str, section: dict, language: str = "en") -> bool:
    """Check that a model-provided evidence quote came from the cited section."""
    if not isinstance(excerpt, str) or not excerpt.strip():
        return False
    section_text = section.get("text", "")
    if isinstance(section_text, dict):
        section_text = section_text.get(language)
        if not section_text and language not in {"ti", "om", "so"}:
            section_text = section.get("text", {}).get("en", "")
    if not isinstance(section_text, str) or not section_text.strip():
        return False
    return " ".join(excerpt.split()) in " ".join(section_text.split())


def _model_evidence(
    raw_evidence: object,
    cited_ids: list[str],
    allowed_sections: dict[str, dict],
    language: str,
) -> list[dict] | None:
    """Validate exact source quotes returned alongside a paraphrased answer."""
    if not isinstance(raw_evidence, list) or not raw_evidence:
        return None
    evidence: list[dict] = []
    seen_ids: set[str] = set()
    for item in raw_evidence:
        if not isinstance(item, dict):
            return None
        source_id = item.get("source_id")
        quote = item.get("quote")
        if (
            not isinstance(source_id, str)
            or source_id not in cited_ids
            or source_id in seen_ids
            or not is_verbatim_excerpt(quote, allowed_sections[source_id], language)
        ):
            return None
        seen_ids.add(source_id)
        source = allowed_sections[source_id]
        evidence.append({"title": source["title"], "url": source["url"], "quote": " ".join(quote.split())})
    # A citation must have a matching evidence quote; do not let the model cite
    # an otherwise retrieved section that it did not use.
    if seen_ids != set(cited_ids):
        return None
    return evidence


async def answer_question(
    question: str,
    language: str,
    sections: list[dict],
    provider=None,
    *,
    allow_cloud: bool = True,
    offline_only: bool = False,
) -> dict:
    ranked = retrieve(question, sections, language)
    best_score, best = ranked[0] if ranked else (0.0, None)
    if sensitive_topic(question):
        return {
            "answer": SENSITIVE_REFUSAL_TRANSLATIONS.get(language, SENSITIVE_REFUSAL),
            "sources": [],
            "mode": "search",
            "score": best_score,
            "answerStatus": "refused",
            "grounding": _grounding(best_score, "", [], "refused", "search"),
        }

    if ranked and best_score == 0:
        return {
            "answer": OFF_TOPIC_TRANSLATIONS.get(language, OFF_TOPIC),
            "sources": [],
            "mode": "search",
            "score": best_score,
            "answerStatus": "off_topic",
            "grounding": _grounding(best_score, "", [], "off_topic", "search"),
        }

    try:
        threshold = float(os.getenv("THRESHOLD", "0.25"))
    except ValueError:
        threshold = 0.25
    if best is None or best_score < threshold:
        return {
            "answer": NOT_FOUND_TRANSLATIONS.get(language, NOT_FOUND),
            "sources": [],
            "mode": "search",
            "score": best_score,
            "answerStatus": "not_found",
            "grounding": _grounding(best_score, "", [], "not_found", "search"),
        }

    best_sources = [
        {"title": best["title"], "url": best["url"], **({"type": best["type"]} if "type" in best else {})}
    ] if best else []

    eligible = [(score, section) for score, section in ranked if score >= threshold][:2]

    if provider is None:
        name = os.getenv("AI_PROVIDER", "none").strip().lower()
        providers = {"none": "none", "local": "local", "cloud": "cloud"}
        if name not in providers:
            name = "none"
        if offline_only:
            name = "none"
        if name == "cloud" and not allow_cloud:
            name = "none"
        provider = importlib.import_module(f".providers.{providers[name]}", package=__package__)
    try:
        result = await asyncio.wait_for(provider.answer(question, [section for _, section in eligible], language), timeout=5)
        text = result.get("text") if isinstance(result, dict) else None
        source_ids = result.get("source_ids") if isinstance(result, dict) else None
        allowed_sections = {
            section["id"]: section
            for _, section in eligible
            if isinstance(section.get("id"), str) and section["id"]
        }
        cited_ids = list(dict.fromkeys(source_ids)) if isinstance(source_ids, list) and all(
            isinstance(source_id, str) for source_id in source_ids
        ) else []
        answer_text = text.strip() if isinstance(text, str) else ""
        if not isinstance(text, str) or not text.strip() or text.strip().upper() == "NOT_FOUND":
            raise ValueError("Provider did not return a verified substantiated cited answer.")
        raw_evidence = result.get("evidence") if isinstance(result, dict) else None
        evidence = None
        if raw_evidence is not None:
            evidence = _model_evidence(raw_evidence, cited_ids, allowed_sections, language)
            if evidence is None:
                raise ValueError("Provider evidence did not match the cited course sections.")
            verified_ids = cited_ids
        else:
            verified_ids = [
                source_id for source_id in cited_ids
                if source_id in allowed_sections
                and is_substantiated(answer_text, allowed_sections[source_id], language)
            ]
        if not verified_ids:
            raise ValueError("Provider did not return a verified substantiated cited answer.")
        cited_sources = [
            {"title": allowed_sections[source_id]["title"], "url": allowed_sections[source_id]["url"],
             **({"type": allowed_sections[source_id]["type"]} if "type" in allowed_sections[source_id] else {})}
            for source_id in verified_ids
        ]
        return {
            "answer": answer_text,
            "sources": cited_sources,
            "mode": "ai",
            "score": best_score,
            "answerStatus": "answered",
            "grounding": _grounding(
                best_score,
                answer_text,
                cited_sources,
                "answered",
                "ai",
                evidence,
            ),
        }
    except Exception:
        # Non-substantiated, uncited, or unavailable model answers use the best matched course section.
        return {
            "answer": best["text"],
            "sources": best_sources,
            "mode": "search",
            "score": best_score,
            "answerStatus": "answered",
            "grounding": _grounding(best_score, best["text"], best_sources, "answered", "search"),
        }
