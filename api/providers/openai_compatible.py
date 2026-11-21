"""Minimal async adapter for OpenAI-compatible chat completion endpoints."""
import asyncio
import json
import urllib.error
import urllib.request


SYSTEM_PROMPT = (
    "Answer from the provided course sections only, in the learner's language ({language}). "
    "Write a concise, natural answer that may paraphrase the sections, but do not add facts, "
    "advice, or assumptions. Return only one JSON object with keys text, source_ids, and "
    "evidence. source_ids must contain every exact section ID used. evidence must contain one "
    "object per source ID with that same source_id and a quote copied exactly from that section "
    "(including punctuation). The answer's factual claims must be supported by those quotes. "
    "If the sections do not answer the question, return "
    '{"text":"NOT_FOUND","source_ids":[],"evidence":[]}. Do not give medical, legal or '
    "immigration advice. Keep text under 80 words and use plain language."
)


def _request(url: str, model: str, question: str, sections: list[dict], language: str, key: str | None) -> dict:
    context = "\n\n".join(
        f"ID: {section.get('id', '')}\nTITLE: {section.get('title', '')}\nTEXT: {section.get('text', '')}"
        for section in sections[:2]
    )
    body = json.dumps({
        "model": model,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT.format(language=language)},
            {"role": "user", "content": f"Provided sections:\n{context}\n\nQuestion: {question}"},
        ],
        "temperature": 0.1,
        "max_tokens": 220,
    }).encode("utf-8")
    headers = {"Content-Type": "application/json"}
    if key:
        headers["Authorization"] = f"Bearer {key}"
    request = urllib.request.Request(url, data=body, headers=headers, method="POST")
    with urllib.request.urlopen(request, timeout=5) as response:
        result = json.loads(response.read().decode("utf-8"))
    content = result["choices"][0]["message"]["content"]
    if not isinstance(content, str):
        return {"text": None, "source_ids": []}
    try:
        answer = json.loads(content)
    except json.JSONDecodeError:
        return {"text": None, "source_ids": []}
    if not isinstance(answer, dict):
        return {"text": None, "source_ids": []}
    return {
        "text": answer.get("text") if isinstance(answer.get("text"), str) else None,
        "source_ids": answer.get("source_ids") if isinstance(answer.get("source_ids"), list) else [],
        "evidence": answer.get("evidence") if isinstance(answer.get("evidence"), list) else None,
    }


async def complete(url: str, model: str, question: str, sections: list[dict], language: str, key: str | None = None) -> dict:
    return await asyncio.wait_for(
        asyncio.to_thread(_request, url, model, question, sections, language, key),
        timeout=5,
    )
