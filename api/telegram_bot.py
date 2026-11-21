"""Telegram long-polling bot for the course assistant."""
from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import secrets
import sqlite3
import time
import urllib.error
import urllib.parse
import urllib.request
from functools import lru_cache
from pathlib import Path
from typing import Any

PROJECT_ROOT = Path(__file__).resolve().parent.parent
ROOT = Path(__file__).resolve().parent
JOBS_FILE = PROJECT_ROOT / "demo" / "data" / "jobs.json"
LOCALE_DIR = PROJECT_ROOT / "module" / "i18n"
DEFAULT_COURSE_BASE_URL = (
    "https://github.com/hudahussen2424-hash/acceseblity-hackthon/blob/main/"
)
ETHIOPIC_SCRIPT = re.compile(r"[\u1200-\u137f]")


def load_dotenv_files() -> None:
    for env_file in (PROJECT_ROOT / ".env", ROOT / ".env"):
        if not env_file.is_file():
            continue
        for line in env_file.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                key, value = line.split("=", 1)
                os.environ.setdefault(key.strip(), value.strip().strip("\"'"))


load_dotenv_files()

from . import main as api_main  # noqa: E402
from .main import (  # noqa: E402
    indexed_sections,
    notify_webhook,
    record_course_gap_analytics,
    save_escalation_record,
)
from .qa import NOT_FOUND, answer_question  # noqa: E402
from .voice import classify_command, local_provider  # noqa: E402

logger = logging.getLogger("api.telegram_bot")


def initialize_storage() -> None:
    api_main.initialize()
    api_main.DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    with api_main.connect() as db:
        db.execute(
            "CREATE TABLE IF NOT EXISTS telegram_chats "
            "(chat_id INTEGER PRIMARY KEY, language TEXT)"
        )
        db.execute(
            "CREATE TABLE IF NOT EXISTS telegram_messages "
            "(id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id INTEGER NOT NULL, "
            "role TEXT NOT NULL, text TEXT NOT NULL, created_at TEXT NOT NULL "
            "DEFAULT CURRENT_TIMESTAMP)"
        )
        db.execute(
            "CREATE TABLE IF NOT EXISTS telegram_alert_subscribers "
            "(chat_id INTEGER PRIMARY KEY)"
        )
        db.execute(
            "CREATE TABLE IF NOT EXISTS telegram_state "
            "(key TEXT PRIMARY KEY, value TEXT NOT NULL)"
        )


def detect_language(text: str) -> str:
    return "am" if ETHIOPIC_SCRIPT.search(text) else "en"


def chat_language(chat_id: int, text: str = "") -> str:
    with api_main.connect() as db:
        row = db.execute(
            "SELECT language FROM telegram_chats WHERE chat_id=?", (chat_id,)
        ).fetchone()
    return row["language"] if row and row["language"] else detect_language(text)


def set_chat_language(chat_id: int, language: str) -> None:
    with api_main.connect() as db:
        db.execute(
            "INSERT INTO telegram_chats(chat_id, language) VALUES(?, ?) "
            "ON CONFLICT(chat_id) DO UPDATE SET language=excluded.language",
            (chat_id, language),
        )


def record_message(chat_id: int, role: str, text: str) -> None:
    with api_main.connect() as db:
        db.execute(
            "INSERT INTO telegram_messages(chat_id, role, text) VALUES(?, ?, ?)",
            (chat_id, role, text),
        )
        db.execute(
            "DELETE FROM telegram_messages WHERE chat_id=? AND id NOT IN "
            "(SELECT id FROM telegram_messages WHERE chat_id=? "
            "ORDER BY id DESC LIMIT 50)",
            (chat_id, chat_id),
        )


def chat_history(chat_id: int) -> list[dict[str, str]]:
    with api_main.connect() as db:
        rows = db.execute(
            "SELECT role, text FROM telegram_messages WHERE chat_id=? ORDER BY id",
            (chat_id,),
        ).fetchall()
    return [{"role": row["role"], "text": row["text"]} for row in rows]


def set_alert_subscription(chat_id: int, enabled: bool) -> None:
    with api_main.connect() as db:
        if enabled:
            db.execute(
                "INSERT OR IGNORE INTO telegram_alert_subscribers(chat_id) VALUES(?)",
                (chat_id,),
            )
        else:
            db.execute(
                "DELETE FROM telegram_alert_subscribers WHERE chat_id=?", (chat_id,)
            )


