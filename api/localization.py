"""Shared API copy loaded from the same locale packs as the learner widget."""
from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path

LOCALE_DIR = Path(__file__).resolve().parent.parent / "module" / "i18n"
SUPPORTED_LOCALES = ("en", "am", "ti", "om", "so", "ar")


@lru_cache(maxsize=None)
def _pack(language: str) -> dict:
    try:
        value = json.loads((LOCALE_DIR / f"{language}.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return value if isinstance(value, dict) else {}


def api_message(language: str, key: str, default: str | None = None, **values: str) -> str:
    """Return localized API copy, falling back to English and formatting placeholders."""
    localized = _pack(language).get("api", {}).get(key)
    english = _pack("en").get("api", {}).get(key)
    message = localized if isinstance(localized, str) and localized else english
    if not isinstance(message, str) or not message:
        message = default or key
    try:
        return message.format(**values)
    except (KeyError, ValueError):
        return message


def api_messages(key: str) -> dict[str, str]:
    """Return available localized values for callers that expose locale maps."""
    return {language: api_message(language, key) for language in SUPPORTED_LOCALES}
