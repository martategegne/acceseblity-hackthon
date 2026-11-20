"""Question answering orchestration shared by the HTTP endpoint and tests."""
from __future__ import annotations

import asyncio
import importlib
import os

from .retrieval import retrieve, sensitive_topic

NOT_FOUND = "I could not find this in the course."
OFF_TOPIC = "I can only help with this course. Would you like a person to help?"
SENSITIVE_REFUSAL = "I can’t help with medical, legal, or immigration advice. Please talk to a tutor."
NOT_FOUND_TRANSLATIONS = {
    "en": NOT_FOUND,
    "am": "ይህንን በትምህርቱ ውስጥ ማግኘት አልቻልኩም።",
    "ti": "እዚ ኣብ ትምህርቲ ክረኽቦ ኣይከኣልኩን።",
    "om": "Barnoota kana keessatti kana hin arganne.",
    "so": "Casharkan kama helin.",
    "ar": "لم أجد هذا في الدرس.",
}
OFF_TOPIC_TRANSLATIONS = {
    "en": OFF_TOPIC,
    "am": "ስለዚህ ትምህርት ብቻ መርዳት እችላለሁ። አንድ ሰው እንዲረዳዎት ይፈልጋሉ?",
}
SENSITIVE_REFUSAL_TRANSLATIONS = {
    "en": SENSITIVE_REFUSAL,
    "am": "ስለ ሕክምና፣ ሕግ ወይም ኢሚግሬሽን ምክር መስጠት አልችልም። እባክዎ አስተማሪን ያነጋግሩ።",
    "ti": "ብዛዕባ ሕክምና፡ ሕጊ ወይ ኢሚግሬሽን ምኽሪ ክህብ ኣይክእልን። በጃኻ ምስ መምህር ተዘራረብ።",
    "om": "Waa'ee fayyaa, seeraa ykn godaansaa gorsa kennuu hin danda'u. Maaloo barsiisaa waliin haasa'i.",
    "so": "Kama bixin karo talo caafimaad, sharci ama socdaal. Fadlan la hadal macallin.",
    "ar": "لا أستطيع تقديم نصيحة طبية أو قانونية أو متعلقة بالهجرة. يُرجى التحدث إلى معلّم.",
}


def _grounding(score: float, answer: str, sources: list[dict], status: str, mode: str) -> dict:
    if status != "answered" or not sources:
        return {"status": "unverified", "confidence": "low", "score": round(score, 4), "evidence": []}
    try:
        threshold = float(os.getenv("THRESHOLD", "0.25"))
    except ValueError:
        threshold = 0.25
    confidence = "high" if score >= 0.75 else "medium" if score >= threshold else "low"
    return {
        "status": "verified",
        "method": "verbatim-source-excerpt" if mode == "ai" else "retrieved-course-section",
        "confidence": confidence,
        "confidenceBasis": "retrieval-similarity-not-probability",
        "score": round(score, 4),
        "evidence": [
            {"title": source["title"], "url": source["url"], "quote": answer}
            for source in sources
        ],
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
        verified_ids = [
            source_id for source_id in cited_ids
            if source_id in allowed_sections
            and is_substantiated(answer_text, allowed_sections[source_id], language)
        ]
        if (
            not isinstance(text, str)
            or not text.strip()
            or text.strip() == "NOT_FOUND"
            or not verified_ids
        ):
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
            "grounding": _grounding(best_score, answer_text, cited_sources, "answered", "ai"),
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