def notify_job_subscribers(job: dict[str, Any]) -> dict[str, int]:
    """Send a public job alert to chats subscribed with /alerts on."""
    initialize_storage()
    token = os.getenv("TELEGRAM_BOT_TOKEN", "").strip()
    if not token:
        return {"sent": 0, "failed": 0}
    with api_main.connect() as db:
        chats = db.execute("SELECT chat_id FROM telegram_alert_subscribers").fetchall()
    title = str(job.get("title", "New job"))
    location = str(job.get("location", ""))
    remote = "Remote" if job.get("remote") else "On site"
    description = str(job.get("description", ""))
    url = source_link(str(job.get("url", "")))
    message = f"New test job: {title}\n{remote} · {location}\n{description}\n{url}"[:3900]
    sent = failed = 0
    for chat in chats:
        try:
            telegram_call(token, "sendMessage", {"chat_id": chat["chat_id"], "text": message})
            sent += 1
        except RuntimeError:
            failed += 1
    return {"sent": sent, "failed": failed}


def source_link(url: str) -> str:
    if urllib.parse.urlsplit(url).scheme in {"http", "https"}:
        return url
    base_url = os.getenv("COURSE_BASE_URL", DEFAULT_COURSE_BASE_URL)
    return urllib.parse.urljoin(base_url.rstrip("/") + "/", url.lstrip("/"))


def format_answer(result: dict[str, Any], language: str) -> str:
    answer = str(result.get("answer") or "").strip()
    sources = result.get("sources")
    if result.get("answerStatus") in {"not_found", "off_topic", "refused"} and answer:
        handoff = "/person"
        return f"{answer}\n\nAsk a person with {handoff}."[:3900]
    if answer == NOT_FOUND or not isinstance(sources, list) or not sources:
        if language == "am":
            return "በዚህ ትምህርት ውስጥ ይህን አላገኘሁም። /person በመጠቀም ሰው ይጠይቁ።"
        return "I couldn't find this in the lesson. Ask a person with /person."

    source = sources[0]
    if not isinstance(source, dict) or not isinstance(source.get("url"), str):
        if language == "am":
            return "በዚህ ትምህርት ውስጥ ይህን አላገኘሁም። /person በመጠቀም ሰው ይጠይቁ።"
        return "I couldn't find this in the lesson. Ask a person with /person."

    title = source.get("title")
    label = f"{title} — " if isinstance(title, str) and title else ""
    answer = answer[:3500]
    return f"{answer}\n\nSource: {label}{source_link(source['url'])}"


def handle_voice(chat_id: int, audio: bytes, username: str | None = None) -> dict[str, Any]:
    """Transcribe a Telegram voice note and optionally return a spoken answer."""
    language = chat_language(chat_id)
    try:
        recognized = local_provider().transcribe(audio, language)
    except Exception as error:
        logger.warning("Could not transcribe Telegram voice note: %s", type(error).__name__)
        message = (
            "I could not process that voice note. Please try again or send a text question."
            if language == "en"
            else "የድምፅ መልዕክቱን ማስኬድ አልቻልኩም። እባክዎ እንደገና ይሞክሩ ወይም የጽሑፍ ጥያቄ ይላኩ።"
        )
        return {"text": message, "audio": None, "language": language, "transcript": ""}

    transcript = str(recognized.get("transcript") or "").strip() if isinstance(recognized, dict) else ""
    if not transcript:
        message = (
            "I could not hear a question. Please record the voice note again."
            if language == "en"
            else "ጥያቄ አልሰማሁም። እባክዎ የድምፅ መልዕክቱን እንደገና ይቅረጹ።"
        )
        return {"text": message, "audio": None, "language": language, "transcript": ""}

    record_message(chat_id, "user", transcript)
    command = classify_command(transcript, language)
    if command["action"] == "request_tutor":
        response = _person_reply(chat_id, language, username)
        answer_text = response
        result = {"answerStatus": "handoff", "answer": response, "sources": []}
    elif command["action"] == "check_tutor_reply":
        response = (
            "Send /status and the 8-character code from your tutor request."
            if language == "en"
            else "ከአስተማሪ ጥያቄዎ የተሰጠውን 8 ፊደል ኮድ ከ/status ጋር ይላኩ።"
        )
        answer_text = response
        result = {"answerStatus": "handoff", "answer": response, "sources": []}
    else:
        result = asyncio.run(
            answer_question(
                transcript,
                language,
                indexed_sections(),
                allow_cloud=False,
                offline_only=api_main.offline_mode(),
            )
        )
        record_course_gap_analytics(transcript, language, indexed_sections(), result)
        response = format_answer(result, language)
        answer_text = str(result.get("answer") or response)

    record_message(chat_id, "assistant", response)
    try:
        spoken = local_provider().synthesize(answer_text[:3500], language)
        audio_reply = spoken if isinstance(spoken, bytes) and spoken else None
    except Exception as error:
        logger.info("Telegram voice read-back unavailable for %s: %s", language, type(error).__name__)
        audio_reply = None
    return {"text": response, "audio": audio_reply, "language": language, "transcript": transcript, "result": result}


@lru_cache(maxsize=6)
def _locale_strings(language: str) -> dict[str, str]:
    try:
        locale = json.loads((LOCALE_DIR / f"{language}.json").read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        logger.error("Could not load Telegram locale %s: %s", language, error)
        return {}
    strings = locale.get("strings") if isinstance(locale, dict) else None
    return strings if isinstance(strings, dict) else {}


def jobs_reply(language: str = "en") -> str:
    strings = _locale_strings(language)
    try:
        jobs = json.loads(JOBS_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        logger.warning("Could not load jobs data: %s", error)
        return strings.get("jobsListUnavailable", "The test jobs list is unavailable right now.")
    if not isinstance(jobs, list):
        logger.error("Jobs data must be a JSON list.")
        return strings.get("jobsListUnavailable", "The test jobs list is unavailable right now.")
    job_heading = strings.get("jobsListTitle", "Test jobs")
    entries = []
    for job in jobs:
        if not isinstance(job, dict) or not isinstance(job.get("title"), str):
            continue
        translations = job.get("translations")
        translation = translations.get(language) if isinstance(translations, dict) else None
        translation = translation if isinstance(translation, dict) else {}
        localized_title = translation.get("title")
        title = localized_title.strip() if isinstance(localized_title, str) else job["title"].strip()
        description = translation.get("description", job.get("description", ""))
        if title:
            entry = f"• {title}"
            employer = job.get("employer")
            location = job.get("location")
            if isinstance(employer, str) and employer.strip():
                entry += f"\n  {employer.strip()}"
            if isinstance(location, str) and location.strip():
                entry += f" — {location.strip()}"
            if job.get("remote") is True:
                entry += f" ({strings.get('jobRemote', 'remote')})"
            elif job.get("remote") is False:
                entry += f" ({strings.get('jobOnSite', 'on-site')})"
            if isinstance(description, str) and description.strip():
                entry += f"\n  {description.strip()}"
            url = job.get("url")
            if isinstance(url, str) and url.strip():
                entry += f"\n  {source_link(url.strip())}"
            entries.append(entry)
    if not entries:
        return strings.get("jobsListEmpty", "No test jobs are listed yet.")
    return f"{job_heading}:\n" + "\n".join(entries[:10])


def _person_reply(chat_id: int, language: str, username: str | None) -> str:
    page = (
        f"https://t.me/{urllib.parse.quote(username)}"
        if username
        else f"telegram://chat/{chat_id}"
    )
    note = f"Telegram chat ID: {chat_id}"
    try:
        ticket_id = save_escalation_record(chat_history(chat_id), language, page, note)
        notify_webhook(ticket_id)
    except (OSError, sqlite3.Error) as error:
        logger.error("Could not create Telegram escalation: %s", error)
        return (
            "I couldn't open a ticket right now. Please try again."
            if language == "en"
            else "አሁን ጥያቄዎን መመዝገብ አልቻልኩም። እባክዎ እንደገና ይሞክሩ።"
        )
    reference = ticket_id.replace("-", "")[-8:].upper()
    return (
        f"Your request is queued. Tutors may be unavailable, including at 23:00; response times vary and are not guaranteed. Use /status {reference} to check."
        if language == "en"
        else f"ጥያቄዎ ተመዝግቧል። አስተማሪዎች በ23:00 ላይም ላይገኙ ይችላሉ፤ የምላሽ ጊዜ ይለያያል እና ዋስትና የለውም። /status {reference} ብለው ይፈትሹ።"
    )


def _ticket_status(chat_id: int, reference: str, language: str) -> str:
    if not re.fullmatch(r"[A-F0-9]{8}", reference):
        return "Use /status followed by the 8-character code from your tutor request."
    with api_main.connect() as db:
        api_main.purge_expired_tickets(db)
        rows = db.execute(
            "SELECT id, reply, status FROM escalations WHERE id LIKE ? AND note=?",
            (f"%{reference.lower()}", f"Telegram chat ID: {chat_id}"),
        ).fetchall()
    if len(rows) != 1:
        return "No matching tutor request was found. Check the code and use this Telegram chat."
    ticket = rows[0]
    if ticket["status"] == "answered":
        return f"Tutor: {ticket['reply'] or ''}"
    if ticket["reply"]:
        update = f"Tutor update: {ticket['reply']}"
    elif language == "am":
        update = "እስካሁን መልስ የለም። የምላሽ ጊዜ ይለያያል፤ ዋስትና የለውም።"
    else:
        update = "No tutor reply yet. Response times vary and are not guaranteed."
    return f"{update}\nCheck again with /status {reference}."


def handle_text(chat_id: int, text: str, username: str | None = None) -> str:
    parts = text.strip().split()
    if parts and parts[0].startswith("/"):
        command = parts[0].split("@", 1)[0].lower()
        args = parts[1:]
        language = chat_language(chat_id, text)
        if command == "/start":
            return (
                "Ask me about the lesson. Use /jobs, /person, or /lang am|en.\n"
                "ስለ ትምህርቱ ይጠይቁ። /jobs፣ /person ወይም /lang am|en ይጠቀሙ።"
            )
        if command == "/lang":
            if len(args) != 1 or args[0].lower() not in {"am", "en"}:
                return "Use /lang am or /lang en."
            language = args[0].lower()
            set_chat_language(chat_id, language)
            return (
                "ቋንቋው ወደ አማርኛ ተቀይሯል።"
                if language == "am"
                else "Language set to English."
            )
        if command == "/person":
            return _person_reply(chat_id, language, username)
        if command == "/status":
            if len(args) != 1:
                return "Use /status followed by the 8-character code from your tutor request."
            return _ticket_status(chat_id, args[0].upper(), language)
        if command == "/jobs":
            return jobs_reply(language)
        if command == "/alerts":
            if len(args) != 1 or args[0].lower() not in {"on", "off"}:
                return "Use /alerts on or /alerts off."
            enabled = args[0].lower() == "on"
            set_alert_subscription(chat_id, enabled)
            if language == "am":
                return "የሥራ ማስጠንቀቂያዎች በርተዋል።" if enabled else "የሥራ ማስጠንቀቂያዎች ጠፍተዋል።"
            return "Job alerts are on." if enabled else "Job alerts are off."
        return "I don't know that command. Try /start."

    question = text.strip()
    language = chat_language(chat_id, question)
    if not question or len(question) > 4000:
        return "Please send a question of 1 to 4000 characters."
    record_message(chat_id, "user", question)
    sections = indexed_sections()
    result = asyncio.run(answer_question(question, language, sections, allow_cloud=False, offline_only=api_main.offline_mode()))
    record_course_gap_analytics(question, language, sections, result)
    response = format_answer(result, language)
    record_message(chat_id, "assistant", response)
    return response


def telegram_call(token: str, method: str, payload: dict[str, Any]) -> Any:
    url = f"https://api.telegram.org/bot{token}/{method}"
    request = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=40) as response:
            result = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        raise RuntimeError(f"Telegram {method} returned HTTP {error.code}.") from None
    except (urllib.error.URLError, TimeoutError, OSError, ValueError):
        raise RuntimeError(f"Telegram {method} request failed.") from None
    if not isinstance(result, dict) or not result.get("ok"):
        raise RuntimeError(f"Telegram {method} was rejected.")
    return result.get("result")


def download_telegram_file(token: str, file_path: str) -> bytes:
    """Download a Telegram voice note with a bounded in-memory buffer."""
    if not isinstance(file_path, str) or not file_path or len(file_path) > 1000:
        raise RuntimeError("Telegram returned an invalid audio path.")
    request = urllib.request.Request(f"https://api.telegram.org/file/bot{token}/{file_path}", method="GET")
    try:
        with urllib.request.urlopen(request, timeout=40) as response:
            data = response.read(8_000_001)
    except (urllib.error.URLError, TimeoutError, OSError):
        raise RuntimeError("Telegram voice note download failed.") from None
    if not data or len(data) > 8_000_000:
        raise RuntimeError("Telegram voice note is empty or too large.")
    return data


def telegram_upload_voice(token: str, chat_id: int, audio: bytes) -> None:
    """Send a generated WAV through Telegram's multipart sendVoice endpoint."""
    if not isinstance(audio, bytes) or not audio or len(audio) > 8_000_000:
        return
    boundary = f"----dbassistant{secrets.token_hex(12)}"
    prefix = (
        f"--{boundary}\r\n"
        'Content-Disposition: form-data; name="chat_id"\r\n\r\n'
        f"{chat_id}\r\n"
        f"--{boundary}\r\n"
        'Content-Disposition: form-data; name="voice"; filename="answer.wav"\r\n'
        "Content-Type: audio/wav\r\n\r\n"
    ).encode("utf-8")
    body = prefix + audio + f"\r\n--{boundary}--\r\n".encode("ascii")
    request = urllib.request.Request(
        f"https://api.telegram.org/bot{token}/sendVoice",
        data=body,
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=40) as response:
            result = json.loads(response.read().decode("utf-8"))
    except (urllib.error.URLError, TimeoutError, OSError, ValueError):
        raise RuntimeError("Telegram voice reply failed.") from None
    if not isinstance(result, dict) or not result.get("ok"):
        raise RuntimeError("Telegram voice reply was rejected.")


def next_offset() -> int | None:
    with api_main.connect() as db:
        row = db.execute(
            "SELECT value FROM telegram_state WHERE key='update_offset'"
        ).fetchone()
    return int(row["value"]) if row else None


def save_offset(offset: int) -> None:
    with api_main.connect() as db:
        db.execute(
            "INSERT INTO telegram_state(key, value) VALUES('update_offset', ?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (str(offset),),
        )


def process_update(update: dict[str, Any], token: str) -> None:
    message = update.get("message")
    if not isinstance(message, dict):
        return
    chat = message.get("chat")
    if not isinstance(chat, dict) or not isinstance(chat.get("id"), int):
        return
    sender = message.get("from")
    username = sender.get("username") if isinstance(sender, dict) else None
    if isinstance(message.get("text"), str):
        response = handle_text(chat["id"], message["text"], username)
        telegram_call(token, "sendMessage", {"chat_id": chat["id"], "text": response[:4000]})
        return

    voice_message = message.get("voice") or message.get("audio")
    if not isinstance(voice_message, dict) or not isinstance(voice_message.get("file_id"), str):
        return
    file_info = telegram_call(token, "getFile", {"file_id": voice_message["file_id"]})
    if not isinstance(file_info, dict) or not isinstance(file_info.get("file_path"), str):
        raise RuntimeError("Telegram did not return a voice-note path.")
    result = handle_voice(chat["id"], download_telegram_file(token, file_info["file_path"]), username)
    telegram_call(token, "sendMessage", {"chat_id": chat["id"], "text": result["text"][:4000]})
    if result.get("audio"):
        try:
            telegram_upload_voice(token, chat["id"], result["audio"])
        except RuntimeError as error:
            logger.warning("Could not send Telegram voice read-back: %s", error)


def run() -> None:
    if api_main.offline_mode():
        raise RuntimeError("Telegram polling is disabled while OFFLINE_MODE is enabled.")
    token = os.getenv("TELEGRAM_BOT_TOKEN", "").strip()
    if not token:
        raise RuntimeError("Set TELEGRAM_BOT_TOKEN in the project .env file.")
    initialize_storage()
    offset = next_offset()
    logger.info("Telegram long polling started.")
    while True:
        try:
            updates = telegram_call(
                token,
                "getUpdates",
                {
                    "offset": offset,
                    "timeout": 30,
                    "allowed_updates": ["message"],
                },
            )
        except RuntimeError as error:
            logger.warning("%s Retrying in 5 seconds.", error)
            time.sleep(5)
            continue
        for update in updates if isinstance(updates, list) else []:
            if not isinstance(update, dict) or not isinstance(update.get("update_id"), int):
                continue
            try:
                process_update(update, token)
            except Exception as error:
                logger.error(
                    "Could not process Telegram update %s: %s",
                    update["update_id"],
                    type(error).__name__,
                )
                break
            offset = update["update_id"] + 1
            save_offset(offset)


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    run()
