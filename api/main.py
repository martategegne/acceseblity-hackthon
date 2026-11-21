"""Small SQLite backed escalation API and tutor queue."""
from __future__ import annotations

import base64
import binascii
import hashlib
import hmac
import html
import ipaddress
import json
import logging
import math
import os
import re
import secrets
import sqlite3
import time
import urllib.parse
import urllib.request
from collections import defaultdict, deque
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Literal
from uuid import uuid4

try:
    from cryptography.fernet import Fernet, InvalidToken
except ImportError:
    Fernet = None
    InvalidToken = Exception
from fastapi import BackgroundTasks, FastAPI, Header, HTTPException, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse
from fastapi.responses import Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from starlette.concurrency import run_in_threadpool

from .qa import answer_question
from .localization import api_message
from .retrieval import retrieve
from .voice import LANGUAGES as VOICE_LANGUAGES
from .voice import capabilities as voice_capabilities
from .voice import classify_command, guide as voice_guide, local_provider

ROOT = Path(__file__).resolve().parent
logger = logging.getLogger("db_assistant")

_RATE_LIMIT_EVENTS: dict[tuple[str, str], deque[float]] = defaultdict(deque)
_RATE_LIMIT_DEFAULTS = {"ask": 120, "escalations": 20, "sms": 30, "voice": 60}
_RATE_LIMIT_PATHS = {
    "/api/v1/ask": "ask",
    "/api/v1/escalations": "escalations",
    "/api/v1/sms/inbound": "sms",
    "/sms/inbound": "sms",
    "/api/v1/voice/commands": "voice",
    "/api/v1/voice/actions/sync": "voice",
    "/api/v1/voice/notes": "voice",
    "/voice/inbound": "voice",
    "/voice/answer": "voice",
    "/api/v1/voice/call/inbound": "voice",
    "/api/v1/voice/call/answer": "voice",
}
_REQUEST_ID_PATTERN = re.compile(r"^[A-Za-z0-9._:-]{8,100}$")
_HANDOFF_BRIEF_VERSION = 1
_HANDOFF_REASONS = {
    "answer_not_found",
    "learner_requested_person",
    "answer_flagged_incorrect",
    "other",
}
_EMAIL_PATTERN = re.compile(r"\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b", re.IGNORECASE)
_PHONE_PATTERN = re.compile(r"(?<!\w)(?:\+?\d[\d\s().-]{6,}\d)(?!\w)")


class HandoffSource(BaseModel):
    title: str
    url: str


class HandoffBrief(BaseModel):
    version: Literal[1]
    language: Literal["en", "am", "om", "ti", "so", "ar"]
    requestedPage: str
    summary: str
    source: HandoffSource | None
    reason: Literal["answer_not_found", "learner_requested_person", "answer_flagged_incorrect", "other"]
    evidenceStatus: Literal["available", "unavailable"]
    jobId: str | None = None


def load_env_file() -> None:
    env_file = ROOT / ".env"
    if not env_file.exists():
        return
    for line in env_file.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            key, value = line.split("=", 1)
            os.environ.setdefault(key.strip(), value.strip().strip('"\''))


load_env_file()
root_env_file = ROOT.parent / ".env"
if root_env_file.exists():
    for env_line in root_env_file.read_text(encoding="utf-8").splitlines():
        env_line = env_line.strip()
        if env_line and not env_line.startswith("#") and "=" in env_line:
            env_key, env_value = env_line.split("=", 1)
            os.environ.setdefault(env_key.strip(), env_value.strip().strip('"\''))

DB_PATH = Path(os.getenv("ESCALATIONS_DB", ROOT / "escalations.sqlite3"))


def offline_mode() -> bool:
    return os.getenv("OFFLINE_MODE", "true").strip().lower() not in {"0", "false", "no", "off"}


app = FastAPI(
    title="Learning Assistant & Course Escalations API",
    version="1.0.0",
    docs_url="/docs",
    redoc_url="/redoc",
    openapi_url="/openapi.json",
)

# CORS middleware for the web origin (e.g. http://localhost:8080) and all clients
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:8080",
        "http://127.0.0.1:8080",
        "http://localhost:8081",
        "http://127.0.0.1:8081",
        "*",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def _rate_limit_values(bucket: str) -> tuple[int, int]:
    try:
        limit = int(os.getenv(f"RATE_LIMIT_{bucket.upper()}", str(_RATE_LIMIT_DEFAULTS[bucket])))
        window = int(os.getenv("RATE_LIMIT_WINDOW_SECONDS", "60"))
    except ValueError:
        return _RATE_LIMIT_DEFAULTS[bucket], 60
    return max(0, limit), max(1, window)


def _rate_limit_retry_after(bucket: str, client_key: str, now: float | None = None) -> int | None:
    limit, window = _rate_limit_values(bucket)
    if limit == 0:
        return None
    current = time.monotonic() if now is None else now
    event_key = (bucket, client_key)
    events = _RATE_LIMIT_EVENTS.get(event_key, deque())
    while events and current - events[0] >= window:
        events.popleft()
    if not events:
        _RATE_LIMIT_EVENTS.pop(event_key, None)
    if len(events) >= limit:
        return max(1, math.ceil(window - (current - events[0])))
    events.append(current)
    _RATE_LIMIT_EVENTS[event_key] = events
    return None


@app.middleware("http")
async def request_operations_middleware(request: Request, call_next):
    incoming_id = request.headers.get("X-Request-ID", "")
    request_id = incoming_id if _REQUEST_ID_PATTERN.fullmatch(incoming_id) else str(uuid4())
    request.state.request_id = request_id
    bucket = _RATE_LIMIT_PATHS.get(request.url.path)
    if bucket and request.method == "POST":
        client_key = request.client.host if request.client else "unknown"
        try:
            is_private_proxy = ipaddress.ip_address(client_key).is_private
        except ValueError:
            is_private_proxy = False
        if is_private_proxy:
            forwarded = request.headers.get("x-forwarded-for", "").split(",")
            if forwarded and forwarded[-1].strip():
                client_key = forwarded[-1].strip()
        retry_after = _rate_limit_retry_after(bucket, client_key)
        if retry_after is not None:
            response = JSONResponse(
                status_code=429,
                content={"detail": "Too many requests. Please wait before trying again.", "requestId": request_id},
                headers={"Retry-After": str(retry_after)},
            )
            response.headers["X-Request-ID"] = request_id
            logger.info(json.dumps({
                "event": "request.rate_limited", "request_id": request_id,
                "method": request.method, "path": request.url.path, "status_code": 429,
                "retry_after_seconds": retry_after,
            }, separators=(",", ":")))
            return response
    started = time.monotonic()
    status_code = 500
    try:
        response = await call_next(request)
        status_code = response.status_code
        response.headers["X-Request-ID"] = request_id
        if request.url.path.startswith("/api/v1/voice/"):
            response.headers["Cache-Control"] = "no-store"
        return response
    finally:
        logger.info(json.dumps({
            "event": "request.completed", "request_id": request_id,
            "method": request.method, "path": request.url.path,
            "status_code": status_code,
            "duration_ms": round((time.monotonic() - started) * 1000, 2),
        }, separators=(",", ":")))


@app.exception_handler(RequestValidationError)
async def validation_exception_handler(request: Request, exc: RequestValidationError) -> JSONResponse:
    return JSONResponse(
        status_code=400,
        content={"detail": "Please check your request and send valid data."},
    )


ETHIOPIC_RANGE = re.compile(r"[\u1200-\u137F]")
SUPPORTED_LANGUAGES = {"en", "am", "om", "ti", "so", "ar"}
TRACK_GAP_LANGUAGES = ("en", "am", "ti", "om", "so")
GAP_OUTCOMES = ("answered", "not_found", "off_topic", "refused")
GAP_NO_TOPIC = "__no_match__"
GAP_NON_LESSON = "__non_lesson__"
GAP_REPORT_MINIMUM = 3

SECTION_SHORT_CODES = {
    "what-is-shaping-the-future-of-va-work": "Course s1",
    "artificial-intelligence-and-the-future-of-va-work": "Course s2",
    "what-clients-are-likely-to-value-more-and-more": "Course s3",
    "what-this-means-for-aspiring-virtual-assistants": "Course s4",
    "so-is-the-future-of-va-promising": "Course s5",
}

JOBS_FILE = ROOT.parent / "demo" / "data" / "jobs.json"
DEFAULT_COURSE_BASE_URL = "https://github.com/hudahussen2424-hash/acceseblity-hackthon/blob/main/"


def get_job_titles(lang: str = "en", limit: int = 3) -> list[str]:
    try:
        localized = []
        for section in indexed_sections():
            if section.get("type") != "job":
                continue
            title = section.get("titles", {}).get(lang)
            if not title:
                title = section.get("titles", {}).get("en") or section.get("title")
            if title:
                localized.append(str(title))
            if len(localized) == limit:
                return localized
    except (OSError, sqlite3.Error, TypeError, ValueError):
        pass
    if JOBS_FILE.exists():
        try:
            data = json.loads(JOBS_FILE.read_text(encoding="utf-8"))
            if isinstance(data, list):
                titles = []
                for item in data:
                    if isinstance(item, dict) and item.get("title"):
                        titles.append(str(item["title"]))
                    if len(titles) == limit:
                        break
                if titles:
                    return titles
        except Exception:
            pass

    with connect() as db:
        rows = db.execute("SELECT title_en, title_am FROM jobs LIMIT ?", (limit,)).fetchall()
        if rows:
            return [row["title_am"] if lang == "am" else row["title_en"] for row in rows]

    return ["Executive VA", "Social Media Assistant", "Customer Support VA"]


def hash_phone(phone: str | None) -> str:
    if not phone:
        return ""
    normalized = re.sub(r"[^\d]", "", str(phone))
    if not normalized:
        normalized = str(phone).strip()
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()


def normalize_ethiopian_phone(phone: str | None) -> str | None:
    """Normalize Ethiopian mobile forms 09..., 07..., +2519..., and +2517...."""
    if not isinstance(phone, str) or not phone.strip():
        return None
    compact = re.sub(r"[\s()\-]", "", phone)
    national = "0" + compact[4:] if compact.startswith("+251") else compact
    if re.fullmatch(r"09\d{8}", national):
        return "+251" + national[1:]
    if re.fullmatch(r"07\d{8}", national):
        return "+251" + national[1:]
    return None


def twilio_webhooks_enabled() -> bool:
    return os.getenv("TWILIO_WEBHOOKS_ENABLED", "false").strip().lower() in {"1", "true", "yes", "on"}


def _twilio_request_url(request: Request) -> str:
    """Rebuild the public callback URL when the app sits behind a proxy."""
    if request.url.path in {"/voice/answer", "/api/v1/voice/call/answer"}:
        configured_answer_url = os.getenv("VOICE_CALL_ANSWER_URL", "").strip()
        if configured_answer_url:
            parsed_answer = urllib.parse.urlsplit(configured_answer_url)
            if (
                parsed_answer.scheme != "https"
                or not parsed_answer.netloc
                or parsed_answer.fragment
                or parsed_answer.username
                or parsed_answer.password
            ):
                raise HTTPException(
                    status_code=503,
                    detail="VOICE_CALL_ANSWER_URL must be an absolute HTTPS URL.",
                )
            return configured_answer_url

    public_base = os.getenv("TWILIO_WEBHOOK_BASE_URL", "").strip()
    if not public_base:
        raise HTTPException(
            status_code=503,
            detail="TWILIO_WEBHOOK_BASE_URL is required for live webhook validation.",
        )

    parsed = urllib.parse.urlsplit(public_base)
    if (
        parsed.scheme != "https"
        or not parsed.netloc
        or parsed.path not in {"", "/"}
        or parsed.query
        or parsed.fragment
        or parsed.username
        or parsed.password
    ):
        raise HTTPException(
            status_code=503,
            detail="TWILIO_WEBHOOK_BASE_URL must be an HTTPS origin without a path.",
        )
    return urllib.parse.urlunsplit(
        (parsed.scheme, parsed.netloc, request.url.path, request.url.query, "")
    )


def _validate_twilio_webhook(request: Request, parameters: Any) -> None:
    """Validate provider form callbacks when live Twilio webhooks are enabled."""
    if not twilio_webhooks_enabled():
        return
    auth_token = os.getenv("TWILIO_AUTH_TOKEN", "").strip()
    if not auth_token:
        raise HTTPException(status_code=503, detail="TWILIO_AUTH_TOKEN is required for live webhooks.")
    signature = request.headers.get("X-Twilio-Signature", "")
    if not signature:
        raise HTTPException(status_code=403, detail="The Twilio signature is missing.")
    try:
        from twilio.request_validator import RequestValidator
    except ImportError as exc:
        raise HTTPException(status_code=503, detail="Install the Twilio Python helper library to validate webhooks.") from exc
    if not RequestValidator(auth_token).validate(_twilio_request_url(request), parameters, signature):
        raise HTTPException(status_code=403, detail="The Twilio signature is invalid.")


def sms_cipher():
    key = os.getenv("SMS_ENCRYPTION_KEY", "").strip()
    if not key or Fernet is None:
        return None
    try:
        return Fernet(key.encode("ascii"))
    except (ValueError, UnicodeEncodeError):
        return None


def sms_alert_delivery_configured() -> bool:
    return bool(
        os.getenv("TWILIO_ACCOUNT_SID", "").strip()
        and os.getenv("TWILIO_AUTH_TOKEN", "").strip()
        and os.getenv("TWILIO_FROM_NUMBER", "").strip()
        and sms_cipher()
    )


def encrypt_sms_phone(phone: str) -> str | None:
    cipher = sms_cipher()
    return cipher.encrypt(phone.encode("utf-8")).decode("ascii") if cipher else None


def decrypt_sms_phone(ciphertext: str) -> str | None:
    cipher = sms_cipher()
    if not cipher:
        return None
    try:
        return cipher.decrypt(ciphertext.encode("ascii")).decode("utf-8")
    except (InvalidToken, ValueError, UnicodeDecodeError):
        return None


SMS_LANGUAGES = ("en", "am", "ti", "om", "so")


def detect_language(text: str, preferred: str | None = None) -> str:
    """Honor an explicit SMS preference; otherwise infer Amharic from its script."""
    if preferred in SMS_LANGUAGES:
        return preferred
    return "am" if ETHIOPIC_RANGE.search(text) else "en"


def get_sms_language(phone_hash: str) -> str | None:
    if not phone_hash:
        return None
    with connect() as db:
        row = db.execute(
            "SELECT language FROM sms_language_preferences WHERE phone_hash=?",
            (phone_hash,),
        ).fetchone()
    language = row["language"] if row else None
    return language if language in SMS_LANGUAGES else None


def set_sms_language(phone_hash: str, language: str) -> None:
    if language not in SMS_LANGUAGES:
        raise ValueError("Unsupported SMS language")
    with connect() as db:
        db.execute(
            "INSERT INTO sms_language_preferences(phone_hash, language, updated_at) VALUES(?, ?, ?) "
            "ON CONFLICT(phone_hash) DO UPDATE SET language=excluded.language, updated_at=excluded.updated_at",
            (phone_hash, language, datetime.now(timezone.utc).isoformat()),
        )


def get_source_short_code(
    source: dict[str, Any], sections: list[dict[str, Any]], language: str = "en"
) -> str:
    url = str(source.get("url") or "")
    anchor = url.split("#")[-1] if "#" in url else ""
    if anchor in SECTION_SHORT_CODES:
        number = re.search(r"s(\d+)$", SECTION_SHORT_CODES[anchor])
        return f"{api_message(language, 'sms_source_prefix')} s{number.group(1)}" if number else api_message(language, "sms_source_prefix")

    match = re.search(r"(?:section|s)[-_]?(\d+)", url, re.IGNORECASE)
    if match:
        return f"{api_message(language, 'sms_source_prefix')} s{match.group(1)}"

    for idx, s in enumerate(sections):
        if s.get("url") == url or s.get("id") == anchor:
            return f"{api_message(language, 'sms_source_prefix')} s{idx + 1}"

    return f"{api_message(language, 'sms_source_prefix')} s1"


def format_sms_message(
    body: str,
    source_code: str | None = None,
    *,
    source_url: str | None = None,
    suffix: str | None = None,
) -> str:
    body = re.sub(r"\s+", " ", body).strip()
    suffix_parts = []
    if source_code:
        suffix_parts.append(f"({source_code})")
    if source_url:
        suffix_parts.append(source_url)
    if suffix:
        suffix_parts.append(suffix)
    suffix = f" {' '.join(suffix_parts)}" if suffix_parts else ""
    budget_units = _sms_limit(body + suffix) - _sms_units(suffix)
    if _sms_units(body) <= budget_units:
        return f"{body}{suffix}"
    if budget_units <= 0:
        return suffix[:160]

    truncated = ""
    units = 0
    for character in body:
        character_units = _sms_units(character)
        if units + character_units > budget_units:
            break
        truncated += character
        units += character_units
    last_space = truncated.rfind(" ")
    if last_space > 0:
        truncated = truncated[:last_space].rstrip()
    if _sms_units(truncated + "..." + suffix) <= _sms_limit(body + suffix):
        truncated += "..."
    return f"{truncated}{suffix}"


def absolute_course_url(url: str) -> str:
    if urllib.parse.urlsplit(url).scheme in {"http", "https"}:
        return url
    base_url = os.getenv("COURSE_BASE_URL", DEFAULT_COURSE_BASE_URL)
    return urllib.parse.urljoin(base_url.rstrip("/") + "/", url.lstrip("/"))


_GSM7_BASIC = set(
    "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ"
    " !\"#¤%&'()*+,-./0123456789:;<=>?¡"
    "ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿"
    "abcdefghijklmnopqrstuvwxyzäöñüà"
)
_GSM7_EXTENSION = set("^{}\\[~]|€\f")


def _sms_units(text: str) -> int:
    if all(character in _GSM7_BASIC or character in _GSM7_EXTENSION for character in text):
        return sum(2 if character in _GSM7_EXTENSION else 1 for character in text)
    return len(text.encode("utf-16-le")) // 2


def _sms_limit(text: str) -> int:
    return 160 if all(character in _GSM7_BASIC or character in _GSM7_EXTENSION for character in text) else 70


def send_sms_job_alerts(body: str, source_url: str | None = None) -> dict[str, int]:
    if offline_mode():
        return {"sent": 0, "failed": 0, "skipped": 1}
    sid = os.getenv("TWILIO_ACCOUNT_SID", "").strip()
    auth_token = os.getenv("TWILIO_AUTH_TOKEN", "").strip()
    from_number = os.getenv("TWILIO_FROM_NUMBER", "").strip()
    if not (sid and auth_token and from_number):
        return {"sent": 0, "failed": 0, "skipped": 0}
    with connect() as db:
        subscribers = db.execute(
            "SELECT phone_ciphertext FROM sms_alerts WHERE active=1 AND phone_ciphertext IS NOT NULL"
        ).fetchall()
    sent = failed = skipped = 0
    url = f"https://api.twilio.com/2010-04-01/Accounts/{sid}/Messages.json"
    auth = base64.b64encode(f"{sid}:{auth_token}".encode("utf-8")).decode("ascii")
    for row in subscribers:
        phone = decrypt_sms_phone(row["phone_ciphertext"])
        if not phone:
            skipped += 1
            continue
        formatted = format_sms_message(
            body,
            source_url=absolute_course_url(source_url) if source_url else None,
        )
        data = urllib.parse.urlencode({"To": phone, "From": from_number, "Body": formatted}).encode("utf-8")
        request = urllib.request.Request(url, data=data, headers={"Authorization": f"Basic {auth}", "Content-Type": "application/x-www-form-urlencoded"}, method="POST")
        try:
            with urllib.request.urlopen(request, timeout=8) as response:
                if 200 <= response.status < 300:
                    sent += 1
                else:
                    failed += 1
        except Exception:
            failed += 1
    return {"sent": sent, "failed": failed, "skipped": skipped}


class _ClosingConnection(sqlite3.Connection):
    """Make ``with connect()`` release SQLite file handles on Windows too."""

    def __exit__(self, exc_type, exc_value, traceback):
        try:
            return super().__exit__(exc_type, exc_value, traceback)
        finally:
            self.close()


def connect() -> sqlite3.Connection:
    db = sqlite3.connect(DB_PATH, factory=_ClosingConnection)
    db.row_factory = sqlite3.Row
    return db


def purge_expired_tickets(db: sqlite3.Connection) -> None:
    try:
        retention_days = int(os.getenv("TICKET_RETENTION_DAYS", "90"))
    except ValueError as exc:
        raise ValueError("TICKET_RETENTION_DAYS must be a non-negative integer.") from exc
    if retention_days < 0:
        raise ValueError("TICKET_RETENTION_DAYS must be a non-negative integer.")
    if retention_days == 0:
        return
    cutoff = (datetime.now(timezone.utc) - timedelta(days=retention_days)).isoformat()
    db.execute(
        "DELETE FROM escalation_signals WHERE ticket_id IN "
        "(SELECT id FROM escalations WHERE created_at < ?)",
        (cutoff,),
    )
    try:
        db.execute(
            "DELETE FROM voice_action_idempotency WHERE ticket_id IN "
            "(SELECT id FROM escalations WHERE created_at < ?)",
            (cutoff,),
        )
    except sqlite3.OperationalError:
        pass
    db.execute("DELETE FROM escalations WHERE created_at < ?", (cutoff,))


def initialize() -> None:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    with connect() as db:
        db.execute("""CREATE TABLE IF NOT EXISTS escalations (
            id TEXT PRIMARY KEY, conversation TEXT NOT NULL, language TEXT NOT NULL,
            page TEXT NOT NULL, note TEXT NOT NULL, audio_json TEXT, type TEXT NOT NULL DEFAULT 'person',
            job_id TEXT, accommodation TEXT, screen_context_json TEXT, reply TEXT, created_at TEXT NOT NULL,
            replied_at TEXT, status TEXT NOT NULL DEFAULT 'waiting', phone TEXT,
            handoff_brief_json TEXT
        )""")
        columns = {row[1] for row in db.execute("PRAGMA table_info(escalations)")}
        if "audio_json" not in columns:
            db.execute("ALTER TABLE escalations ADD COLUMN audio_json TEXT")
        for column, definition in (
            ("type", "TEXT NOT NULL DEFAULT 'person'"),
            ("job_id", "TEXT"),
            ("accommodation", "TEXT"),
            ("screen_context_json", "TEXT"),
            ("phone", "TEXT"),
            ("access_token_hash", "TEXT"),
            ("handoff_brief_json", "TEXT"),
        ):
            if column not in columns:
                db.execute(f"ALTER TABLE escalations ADD COLUMN {column} {definition}")
        db.execute("""CREATE TABLE IF NOT EXISTS escalation_signals (
            ticket_id TEXT NOT NULL, signal_type TEXT NOT NULL, sdp TEXT NOT NULL,
            created_at TEXT NOT NULL, PRIMARY KEY(ticket_id, signal_type)
        )""")
        db.execute("""CREATE TABLE IF NOT EXISTS voice_action_idempotency (
            idempotency_key_hash TEXT PRIMARY KEY,
            request_hash TEXT NOT NULL,
            ticket_id TEXT NOT NULL,
            created_at TEXT NOT NULL
        )""")
        purge_expired_tickets(db)
        signal_expiry = (datetime.now(timezone.utc) - timedelta(minutes=10)).isoformat()
        db.execute("DELETE FROM escalation_signals WHERE created_at < ?", (signal_expiry,))
        db.execute("""CREATE TABLE IF NOT EXISTS content_sections (
            id TEXT PRIMARY KEY, section_json TEXT NOT NULL
        )""")
        db.execute("""CREATE TABLE IF NOT EXISTS answer_feedback (
            id TEXT PRIMARY KEY, kind TEXT NOT NULL, reason TEXT NOT NULL,
            source_url TEXT NOT NULL, created_at TEXT NOT NULL,
            reviewed INTEGER NOT NULL DEFAULT 0
        )""")
        db.execute("""CREATE TABLE IF NOT EXISTS course_gap_aggregates (
            day_bucket TEXT NOT NULL,
            language TEXT NOT NULL,
            topic_id TEXT NOT NULL,
            outcome TEXT NOT NULL,
            count INTEGER NOT NULL DEFAULT 0 CHECK(count >= 0),
            PRIMARY KEY(day_bucket, language, topic_id, outcome)
        )""")
        db.execute("CREATE INDEX IF NOT EXISTS idx_course_gap_day ON course_gap_aggregates(day_bucket)")
        try:
            gap_retention_days = max(0, int(os.getenv("COURSE_GAP_RETENTION_DAYS", "90")))
        except ValueError:
            gap_retention_days = 90
        if gap_retention_days == 0:
            db.execute("DELETE FROM course_gap_aggregates")
        else:
            gap_cutoff = (datetime.now(timezone.utc).date() - timedelta(days=gap_retention_days)).isoformat()
            db.execute("DELETE FROM course_gap_aggregates WHERE day_bucket < ?", (gap_cutoff,))
        db.execute("CREATE INDEX IF NOT EXISTS idx_escalations_status_created ON escalations(status, created_at)")
        db.execute("CREATE INDEX IF NOT EXISTS idx_escalations_replied_at ON escalations(replied_at)")
        db.execute("CREATE INDEX IF NOT EXISTS idx_answer_feedback_reviewed_created ON answer_feedback(reviewed, created_at)")
        db.execute("""CREATE TABLE IF NOT EXISTS sms_alerts (
            phone_hash TEXT PRIMARY KEY,
            active INTEGER NOT NULL DEFAULT 1,
            phone_ciphertext TEXT,
            updated_at TEXT NOT NULL
        )""")
        db.execute("""CREATE TABLE IF NOT EXISTS sms_language_preferences (
            phone_hash TEXT PRIMARY KEY,
            language TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )""")
        sms_columns = {row[1] for row in db.execute("PRAGMA table_info(sms_alerts)")}
        if "phone_ciphertext" not in sms_columns:
            db.execute("ALTER TABLE sms_alerts ADD COLUMN phone_ciphertext TEXT")
        db.execute("""CREATE TABLE IF NOT EXISTS jobs (
            id TEXT PRIMARY KEY,
            title_en TEXT NOT NULL,
            title_am TEXT NOT NULL
        )""")
        count_jobs = db.execute("SELECT COUNT(*) FROM jobs").fetchone()[0]
        if count_jobs == 0:
            db.executemany(
                "INSERT INTO jobs (id, title_en, title_am) VALUES (?, ?, ?)",
                [
                    ("1", "Executive VA", "አስፈፃሚ ቨርቹዋል ረዳት"),
                    ("2", "Social Media Assistant", "የማህበራዊ ሚዲያ ረዳት"),
                    ("3", "Customer Support VA", "የደንበኞች አገልግሎት ረዳት"),
                ],
            )
        seed_file = ROOT.parent / "demo" / "data" / "content.json"
        if seed_file.exists():
            try:
                sections = json.loads(seed_file.read_text(encoding="utf-8"))
                if isinstance(sections, list):
                    for section in sections:
                        if not isinstance(section, dict):
                            continue
                        section_id = str(section.get("id", uuid4()))
                        stored = db.execute(
                            "SELECT section_json FROM content_sections WHERE id=?",
                            (section_id,),
                        ).fetchone()
                        if stored is None or "[CHECK]" in stored["section_json"]:
                            db.execute(
                                "INSERT OR REPLACE INTO content_sections(id,section_json) VALUES(?,?)",
                                (section_id, json.dumps(section, ensure_ascii=False)),
                            )
                        else:
                            try:
                                current = json.loads(stored["section_json"])
                            except ValueError:
                                current = None
                            if isinstance(current, dict):
                                changed = False
                                seed_text = section.get("text")
                                current_text = current.get("text")
                                if isinstance(seed_text, dict):
                                    if isinstance(current_text, str):
                                        current_text = {"en": current_text}
                                        current["text"] = current_text
                                        changed = True
                                    if isinstance(current_text, dict):
                                        for language in ("ti", "om", "so"):
                                            if not current_text.get(language) and seed_text.get(language):
                                                current_text[language] = seed_text[language]
                                                changed = True
                                seed_titles = section.get("titles")
                                if isinstance(seed_titles, dict):
                                    current_titles = current.setdefault("titles", {})
                                    if isinstance(current_titles, dict):
                                        for language in ("ti", "om", "so"):
                                            if not current_titles.get(language) and seed_titles.get(language):
                                                current_titles[language] = seed_titles[language]
                                                changed = True
                                if changed:
                                    db.execute(
                                        "UPDATE content_sections SET section_json=? WHERE id=?",
                                        (json.dumps(current, ensure_ascii=False), section_id),
                                    )
            except (OSError, ValueError):
                pass


initialize()


@app.get("/health/live", include_in_schema=False)
def health_live() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/health/ready", include_in_schema=False, response_model=None)
def health_ready():
    try:
        with connect() as db:
            db.execute("SELECT 1").fetchone()
            sections = db.execute("SELECT COUNT(*) FROM content_sections").fetchone()[0]
        if sections == 0:
            raise RuntimeError("course content is empty")
    except (sqlite3.Error, OSError, RuntimeError):
        logger.exception("Readiness check failed (database/content unavailable)")
        return JSONResponse(status_code=503, content={"status": "not_ready"})
    return {"status": "ready"}


@app.get("/api/v1/helper/metrics")
def helper_metrics(x_helper_token: str | None = Header(default=None)) -> dict[str, Any]:
    """Return privacy-safe tutor queue and response-time totals."""
    helper_auth(x_helper_token)
    try:
        stale_minutes = max(1, int(os.getenv("TUTOR_STALE_MINUTES", "60")))
    except ValueError:
        stale_minutes = 60
    now = datetime.now(timezone.utc)
    stale_before = (now - timedelta(minutes=stale_minutes)).isoformat()
    history_after = (now - timedelta(days=30)).isoformat()
    with connect() as db:
        purge_expired_tickets(db)
        totals = db.execute(
            "SELECT COUNT(*) AS total, "
            "SUM(CASE WHEN status='waiting' THEN 1 ELSE 0 END) AS waiting, "
            "SUM(CASE WHEN status='answered' THEN 1 ELSE 0 END) AS answered "
            "FROM escalations"
        ).fetchone()
        oldest = db.execute(
            "SELECT created_at FROM escalations WHERE status='waiting' ORDER BY created_at LIMIT 1"
        ).fetchone()
        stale_count = db.execute(
            "SELECT COUNT(*) FROM escalations WHERE status='waiting' AND created_at < ?",
            (stale_before,),
        ).fetchone()[0]
        response_time = db.execute(
            "SELECT AVG((julianday(replied_at)-julianday(created_at))*1440) "
            "FROM escalations WHERE replied_at IS NOT NULL AND created_at >= ?",
            (history_after,),
        ).fetchone()[0]
        feedback = db.execute(
            "SELECT COUNT(*) FROM answer_feedback WHERE reviewed=0"
        ).fetchone()[0]
    oldest_minutes = None
    if oldest:
        try:
            created = datetime.fromisoformat(oldest["created_at"].replace("Z", "+00:00"))
            if created.tzinfo is None:
                created = created.replace(tzinfo=timezone.utc)
            oldest_minutes = max(0, round((now - created).total_seconds() / 60, 1))
        except ValueError:
            oldest_minutes = None
    return {
        "asOf": now.isoformat(),
        "queue": {
            "waiting": totals["waiting"] or 0,
            "answered": totals["answered"] or 0,
            "total": totals["total"] or 0,
            "staleWaiting": stale_count,
            "staleAfterMinutes": stale_minutes,
            "oldestWaitingMinutes": oldest_minutes,
        },
        "last30Days": {
            "averageReplyMinutes": round(response_time, 1) if response_time is not None else None,
            "unreviewedAnswerFeedback": feedback,
        },
    }


@app.get("/api/v1/helper/content-health")
def helper_content_health(x_helper_token: str | None = Header(default=None)) -> dict[str, Any]:
    """Check indexed course records for missing evidence and locale coverage."""
    helper_auth(x_helper_token)
    with connect() as db:
        rows = db.execute("SELECT id, section_json FROM content_sections ORDER BY id").fetchall()
    issues: list[dict[str, str]] = []
    urls: dict[str, str] = {}
    if not rows:
        issues.append({"sectionId": "", "code": "course_content_empty"})
    for row in rows:
        section_id = row["id"]
        try:
            section = json.loads(row["section_json"])
        except (TypeError, ValueError):
            issues.append({"sectionId": section_id, "code": "invalid_json"})
            continue
        if not isinstance(section, dict):
            issues.append({"sectionId": section_id, "code": "invalid_section"})
            continue
        title = section.get("title")
        titles = section.get("titles") if isinstance(section.get("titles"), dict) else {}
        for language in sorted(SUPPORTED_LANGUAGES):
            localized_title = titles.get(language)
            if language == "en" and not localized_title and isinstance(title, str):
                localized_title = title
            if not isinstance(localized_title, str) or not localized_title.strip():
                issues.append({"sectionId": section_id, "code": f"missing_{language}_title"})
        url = section.get("url")
        if not isinstance(url, str) or not url.strip():
            issues.append({"sectionId": section_id, "code": "missing_source_url"})
        elif url in urls:
            issues.append({"sectionId": section_id, "code": "duplicate_source_url"})
        else:
            urls[url] = section_id
        text = section.get("text")
        if not isinstance(text, (str, dict)) or not (text.strip() if isinstance(text, str) else text):
            issues.append({"sectionId": section_id, "code": "missing_text"})
            continue
        localized_text = text if isinstance(text, dict) else {"en": text}
        for language in sorted(SUPPORTED_LANGUAGES):
            if not isinstance(localized_text.get(language), str) or not localized_text[language].strip():
                issues.append({"sectionId": section_id, "code": f"missing_{language}_text"})
        if any("[CHECK]" in value for value in localized_text.values() if isinstance(value, str)):
            issues.append({"sectionId": section_id, "code": "placeholder_text"})
    return {
        "checkedAt": datetime.now(timezone.utc).isoformat(),
        "sectionsChecked": len(rows),
        "healthy": not issues,
        "issueCount": len(issues),
        "issues": issues[:200],
        "issuesTruncated": len(issues) > 200,
    }


def helper_auth(token: str | None) -> None:
    expected = os.getenv("HELPER_TOKEN", "").strip()
    if not expected:
        raise HTTPException(status_code=503, detail="Helper access is disabled until HELPER_TOKEN is configured.")
    if not token or not hmac.compare_digest(token, expected):
        raise HTTPException(status_code=401, detail="Enter a valid helper token.")


def plain_bad(message: str, language: str = "en", key: str | None = None) -> None:
    detail = api_message(language, key, message) if key else message
    raise HTTPException(status_code=400, detail=detail)


def notify_webhook(ticket_id: str, at: str | None = None) -> None:
    if offline_mode():
        return
    url = os.getenv("WEBHOOK_URL", "").strip()
    if not url:
        return
    if not at:
        try:
            with connect() as db:
                row = db.execute("SELECT created_at FROM escalations WHERE id=?", (ticket_id,)).fetchone()
                at = row["created_at"] if row else datetime.now(timezone.utc).isoformat()
        except Exception:
            at = datetime.now(timezone.utc).isoformat()
    data = json.dumps({
        "event": "ticket.opened",
        "ticketId": ticket_id,
        "at": at,
    }).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=data,
        headers={"Content-Type": "application/json", "User-Agent": "FastAPI-Webhook/1.0"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=5) as response:
            pass
    except Exception:
        # A failed notification must not undo a saved learner ticket.
        pass


def indexed_sections() -> list[dict[str, Any]]:
    with connect() as db:
        rows = db.execute("SELECT section_json FROM content_sections ORDER BY rowid").fetchall()
    sections = [json.loads(row["section_json"]) for row in rows]
    for section in sections:
        if isinstance(section, dict):
            section.setdefault("type", "lesson")
    try:
        jobs = json.loads(JOBS_FILE.read_text(encoding="utf-8")) if JOBS_FILE.exists() else []
    except (OSError, ValueError):
        jobs = []
    if isinstance(jobs, list):
        known = {item.get("id") for item in sections if isinstance(item, dict)}
        for job in jobs:
            if not isinstance(job, dict) or job.get("id") in known:
                continue
            accommodations = job.get("accommodations", [])
            english_details = [job.get("description", ""), job.get("location", ""), *accommodations]
            titles = {"en": job.get("title", ""), "am": job.get("title", "")}
            text = {
                "en": ". ".join(str(value) for value in english_details if value),
                "am": ". ".join(str(value) for value in english_details if value),
            }
            for language in ("am", "ti", "om", "so"):
                translations = job.get("translations")
                translation = translations.get(language) if isinstance(translations, dict) else None
                if not isinstance(translation, dict) or not translation.get("description"):
                    continue
                titles[language] = translation.get("title", "")
                details = [
                    translation["description"],
                    job.get("location", ""),
                    *(translation.get("accommodations") or []),
                ]
                text[language] = ". ".join(str(value) for value in details if value)
            sections.append({
                **job,
                "type": "job",
                "titles": titles,
                "text": text,
            })
    return sections


def _handoff_page(page: str) -> str:
    """Keep the requested page path without URL credentials, query strings, or fragments."""
    try:
        parts = urllib.parse.urlsplit(page)
        if parts.scheme in {"http", "https"} and parts.hostname:
            host = parts.hostname
            if ":" in host and not host.startswith("["):
                host = f"[{host}]"
            port = f":{parts.port}" if parts.port else ""
            return urllib.parse.urlunsplit((parts.scheme, f"{host}{port}", parts.path, "", ""))
        if not parts.scheme and parts.path.startswith("/") and not parts.path.startswith("//"):
            return parts.path
    except ValueError:
        pass
    return "Not a web lesson or job page"


def _redact_brief_text(value: str, limit: int = 280) -> str:
    text = _EMAIL_PATTERN.sub("[redacted]", value)
    text = _PHONE_PATTERN.sub("[redacted]", text)
    text = " ".join("".join(character for character in text if character.isprintable()).split())
    return text[:limit].rstrip()


def _safe_handoff_source_url(url: str) -> bool:
    try:
        parts = urllib.parse.urlsplit(url)
    except ValueError:
        return False
    if parts.scheme:
        return parts.scheme in {"http", "https"} and bool(parts.hostname)
    return bool(parts.path) and not parts.netloc and not url.startswith(("\\", "//"))


def _handoff_reason(conversation: list[dict[str, Any]], requested: str | None) -> str:
    if requested is not None:
        return requested
    for message in reversed(conversation):
        if (
            isinstance(message, dict)
            and message.get("role") == "assistant"
            and message.get("answerStatus") == "not_found"
        ):
            return "answer_not_found"
    return "learner_requested_person"


def build_handoff_brief(
    conversation: list[dict[str, Any]],
    language: str,
    page: str,
    *,
    handoff_reason: str | None = None,
    job_id: str | None = None,
    sections: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Build a bounded helper brief locally from the conversation and indexed evidence."""
    latest_question = next(
        (
            message["text"].strip()
            for message in reversed(conversation)
            if isinstance(message, dict)
            and message.get("role", message.get("from")) == "user"
            and isinstance(message.get("text"), str)
            and message["text"].strip()
        ),
        "",
    )
    reason = _handoff_reason(conversation, handoff_reason)
    if reason not in _HANDOFF_REASONS:
        reason = "other"

    source = None
    excerpt = ""
    if latest_question:
        try:
            threshold = float(os.getenv("THRESHOLD", "0.25"))
        except ValueError:
            threshold = 0.25
        available_sections = sections if sections is not None else indexed_sections()
        ranked = retrieve(latest_question[:4000], available_sections, language)
        score, match = ranked[0] if ranked else (0.0, None)
        if (
            match is not None
            and score >= threshold
            and isinstance(match.get("title"), str)
            and match["title"].strip()
            and isinstance(match.get("url"), str)
            and _safe_handoff_source_url(match["url"])
        ):
            source = {"title": match["title"][:300], "url": match["url"][:2000]}
            text = match.get("text")
            excerpt = _redact_brief_text(text) if isinstance(text, str) else ""

    if source:
        summary = f'The learner question matched indexed course material: "{source["title"]}".'
        if excerpt:
            summary += f" Relevant indexed excerpt: {excerpt}"
    else:
        summary = "No indexed course content met the retrieval threshold for the conversation."

    brief: dict[str, Any] = {
        "version": _HANDOFF_BRIEF_VERSION,
        "language": language,
        "requestedPage": _handoff_page(page),
        "summary": summary[:600],
        "source": source,
        "reason": reason,
        "evidenceStatus": "available" if source else "unavailable",
    }
    if isinstance(job_id, str) and job_id.strip():
        brief["jobId"] = job_id.strip()[:200]
    return brief


def save_escalation_record(
    conversation: list[dict[str, Any]], language: str, page: str, note: str,
    audio_json: str | None = None, ticket_type: str = "person",
    job_id: str | None = None, accommodation: str | None = None,
    screen_context_json: str | None = None,
    created_at: str | None = None,
    phone: str | None = None,
    access_token_hash: str | None = None,
    handoff_reason: str | None = None,
    db: sqlite3.Connection | None = None,
    ticket_id: str | None = None,
) -> str:
    ticket_id = ticket_id or str(uuid4())
    created = created_at or datetime.now(timezone.utc).isoformat()
    brief = build_handoff_brief(
        conversation,
        language,
        page,
        handoff_reason=handoff_reason,
        job_id=job_id,
    )
    def insert_record(connection: sqlite3.Connection) -> None:
        purge_expired_tickets(connection)
        connection.execute(
            "INSERT INTO escalations(id,conversation,language,page,note,audio_json,type,job_id,accommodation,screen_context_json,created_at,phone,access_token_hash,handoff_brief_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (
                ticket_id, json.dumps(conversation, ensure_ascii=False), language, page,
                note.strip(), audio_json, ticket_type, job_id, accommodation,
                screen_context_json, created, phone, access_token_hash,
                json.dumps(brief, ensure_ascii=False),
            ),
        )
    if db is None:
        with connect() as connection:
            insert_record(connection)
    else:
        insert_record(db)
    return ticket_id


@app.post("/api/v1/content")
async def index_content(
    request: Request,
    x_helper_token: str | None = Header(default=None),
) -> dict[str, int]:
    helper_auth(x_helper_token)
    try:
        payload = await request.json()
    except Exception:
        plain_bad("Send valid JSON course content.")
    sections = payload.get("sections") if isinstance(payload, dict) else payload
    if not isinstance(sections, list) or len(sections) > 5000:
        plain_bad("Send a list of up to 5000 course sections.")
    rows = []
    for section in sections:
        if not isinstance(section, dict):
            plain_bad("Each course section must be an object.")
        section_id = section.get("id")
        title, url, text = section.get("title"), section.get("url", ""), section.get("text")
        if not isinstance(section_id, str) or not section_id.strip():
            plain_bad("Each course section needs an id.")
        if not isinstance(title, str) or not title.strip() or not isinstance(url, str) or not url.strip():
            plain_bad("Each course section needs a title and a text URL.")
        if not isinstance(text, (str, dict)):
            plain_bad("Each course section needs text.")
        if isinstance(text, dict) and any(not isinstance(value, str) for value in text.values()):
            plain_bad("Translated course text must be words in each language field.")
        normalized = {"id": section_id.strip(), "title": title.strip(), "url": url, "text": text}
        titles = section.get("titles")
        if titles is not None:
            if not isinstance(titles, dict) or not titles or any(
                language not in SUPPORTED_LANGUAGES
                or not isinstance(localized_title, str)
                or not localized_title.strip()
                for language, localized_title in titles.items()
            ):
                plain_bad("Localized course titles must use supported language codes and non-empty text.")
            normalized["titles"] = {
                language: localized_title.strip()
                for language, localized_title in titles.items()
            }
        source_type = section.get("type", "lesson")
        if source_type not in ("lesson", "job"):
            plain_bad("Section type must be lesson or job.")
        normalized["type"] = source_type
        rows.append((normalized["id"], json.dumps(normalized, ensure_ascii=False)))
    with connect() as db:
        db.executemany("INSERT OR REPLACE INTO content_sections(id,section_json) VALUES(?,?)", rows)
    return {"indexed": len(rows)}


@app.get("/api/v1/content")
def get_content() -> list[dict[str, Any]]:
    return indexed_sections()


def _voice_secret() -> bytes:
    secret = os.getenv("VOICE_ACTION_SECRET", "").encode("utf-8")
    if len(secret) < 32:
        raise HTTPException(status_code=503, detail="VOICE_ACTION_SECRET must contain at least 32 characters.")
    return secret


def _decode_voice_audio(data_url: Any, mime_type: Any = None) -> bytes:
    if not isinstance(data_url, str) or len(data_url) > 11_000_000:
        plain_bad("Voice audio must be a base64 data URL smaller than 8 MB.")
    if not data_url.startswith("data:audio/") or ";base64," not in data_url:
        plain_bad("Voice audio must use a supported audio data URL.")
    declared_type, encoded = data_url[5:].split(";base64,", 1)
    if mime_type is not None and mime_type != declared_type:
        plain_bad("Voice audio type does not match its data URL.")
    try:
        audio = base64.b64decode(encoded, validate=True)
    except (ValueError, binascii.Error):
        plain_bad("Voice audio data is not valid base64.")
    if not audio or len(audio) > 8_000_000:
        plain_bad("Voice audio must be between 1 byte and 8 MB.")
    return audio


def _voice_draft_token(draft: dict[str, Any]) -> str:
    raw = json.dumps(draft, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()
    encoded = base64.urlsafe_b64encode(raw).decode().rstrip("=")
    signature = hmac.new(_voice_secret(), encoded.encode(), hashlib.sha256).hexdigest()
    return f"{encoded}.{signature}"


def _read_voice_draft(token: str, *, allow_expired: bool = False) -> dict[str, Any]:
    try:
        encoded, signature = token.rsplit(".", 1)
        expected = hmac.new(_voice_secret(), encoded.encode(), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(signature, expected):
            raise ValueError
        draft = json.loads(base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4)))
        if not isinstance(draft, dict) or (not allow_expired and int(draft.get("expiresAt", 0)) <= int(time.time())):
            raise ValueError
        return draft
    except (ValueError, TypeError, json.JSONDecodeError, binascii.Error):
        raise HTTPException(status_code=400, detail="The voice draft is invalid or expired.")


def _existing_voice_send(draft: dict[str, Any], idempotency_key: str) -> dict[str, Any] | None:
    if not re.fullmatch(r"[A-Za-z0-9._:-]{16,128}", idempotency_key):
        return None
    canonical = json.dumps(draft, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    request_hash = hashlib.sha256(canonical.encode()).hexdigest()
    key_hash = hashlib.sha256(idempotency_key.encode()).hexdigest()
    with connect() as db:
        existing = db.execute("SELECT request_hash,ticket_id FROM voice_action_idempotency WHERE idempotency_key_hash=?", (key_hash,)).fetchone()
    if existing is None:
        return None
    if not hmac.compare_digest(existing["request_hash"], request_hash):
        raise HTTPException(status_code=409, detail="This idempotency key was already used for a different request.")
    access_token = hmac.new(_voice_secret(), f"voice-ticket:{existing['ticket_id']}:{key_hash}".encode(), hashlib.sha256).hexdigest()
    return {"ticketId": existing["ticket_id"], "accessToken": access_token, "message": "Your tutor request was already sent."}


def _read_confirmed_draft(token: str, idempotency_key: str | None) -> tuple[dict[str, Any], dict[str, Any] | None]:
    try:
        return _read_voice_draft(token), None
    except HTTPException as exc:
        if exc.status_code != 400 or not idempotency_key:
            raise
        expired_draft = _read_voice_draft(token, allow_expired=True)
        existing = _existing_voice_send(expired_draft, idempotency_key)
        if existing is None:
            raise
        return expired_draft, existing


def _submit_voice_tutor_request(draft: dict[str, Any], idempotency_key: str) -> dict[str, Any]:
    if not re.fullmatch(r"[A-Za-z0-9._:-]{16,128}", idempotency_key):
        raise HTTPException(status_code=400, detail="Send a valid Idempotency-Key (16 to 128 safe characters).")
    secret = _voice_secret()
    canonical = json.dumps(draft, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    request_hash = hashlib.sha256(canonical.encode()).hexdigest()
    key_hash = hashlib.sha256(idempotency_key.encode()).hexdigest()
    with connect() as db:
        db.execute("BEGIN IMMEDIATE")
        existing = db.execute("SELECT * FROM voice_action_idempotency WHERE idempotency_key_hash=?", (key_hash,)).fetchone()
        if existing:
            if not hmac.compare_digest(existing["request_hash"], request_hash):
                raise HTTPException(status_code=409, detail="This idempotency key was already used for a different request.")
            ticket_id = existing["ticket_id"]
        else:
            ticket_id = str(uuid4())
            access_token = hmac.new(secret, f"voice-ticket:{ticket_id}:{key_hash}".encode(), hashlib.sha256).hexdigest()
            access_hash = hashlib.sha256(access_token.encode()).hexdigest()
            save_escalation_record(
                draft["conversation"], draft["language"], draft["page"], "Voice tutor request",
                ticket_type=draft.get("type", "person"), job_id=draft.get("jobId"),
                accommodation=draft.get("accommodation"),
                access_token_hash=access_hash, handoff_reason="learner_requested_person", db=db, ticket_id=ticket_id,
            )
            db.execute(
                "INSERT INTO voice_action_idempotency(idempotency_key_hash,request_hash,ticket_id,created_at) VALUES(?,?,?,?)",
                (key_hash, request_hash, ticket_id, datetime.now(timezone.utc).isoformat()),
            )
        access_token = hmac.new(secret, f"voice-ticket:{ticket_id}:{key_hash}".encode(), hashlib.sha256).hexdigest()
    return {"ticketId": ticket_id, "accessToken": access_token, "message": "Your tutor request was sent."}


@app.get("/api/v1/voice/guide")
def get_voice_guide(language: str = Query(default="en")) -> dict[str, Any]:
    return voice_guide(language)


@app.get("/api/v1/voice/capabilities")
def get_voice_capabilities() -> dict[str, Any]:
    return {**voice_capabilities(), "offlineMode": offline_mode()}


@app.get("/api/v1/voice/guide/audio")
async def get_voice_guide_audio(language: str = Query(default="en")) -> Response:
    guide = voice_guide(language)
    audio = await run_in_threadpool(local_provider().synthesize, guide["speakText"], language)
    return Response(audio, media_type="audio/wav", headers={"Cache-Control": "no-store"})


async def _voice_command(payload: dict[str, Any], idempotency_key: str | None = None) -> dict[str, Any]:
    allowed_fields = {"transcript", "language", "confidence", "shareConsent", "conversation", "page", "draftToken",
                      "ticketId", "ticketAccessToken", "jobId", "accommodation", "idempotencyKey", "expiresAt", "id"}
    if set(payload) - allowed_fields:
        plain_bad("Voice command contains unsupported fields.", payload.get("language", "en"), "error_voice_unsupported_fields")
    language = payload.get("language", "en")
    if language not in VOICE_LANGUAGES:
        plain_bad("Language must be en, am, om, ti, so, or ar.")
    transcript = payload.get("transcript")
    confidence = payload.get("confidence", 1.0)
    if not isinstance(transcript, str) or not transcript.strip() or len(transcript) > 4000:
        plain_bad("Provide a transcript of 1 to 4000 characters.", language, "error_voice_transcript")
    if not isinstance(confidence, (int, float)) or confidence < 0 or confidence > 1:
        plain_bad("Confidence must be between 0 and 1.", language, "error_voice_confidence")
    if confidence < 0.45:
        return {"status": "clarification_required", "transcript": transcript.strip(), "language": language,
                "action": "clarify", "answerText": api_message(language, "voice_low_confidence",
                    "I could not understand that clearly. Please repeat or edit the request.")}
    classified = classify_command(transcript, language)
    action = classified["action"]
    result: dict[str, Any] = {"status": "processed", "transcript": transcript.strip(), "language": language,
                              "detectedLanguage": language,
                              "action": action, "answerText": ""}
    if action == "get_guide":
        guide = voice_guide(language)
        return {**result, "answerText": guide["text"], "guide": guide}
    if action == "client_action_required":
        return {**result, "status": "client_action_required", "clientAction": classified["clientAction"],
                "answerText": api_message(language, "voice_screen_share",
                    "Screen sharing must be started and approved in your browser.")}
    if action == "external_service_required":
        return {**result, "status": "unavailable_offline", "answerText": api_message(language, "voice_alerts_offline",
            "Alerts need an external messaging service and are unavailable in offline mode.")}
    if action == "check_tutor_reply":
        ticket_id, token = payload.get("ticketId"), payload.get("ticketAccessToken")
        if not isinstance(ticket_id, str) or not isinstance(token, str):
            return {**result, "status": "clarification_required", "answerText": api_message(language, "voice_ticket_credentials",
                "Provide the tutor ticket and its learner access token to check status.")}
        try:
            ticket = get_escalation(ticket_id, token)
        except HTTPException:
            return {**result, "status": "not_found", "answerText": api_message(language, "voice_ticket_not_found",
                "I could not find that tutor request.")}
        status_text = api_message(language, "voice_ticket_status", "Tutor request status")
        reply_text = api_message(language, "voice_tutor_reply", "Tutor reply")
        return {**result, "answerText": f"{status_text}: {ticket['status']}." + (f" {reply_text}: {ticket['reply']}" if ticket.get("reply") else ""),
                "ticket": ticket}
    if action in {"request_tutor", "request_accommodation"}:
        if payload.get("shareConsent") is not True:
            return {**result, "status": "consent_required", "answerText": api_message(language, "voice_consent",
                "Please explicitly consent to share this conversation with a tutor.")}
        conversation = payload.get("conversation", [])
        if not isinstance(conversation, list) or len(conversation) > 20:
            plain_bad("Conversation must contain up to 20 messages.", language, "error_voice_conversation")
        if any(not isinstance(m, dict) or m.get("role") not in {"user", "assistant"} or not isinstance(m.get("text"), str) or len(m["text"]) > 4000 for m in conversation):
            plain_bad("Conversation messages must have a user/assistant role and short text.",
                language, "error_voice_conversation_messages")
        page = payload.get("page", "/")
        if not isinstance(page, str) or len(page) > 2048 or not page:
            plain_bad("Page must be a short non-empty string.", language, "error_voice_page")
        page = _handoff_page(page)
        ticket_type = "person"
        job_id = accommodation = None
        if action == "request_accommodation":
            job_id, accommodation = payload.get("jobId"), payload.get("accommodation")
            if not isinstance(job_id, str) or not job_id.strip() or not isinstance(accommodation, str) or not accommodation.strip():
                return {**result, "status": "clarification_required", "answerText": api_message(language, "voice_accommodation_details",
                    "Choose the job and describe the accommodation before preparing the request.")}
            ticket_type = "accommodation"
        if not conversation or conversation[-1].get("text") != classified["query"]:
            conversation = [*conversation, {"role": "user", "text": classified["query"]}]
        draft = {"conversation": conversation, "language": language, "page": page, "consent": True,
                 "expiresAt": int(time.time()) + 300, "type": ticket_type, "jobId": job_id,
                 "accommodation": accommodation}
        if classified["confirmed"]:
            token = payload.get("draftToken")
            if not isinstance(token, str):
                return {**result, "status": "clarification_required", "answerText": api_message(language, "voice_draft_required",
                    "Prepare and review this tutor request before saying ‘send it’.")}
            prepared, prior_send = _read_confirmed_draft(token, idempotency_key)
            if any(prepared.get(key) != draft.get(key) for key in ("conversation", "language", "page", "consent", "type", "jobId", "accommodation")):
                return {**result, "status": "draft_changed", "answerText": api_message(language, "voice_draft_changed",
                    "This is not the reviewed tutor request. Prepare and confirm it again.")}
            if not idempotency_key:
                raise HTTPException(status_code=400, detail="Spoken send requires an Idempotency-Key.")
            sent = prior_send or _submit_voice_tutor_request(prepared, idempotency_key)
            return {**result, "action": "send_tutor_request", "status": "sent", "confirmed": True,
                    "answerText": api_message(language, "voice_request_sent", sent["message"]), "ticket": sent}
        return {**result, "status": "draft", "draft": {"conversation": conversation, "language": language,
                                                               "page": page, "type": ticket_type,
                                                               "jobId": job_id, "accommodation": accommodation},
                "draftToken": _voice_draft_token(draft), "answerText": api_message(language, "voice_review_draft",
                    "Review this tutor request, then say ‘send it’ to submit.")}
    if classified["confirmed"]:
        token = payload.get("draftToken")
        if not isinstance(token, str):
            return {**result, "status": "clarification_required", "answerText": api_message(language, "voice_draft_missing",
                "There is no prepared request to send.")}
        if payload.get("shareConsent") is not True:
            return {**result, "status": "consent_required", "answerText": api_message(language, "voice_consent_required",
                "Explicit consent is required before sharing with a tutor.")}
        draft, prior_send = _read_confirmed_draft(token, idempotency_key)
        if draft.get("consent") is not True:
            return {**result, "status": "consent_required", "answerText": api_message(language, "voice_consent_required",
                "Explicit consent is required before sharing with a tutor.")}
        if payload.get("conversation") is not None and payload["conversation"] != draft["conversation"]:
            return {**result, "status": "draft_changed", "answerText": api_message(language, "voice_draft_changed",
                "The request changed after review. Prepare and confirm it again.")}
        for key in ("page", "language", "jobId", "accommodation"):
            if key in payload and payload[key] != draft.get(key):
                return {**result, "status": "draft_changed", "answerText": api_message(language, "voice_draft_changed",
                    "The request details changed after review. Prepare and confirm it again.")}
        if not idempotency_key:
            raise HTTPException(status_code=400, detail="Spoken send requires an Idempotency-Key.")
        sent = prior_send or _submit_voice_tutor_request(draft, idempotency_key)
        return {**result, "action": "send_tutor_request", "status": "sent", "confirmed": True,
                "answerText": api_message(language, "voice_request_sent", sent["message"]), "ticket": sent}
    query = classified["query"]
    if len(query.strip()) < 3:
        return {**result, "status": "clarification_required", "answerText": api_message(language, "voice_question_too_short",
            "Please repeat the lesson or job question.")}
    answer = await answer_question(query, language, indexed_sections(), allow_cloud=False, offline_only=True)
    return {**result, "answerText": answer["answer"], "sources": answer["sources"], "grounding": answer["grounding"]}


@app.post("/api/v1/voice/commands")
async def post_voice_command(request: Request, idempotency_key: str | None = Header(default=None, alias="Idempotency-Key")) -> dict[str, Any]:
    content_type = request.headers.get("content-type", "")
    if content_type.startswith("application/json"):
        content_length = request.headers.get("content-length")
        if content_length and content_length.isdigit() and int(content_length) > 12_000_000:
            plain_bad("Voice command JSON must be smaller than 12 MB.")
        try:
            payload = await request.json()
        except Exception:
            plain_bad("Send valid JSON.")
        if not isinstance(payload, dict):
            plain_bad("Send a JSON object.")
        if "audioDataUrl" in payload:
            audio = _decode_voice_audio(payload.get("audioDataUrl"), payload.get("audioMimeType"))
            language = payload.get("language", "en")
            if language not in VOICE_LANGUAGES:
                plain_bad("Language must be en, am, om, ti, so, or ar.")
            recognized = await run_in_threadpool(local_provider().transcribe, audio, language)
            payload = {key: value for key, value in payload.items() if key not in {"audioDataUrl", "audioMimeType"}}
            payload.update(recognized)
        return await _voice_command(payload, idempotency_key)
    if content_type.startswith("audio/"):
        content_length = request.headers.get("content-length")
        if content_length and content_length.isdigit() and int(content_length) > 8_000_000:
            plain_bad("Audio must be between 1 byte and 8 MB.")
        chunks = bytearray()
        async for chunk in request.stream():
            chunks.extend(chunk)
            if len(chunks) > 8_000_000:
                plain_bad("Audio must be between 1 byte and 8 MB.")
        audio = bytes(chunks)
        if not audio:
            plain_bad("Audio must be between 1 byte and 8 MB.")
        language = request.query_params.get("language", "en")
        if language not in VOICE_LANGUAGES:
            plain_bad("Language must be en, am, om, ti, so, or ar.")
        if request.query_params.get("cloudConsent") == "true":
            return {"status": "cloud_disabled", "action": "transcribe", "answerText": api_message(language,
                "voice_cloud_disabled", "Cloud speech processing is disabled in offline-only mode.")}
        recognized = await run_in_threadpool(local_provider().transcribe, audio, language)
        return await _voice_command({"transcript": recognized["transcript"], "confidence": recognized["confidence"], "language": language}, idempotency_key)
    raise HTTPException(status_code=415, detail="Send JSON transcript input or an audio/* recording.")


def _voice_channel_language(value: Any, default: str = "am") -> str:
    """Normalize provider locale values such as ``am-ET`` to our locale IDs."""
    candidate = value if isinstance(value, str) and value.strip() else default
    language = candidate.strip().lower().replace("_", "-").split("-", 1)[0]
    if language not in VOICE_LANGUAGES:
        plain_bad("Language must be en, am, om, ti, so, or ar.")
    return language


async def _read_voice_note(request: Request, language: str) -> tuple[bytes, str, str]:
    """Read a provider voice note without requiring python-multipart."""
    content_type = request.headers.get("content-type", "").lower()
    if content_type.startswith("application/json"):
        content_length = request.headers.get("content-length")
        if content_length and content_length.isdigit() and int(content_length) > 12_000_000:
            plain_bad("Voice note JSON must be smaller than 12 MB.")
        try:
            payload = await request.json()
        except Exception:
            plain_bad("Send valid JSON.")
        if not isinstance(payload, dict):
            plain_bad("Send a JSON object.")
        language = _voice_channel_language(payload.get("language"), language)
        mime_type = payload.get("audioMimeType", "audio/webm")
        return _decode_voice_audio(payload.get("audioDataUrl"), mime_type), mime_type, language

    if content_type.startswith("audio/"):
        if len(content_type) > 80 or ";" in content_type:
            mime_type = content_type.split(";", 1)[0].strip()
        else:
            mime_type = content_type
        if mime_type not in {"audio/webm", "audio/ogg", "audio/opus", "audio/wav", "audio/mpeg", "audio/mp4"}:
            raise HTTPException(status_code=415, detail="Send a supported audio recording.")
        content_length = request.headers.get("content-length")
        if content_length and content_length.isdigit() and int(content_length) > 8_000_000:
            plain_bad("Audio must be between 1 byte and 8 MB.")
        chunks = bytearray()
        async for chunk in request.stream():
            chunks.extend(chunk)
            if len(chunks) > 8_000_000:
                plain_bad("Audio must be between 1 byte and 8 MB.")
        if not chunks:
            plain_bad("Audio must be between 1 byte and 8 MB.")
        return bytes(chunks), mime_type, _voice_channel_language(request.query_params.get("language"), language)

    raise HTTPException(status_code=415, detail="Send JSON audioDataUrl or an audio/* voice note.")


async def _answer_voice_channel(
    transcript: str,
    language: str,
    *,
    confidence: Any = None,
    channel: str,
) -> dict[str, Any]:
    """Answer a voice note using the same retrieval and handoff path as web/SMS."""
    if not isinstance(transcript, str) or not transcript.strip() or len(transcript) > 4000:
        plain_bad("Provide a transcript of 1 to 4000 characters.", language, "error_voice_transcript")
    transcript = transcript.strip()
    if confidence is not None:
        try:
            confidence = float(confidence)
        except (TypeError, ValueError):
            plain_bad("Confidence must be between 0 and 1.", language, "error_voice_confidence")
        if not 0 <= confidence <= 1:
            plain_bad("Confidence must be between 0 and 1.", language, "error_voice_confidence")
        if confidence < 0.35:
            spoken = api_message(language, "voice_low_confidence", "I could not understand that clearly. Please repeat it.")
            return {
                "channel": channel,
                "language": language,
                "transcript": transcript,
                "confidence": confidence,
                "status": "clarification_required",
                "answerText": spoken,
                "answer": spoken,
                "answerStatus": "clarification_required",
                "sources": [],
                "audio": await _synthesize_voice_response(spoken, language),
            }

    sections = indexed_sections()
    result = await answer_question(transcript, language, sections, allow_cloud=False, offline_only=offline_mode())
    record_course_gap_analytics(transcript, language, sections, result)
    answer_text = str(result.get("answer") or "").strip()
    if result.get("answerStatus") in {"not_found", "off_topic", "refused"}:
        handoff = api_message(language, "sms_person_instruction", "To ask a tutor, say PERSON.")
        if handoff and handoff not in answer_text:
            answer_text = f"{answer_text} {handoff}".strip()
    return {
        "channel": channel,
        "language": language,
        "transcript": transcript,
        "confidence": confidence,
        "status": result.get("answerStatus", "answered"),
        "answerText": answer_text,
        "audio": await _synthesize_voice_response(answer_text, language),
        **result,
    }


async def _synthesize_voice_response(text: str, language: str) -> dict[str, str] | None:
    """Return an inline WAV when a local TTS model is configured; keep text usable otherwise."""
    try:
        audio = await run_in_threadpool(local_provider().synthesize, text[:4000], language)
    except Exception as error:  # TTS is optional; transcription and text answers remain usable.
        logger.info("Voice read-back unavailable for %s: %s", language, type(error).__name__)
        return None
    if not isinstance(audio, bytes) or not audio:
        return None
    return {
        "mimeType": "audio/wav",
        "dataUrl": "data:audio/wav;base64," + base64.b64encode(audio).decode("ascii"),
    }


@app.post("/api/v1/voice/notes")
async def post_voice_note(request: Request) -> dict[str, Any]:
    """Transcribe an Amharic voice note, answer it, and optionally return a read-back WAV."""
    audio, _mime_type, language = await _read_voice_note(request, "am")
    recognized = await run_in_threadpool(local_provider().transcribe, audio, language)
    if not isinstance(recognized, dict):
        raise HTTPException(status_code=503, detail="The local speech engine returned no transcription.")
    return await _answer_voice_channel(
        recognized.get("transcript", ""),
        language,
        confidence=recognized.get("confidence"),
        channel="voice-note",
    )


def _voice_call_locale(language: str) -> str:
    return os.getenv(f"VOICE_CALL_LOCALE_{language.upper()}", {"am": "am-ET"}.get(language, f"{language}-{language.upper()}"))


def _voice_call_say(text: str, language: str) -> str:
    locale = html.escape(_voice_call_locale(language), quote=True)
    voice = os.getenv(f"VOICE_CALL_VOICE_{language.upper()}", "").strip()
    voice_attribute = f' voice="{html.escape(voice, quote=True)}"' if voice else ""
    return f'<Say language="{locale}"{voice_attribute}>{html.escape(text[:3500])}</Say>'


def _voice_call_gather(language: str, prompt: str) -> str:
    action_url = os.getenv("VOICE_CALL_ANSWER_URL", "").strip()
    if action_url:
        parsed_action = urllib.parse.urlsplit(action_url)
        if (
            parsed_action.scheme != "https"
            or not parsed_action.netloc
            or parsed_action.fragment
            or parsed_action.username
            or parsed_action.password
        ):
            raise HTTPException(
                status_code=503,
                detail="VOICE_CALL_ANSWER_URL must be an absolute HTTPS URL.",
            )
    if not action_url:
        public_base = os.getenv("TWILIO_WEBHOOK_BASE_URL", "").strip().rstrip("/")
        action_url = f"{public_base}/voice/answer" if public_base else "/voice/answer"
    action = html.escape(action_url, quote=True)
    return (
        f'<Gather input="speech" action="{action}" method="POST" '
        f'language="{html.escape(_voice_call_locale(language), quote=True)}" speechTimeout="auto">'
        f"{_voice_call_say(prompt, language)}</Gather>"
    )


def _voice_call_response(body: str) -> Response:
    return Response(content=f'<?xml version="1.0" encoding="UTF-8"?><Response>{body}</Response>', media_type="application/xml")


async def _read_voice_call_fields(request: Request) -> dict[str, str]:
    content_type = request.headers.get("content-type", "").lower()
    if content_type.startswith("application/x-www-form-urlencoded") or content_type.startswith("multipart/form-data"):
        form = await request.form()
        _validate_twilio_webhook(request, form)
        return {str(key): str(value) for key, value in form.items()}
    if content_type.startswith("application/json"):
        if twilio_webhooks_enabled():
            raise HTTPException(status_code=415, detail="Live Twilio voice callbacks must use form encoding.")
        raw = await request.body()
        try:
            payload = json.loads(raw.decode("utf-8")) if raw else {}
        except (UnicodeDecodeError, ValueError):
            plain_bad("Send valid voice-call data.")
        return {str(key): str(value) for key, value in payload.items()} if isinstance(payload, dict) else {}
    if twilio_webhooks_enabled():
        raise HTTPException(status_code=415, detail="Live Twilio voice callbacks must use form encoding.")
    raw = await request.body()
    values = urllib.parse.parse_qs(raw.decode("utf-8", errors="replace"), keep_blank_values=True)
    return {key: entries[-1] for key, entries in values.items() if entries}


def _save_voice_call_handoff(transcript: str, language: str, caller: str) -> tuple[str, str]:
    caller_hash = hash_phone(caller) or hashlib.sha256(b"anonymous-voice-caller").hexdigest()
    conversation = [{"role": "user", "text": transcript}]
    ticket_id = save_escalation_record(
        conversation,
        language,
        f"voice-call:{caller_hash}",
        "Voice call tutor request",
        handoff_reason="learner_requested_person",
    )
    notify_webhook(ticket_id)
    return ticket_id, ticket_id.replace("-", "")[-8:].upper()


@app.post("/voice/inbound", response_class=Response)
@app.post("/api/v1/voice/call/inbound", response_class=Response)
async def voice_call_inbound(request: Request) -> Response:
    """Provider-neutral/TwiML-compatible entry point for a spoken course question."""
    content_type = request.headers.get("content-type", "").lower()
    if content_type.startswith("application/x-www-form-urlencoded") or content_type.startswith("multipart/form-data"):
        form = await request.form()
        _validate_twilio_webhook(request, form)
    elif twilio_webhooks_enabled():
        raise HTTPException(status_code=415, detail="Live Twilio voice callbacks must use form encoding.")
    language = _voice_channel_language(os.getenv("VOICE_CALL_LANGUAGE", "en"))
    prompt = api_message(language, "voice_call_prompt", "Please ask your course question.")
    return _voice_call_response(_voice_call_gather(language, prompt))


@app.post("/voice/answer", response_class=Response)
@app.post("/api/v1/voice/call/answer", response_class=Response)
async def voice_call_answer(request: Request) -> Response:
    fields = await _read_voice_call_fields(request)
    language = _voice_channel_language(fields.get("Language") or fields.get("language"), os.getenv("VOICE_CALL_LANGUAGE", "en"))
    transcript = fields.get("SpeechResult") or fields.get("speechResult") or fields.get("transcript") or ""
    confidence = fields.get("Confidence") or fields.get("confidence")
    if confidence:
        try:
            if float(confidence) < 0.35:
                return _voice_call_response(_voice_call_gather(
                    language,
                    api_message(language, "voice_low_confidence", "I could not understand that clearly. Please repeat it."),
                ))
        except ValueError:
            confidence = None
    if not transcript.strip():
        return _voice_call_response(_voice_call_gather(
            language,
            api_message(language, "voice_call_repeat", "I did not hear a question. Please try again."),
        ))

    command = classify_command(transcript, language)
    if command["action"] == "request_tutor":
        _ticket_id, reference = _save_voice_call_handoff(transcript, language, fields.get("From", ""))
        message = api_message(language, "voice_call_handoff", "Your tutor request is queued.")
        message = f"{message} Reference {reference}."
        return _voice_call_response(_voice_call_say(message, language))

    result = await _answer_voice_channel(transcript, language, confidence=confidence, channel="voice-call")
    follow_up = _voice_call_gather(language, api_message(language, "voice_call_next", "You can ask another course question."))
    return _voice_call_response(_voice_call_say(result["answerText"], language) + follow_up)


@app.post("/api/v1/voice/actions/sync")
async def sync_voice_actions(payload: dict[str, Any]) -> dict[str, Any]:
    actions = payload.get("actions")
    if not isinstance(actions, list) or len(actions) > 50:
        plain_bad("Send up to 50 queued voice actions.")
    results = []
    for item in actions:
        if not isinstance(item, dict):
            results.append({"status": "invalid"})
            continue
        expires_at = item.get("expiresAt")
        if not isinstance(expires_at, int) or expires_at < int(time.time()):
            results.append({"id": item.get("id"), "status": "expired", "executed": False})
            continue
        try:
            action = item
            if "audioDataUrl" in item:
                audio = _decode_voice_audio(item.get("audioDataUrl"), item.get("audioMimeType"))
                language = item.get("language", "en")
                if language not in VOICE_LANGUAGES:
                    plain_bad("Language must be en, am, om, ti, so, or ar.")
                recognized = await run_in_threadpool(local_provider().transcribe, audio, language)
                action = {key: value for key, value in item.items() if key not in {"audioDataUrl", "audioMimeType"}}
                action.update(recognized)
            result = await _voice_command(action, item.get("idempotencyKey"))
            results.append({"id": item.get("id"), **result})
        except HTTPException as exc:
            results.append({"id": item.get("id"), "status": "rejected", "executed": False, "reason": exc.detail})
    return {"results": results}


@app.post("/api/v1/ask")
async def ask(payload: dict[str, Any]) -> dict[str, Any]:
    question, language = payload.get("question"), payload.get("language", "en")
    if not isinstance(question, str) or not question.strip() or len(question) > 4000:
        error_language = language if isinstance(language, str) and language in SUPPORTED_LANGUAGES else "en"
        plain_bad("Write a question of 1 to 4000 characters.", error_language, "error_question")
    if not isinstance(language, str) or language not in SUPPORTED_LANGUAGES:
        plain_bad("Language must be en, am, om, ti, so, or ar.", "en", "error_language")
    sections = indexed_sections()
    result = await answer_question(
        question.strip(),
        language,
        sections,
        allow_cloud=payload.get("externalAiConsent") is True,
        offline_only=offline_mode(),
    )
    record_course_gap_analytics(question.strip(), language, sections, result)
    return result


def record_course_gap_analytics(
    question: str, language: str, sections: list[dict[str, Any]], result: dict[str, Any]
) -> None:
    """Increment anonymous daily counters; never persist the learner's prompt or identity."""
    if language not in TRACK_GAP_LANGUAGES:
        return
    outcome = result.get("answerStatus")
    if outcome not in GAP_OUTCOMES:
        return

    topic_id = GAP_NO_TOPIC
    if outcome == "answered":
        sources = result.get("sources")
        source_url = sources[0].get("url") if isinstance(sources, list) and sources and isinstance(sources[0], dict) else None
        source_type = sources[0].get("type", "lesson") if isinstance(sources, list) and sources and isinstance(sources[0], dict) else None
        if source_type == "job":
            topic_id = GAP_NON_LESSON
        elif isinstance(source_url, str):
            matched = next((section for section in sections if section.get("type", "lesson") == "lesson" and section.get("url") == source_url), None)
            if matched and isinstance(matched.get("id"), str):
                topic_id = matched["id"]
    elif outcome == "not_found":
        # This is only an unverified nearest lesson candidate for gap analysis.
        # It does not alter retrieval, answer thresholds, or citations.
        ranked = retrieve(question, sections, language)
        if ranked:
            score, candidate = ranked[0]
            if score > 0 and candidate.get("type", "lesson") == "lesson" and isinstance(candidate.get("id"), str):
                topic_id = candidate["id"]

    retention_days = 90
    try:
        retention_days = max(0, int(os.getenv("COURSE_GAP_RETENTION_DAYS", "90")))
    except ValueError:
        pass
    if retention_days == 0:
        try:
            with connect() as db:
                db.execute("DELETE FROM course_gap_aggregates")
        except sqlite3.Error:
            logger.warning("Course gap aggregate cleanup failed")
        return

    today = datetime.now(timezone.utc).date()
    day_bucket = today.isoformat()
    cutoff = (today - timedelta(days=retention_days)).isoformat()
    try:
        with connect() as db:
            db.execute("DELETE FROM course_gap_aggregates WHERE day_bucket < ?", (cutoff,))
            db.execute(
                "INSERT INTO course_gap_aggregates(day_bucket,language,topic_id,outcome,count) "
                "VALUES(?,?,?,?,1) ON CONFLICT(day_bucket,language,topic_id,outcome) "
                "DO UPDATE SET count=count+1",
                (day_bucket, language, topic_id, outcome),
            )
    except sqlite3.Error:
        # Analytics are best-effort and must never interrupt a learner answer.
        logger.warning("Course gap aggregate update failed")


def _report_count(value: int) -> dict[str, Any]:
    return {"count": value if value == 0 or value >= GAP_REPORT_MINIMUM else None,
            "suppressed": 0 < value < GAP_REPORT_MINIMUM}


@app.get("/api/v1/helper/course-gap-radar")
def helper_course_gap_radar(x_helper_token: str | None = Header(default=None)) -> dict[str, Any]:
    """Return helper-only aggregates; small language/topic groups are suppressed."""
    helper_auth(x_helper_token)
    today = datetime.now(timezone.utc).date()
    cutoff = (today - timedelta(days=29)).isoformat()
    retention_days = 90
    try:
        retention_days = max(0, int(os.getenv("COURSE_GAP_RETENTION_DAYS", "90")))
    except ValueError:
        pass
    if retention_days == 0:
        with connect() as db:
            db.execute("DELETE FROM course_gap_aggregates")
        return {
            "period": "last_30_days", "retentionDays": 0, "minimumVisibleCount": GAP_REPORT_MINIMUM,
            "hasActivity": False, "byLanguage": [], "mostAskedQuestions": [], "unansweredQuestions": [],
            "topAnsweredTopics": [], "notFoundCandidates": [],
            "message": "Course gap analytics are disabled by COURSE_GAP_RETENTION_DAYS=0.",
        }

    with connect() as db:
        db.execute(
            "DELETE FROM course_gap_aggregates WHERE day_bucket < ?",
            ((today - timedelta(days=retention_days)).isoformat(),),
        )
        rows = db.execute(
            "SELECT language,topic_id,outcome,SUM(count) AS count FROM course_gap_aggregates "
            "WHERE day_bucket >= ? GROUP BY language,topic_id,outcome",
            (cutoff,),
        ).fetchall()
        content_rows = db.execute("SELECT section_json FROM content_sections ORDER BY id").fetchall()

    section_titles: dict[str, str] = {}
    for row in content_rows:
        try:
            section = json.loads(row["section_json"])
        except (TypeError, ValueError):
            continue
        if isinstance(section, dict) and section.get("type", "lesson") == "lesson" and isinstance(section.get("id"), str):
            titles = section.get("titles") if isinstance(section.get("titles"), dict) else {}
            section_titles[section["id"]] = str(titles.get("en") or section.get("title") or section["id"])

    by_language: dict[str, dict[str, int]] = {language: {status: 0 for status in GAP_OUTCOMES} for language in TRACK_GAP_LANGUAGES}
    asked_topics: dict[str, int] = defaultdict(int)
    asked_answered: dict[str, int] = defaultdict(int)
    asked_not_found: dict[str, int] = defaultdict(int)
    answered_topics: dict[str, int] = defaultdict(int)
    not_found_candidates: dict[str, int] = defaultdict(int)
    for row in rows:
        language, topic_id, outcome, count = row["language"], row["topic_id"], row["outcome"], int(row["count"])
        if language not in by_language or outcome not in GAP_OUTCOMES:
            continue
        by_language[language][outcome] += count
        if topic_id not in {GAP_NO_TOPIC, GAP_NON_LESSON} and outcome in {"answered", "not_found"}:
            asked_topics[topic_id] += count
            if outcome == "answered":
                asked_answered[topic_id] += count
            else:
                asked_not_found[topic_id] += count
        if outcome == "answered" and topic_id not in {GAP_NO_TOPIC, GAP_NON_LESSON}:
            answered_topics[topic_id] += count
        if outcome == "not_found" and topic_id not in {GAP_NO_TOPIC, GAP_NON_LESSON}:
            not_found_candidates[topic_id] += count

    outcome_totals = []
    language_names = {"en": "English", "am": "አማርኛ", "ti": "ትግርኛ", "om": "Afaan Oromoo", "so": "Soomaali"}
    for language in TRACK_GAP_LANGUAGES:
        values = by_language[language]
        total = sum(values.values())
        outcome_totals.append({
            "language": language,
            "languageName": language_names[language],
            "total": _report_count(total),
            "outcomes": {status: _report_count(values[status]) for status in GAP_OUTCOMES},
        })

    def topic_rows(counts: dict[str, int], *, candidate_only: bool = False) -> list[dict[str, Any]]:
        return [
            {"topicId": topic_id, "title": section_titles.get(topic_id, topic_id), "count": count,
             **({"candidateOnly": True} if candidate_only else {})}
            for topic_id, count in sorted(counts.items(), key=lambda item: (-item[1], item[0]))
            if count >= GAP_REPORT_MINIMUM
        ][:10]

    most_asked = [
        {
            "topicId": topic_id,
            "title": section_titles.get(topic_id, topic_id),
            "count": count,
            "answered": asked_answered.get(topic_id, 0),
            "notFound": asked_not_found.get(topic_id, 0),
        }
        for topic_id, count in sorted(asked_topics.items(), key=lambda item: (-item[1], item[0]))
        if count >= GAP_REPORT_MINIMUM
    ][:10]
    unanswered = topic_rows(not_found_candidates, candidate_only=True)
    unmatched = sum(
        int(row["count"]) for row in rows
        if row["outcome"] == "not_found" and row["topic_id"] == GAP_NO_TOPIC
    )
    if unmatched >= GAP_REPORT_MINIMUM:
        unanswered.append({
            "topicId": GAP_NO_TOPIC,
            "title": "No matching course area",
            "count": unmatched,
            "candidateOnly": True,
        })

    return {
        "period": "last_30_days",
        "retentionDays": retention_days,
        "minimumVisibleCount": GAP_REPORT_MINIMUM,
        "hasActivity": bool(rows),
        "byLanguage": outcome_totals,
        "mostAskedQuestions": most_asked,
        "unansweredQuestions": unanswered[:10],
        "topAnsweredTopics": topic_rows(answered_topics),
        "notFoundCandidates": topic_rows(not_found_candidates, candidate_only=True),
        "unmatchedNotFoundCount": _report_count(unmatched),
    }


@app.post("/api/v1/answer-feedback", status_code=201)
def create_answer_feedback(payload: dict[str, Any]) -> dict[str, str]:
    kind, reason, source_url = payload.get("kind"), payload.get("reason"), payload.get("sourceUrl", "")
    if kind not in {"answer", "source"}:
        plain_bad("Feedback kind must be answer or source.")
    if reason not in {"unhelpful", "incorrect"}:
        plain_bad("Feedback reason must be unhelpful or incorrect.")
    if not isinstance(source_url, str) or len(source_url) > 2000:
        plain_bad("Source URL must be 2000 characters or fewer.")
    feedback_id = str(uuid4())
    with connect() as db:
        db.execute("INSERT INTO answer_feedback(id,kind,reason,source_url,created_at) VALUES(?,?,?,?,?)",
                   (feedback_id, kind, reason, source_url, datetime.now(timezone.utc).isoformat()))
    return {"feedbackId": feedback_id, "message": "Feedback received."}


@app.get("/api/v1/answer-feedback")
def list_answer_feedback(x_helper_token: str | None = Header(default=None)) -> list[dict[str, Any]]:
    helper_auth(x_helper_token)
    with connect() as db:
        rows = db.execute("SELECT id,kind,reason,source_url,created_at,reviewed FROM answer_feedback ORDER BY created_at DESC LIMIT 500").fetchall()
    return [dict(row) for row in rows]


@app.post("/api/v1/answer-feedback/{feedback_id}/reviewed")
def mark_answer_feedback_reviewed(feedback_id: str, x_helper_token: str | None = Header(default=None)) -> dict[str, str]:
    helper_auth(x_helper_token)
    with connect() as db:
        cursor = db.execute("UPDATE answer_feedback SET reviewed=1 WHERE id=?", (feedback_id,))
    if not cursor.rowcount:
        raise HTTPException(status_code=404, detail="Feedback was not found.")
    return {"message": "Feedback marked reviewed."}


@app.get("/api/v1/config")
def assistant_config() -> dict[str, bool]:
    return {
        "externalAiConsentRequired": os.getenv("AI_PROVIDER", "none").strip().lower() == "cloud"
    }


@app.post("/api/v1/jobs/notify")
def notify_job(payload: dict[str, Any], x_helper_token: str | None = Header(default=None)) -> dict[str, Any]:
    helper_auth(x_helper_token)
    job = payload.get("job", payload)
    if not isinstance(job, dict):
        plain_bad("Send one job object.")
    for field in ("id", "title", "location", "url", "description"):
        if not isinstance(job.get(field), str) or not job[field].strip():
            plain_bad(f"Job needs a {field}.")
    if not isinstance(job.get("remote"), bool):
        plain_bad("Job remote must be true or false.")
    if offline_mode():
        return {"telegram": {"sent": 0, "failed": 0, "skipped": 1}, "sms": {"sent": 0, "failed": 0, "skipped": 1}}
    message = f"New: {job['title']} | {'Remote' if job['remote'] else 'On site'} | {job['location']}"
    try:
        from . import telegram_bot
        telegram = telegram_bot.notify_job_subscribers(job)
    except Exception:
        telegram = {"sent": 0, "failed": 1}
    sms = send_sms_job_alerts(message, source_url=job["url"])
    return {"telegram": telegram, "sms": sms}


def _sms_webhook_response(
    text: str,
    status_code: int = 200,
    background: BackgroundTasks | None = None,
) -> Response:
    body = html.escape(text, quote=False)
    return Response(
        content=f'<?xml version="1.0" encoding="UTF-8"?><Response><Message>{body}</Message></Response>',
        status_code=status_code,
        media_type="application/xml",
        background=background,
    )


async def _process_sms_payload(payload: dict[str, Any], background: BackgroundTasks) -> PlainTextResponse:
    if not isinstance(payload, dict):
        return PlainTextResponse(api_message("en", "sms_invalid_object"), status_code=400)

    from_number = str(payload.get("from") or "").strip()
    normalized_phone = normalize_ethiopian_phone(from_number)
    stored_phone = normalized_phone or from_number
    phone_hash = hash_phone(stored_phone) if stored_phone else ""
    preferred_language = get_sms_language(phone_hash)
    raw_text = payload.get("text")
    if not isinstance(raw_text, str) or not raw_text.strip():
        return PlainTextResponse(
            api_message(preferred_language, "sms_empty_text"), status_code=400
        )

    text = raw_text.strip()
    lang = detect_language(text, preferred_language)
    cmd = text.upper()

    if cmd in {"HELP", "?"}:
        return PlainTextResponse(api_message(lang, "sms_help"), media_type="text/plain")

    if cmd in {"LANG", "LANGUAGE"}:
        return PlainTextResponse(
            api_message(lang, "sms_language_instructions"), media_type="text/plain"
        )

    if cmd in {"LANG RESET", "LANGUAGE RESET"}:
        if phone_hash:
            with connect() as db:
                db.execute(
                    "DELETE FROM sms_language_preferences WHERE phone_hash=?", (phone_hash,)
                )
        return PlainTextResponse(
            api_message(lang, "sms_language_reset"), media_type="text/plain"
        )

    language_match = re.fullmatch(r"(?:LANG|LANGUAGE)\s+(EN|AM|TI|OM|SO)", cmd)
    if language_match:
        selected_language = language_match.group(1).lower()
        if not phone_hash:
            return PlainTextResponse(
                api_message(selected_language, "sms_language_needs_sender"),
                media_type="text/plain",
            )
        set_sms_language(phone_hash, selected_language)
        return PlainTextResponse(
            api_message(selected_language, "sms_language_saved"), media_type="text/plain"
        )

    if cmd.startswith("LANG ") or cmd.startswith("LANGUAGE "):
        return PlainTextResponse(
            api_message(lang, "sms_language_invalid"), media_type="text/plain"
        )

    # Command: PERSON opens an escalation
    if cmd == "PERSON":
        if not phone_hash:
            return PlainTextResponse(
                api_message(lang, "sms_sender_needed"), media_type="text/plain"
            )
        ticket_id = save_escalation_record(
            conversation=[{"from": "user", "text": "PERSON"}],
            language=lang,
            page=f"sms:{phone_hash}",
            note=f"SMS escalation from {phone_hash}",
        )
        background.add_task(notify_webhook, ticket_id)
        reference = ticket_id.replace("-", "")[-8:].upper()
        reply = api_message(lang, "sms_request_queued")
        reply = format_sms_message(reply, suffix=f"STATUS {reference}")
        return PlainTextResponse(reply, media_type="text/plain")

    # Command: STATUS <reference> checks a ticket from the same sender.
    status_match = re.fullmatch(r"STATUS(?:\s+([A-F0-9]{8}))?", cmd)
    if status_match:
        if not phone_hash:
            return PlainTextResponse(
                api_message(lang, "sms_same_sender"), media_type="text/plain"
            )
        reference = status_match.group(1)
        if not reference:
            reply = api_message(lang, "sms_status_instructions")
            return PlainTextResponse(format_sms_message(reply), media_type="text/plain")
        with connect() as db:
            purge_expired_tickets(db)
            rows = db.execute(
                "SELECT id, reply, status FROM escalations WHERE id LIKE ? AND page=?",
                (f"%{reference.lower()}", f"sms:{phone_hash}"),
            ).fetchall()
        if len(rows) != 1:
            reply = api_message(lang, "sms_no_match")
            return PlainTextResponse(format_sms_message(reply), media_type="text/plain")
        ticket = rows[0]
        if ticket["status"] == "answered":
            reply = f"{api_message(lang, 'sms_tutor_reply_prefix')}: {ticket['reply'] or ''}"
            return PlainTextResponse(format_sms_message(reply), media_type="text/plain")
        if ticket["reply"]:
            reply = f"{api_message(lang, 'sms_tutor_update_prefix')}: {ticket['reply']}"
        else:
            reply = api_message(lang, "sms_no_tutor_reply")
        return PlainTextResponse(
            format_sms_message(reply, suffix=f"STATUS {reference}"),
            media_type="text/plain",
        )

    # Command: JOBS lists up to 3 job titles
    if cmd == "JOBS":
        job_titles = get_job_titles(lang=lang, limit=3)
        reply = api_message(lang, "sms_jobs_prefix") + " " + " ".join(
            f"{i+1}. {t}" for i, t in enumerate(job_titles)
        )
        return PlainTextResponse(format_sms_message(reply), media_type="text/plain")

    # ALERT ON discloses the sender and possible carrier charges before consent.
    if cmd == "ALERT":
        sender = os.getenv("TWILIO_FROM_NUMBER", "").strip()
        if not sms_alert_delivery_configured():
            reply = api_message(lang, "sms_alert_unavailable")
        else:
            reply = api_message(lang, "sms_alert_disclosure", sender=sender)
        return PlainTextResponse(format_sms_message(reply), media_type="text/plain")

    if cmd == "ALERT ON":
        if not phone_hash:
            return PlainTextResponse(api_message(lang, "sms_alert_sender_needed"), media_type="text/plain")
        if not sms_alert_delivery_configured():
            return PlainTextResponse(api_message(lang, "sms_alert_unavailable"), media_type="text/plain")
        now_iso = datetime.now(timezone.utc).isoformat()
        with connect() as db:
            db.execute(
                "INSERT OR REPLACE INTO sms_alerts(phone_hash, active, phone_ciphertext, updated_at) VALUES(?, 2, ?, ?)",
                (phone_hash, encrypt_sms_phone(stored_phone), now_iso),
            )
        sender = os.getenv("TWILIO_FROM_NUMBER", "").strip()
        reply = api_message(lang, "sms_alert_confirmation", sender=sender)
        return PlainTextResponse(format_sms_message(reply), media_type="text/plain")

    if cmd == "ALERT YES":
        if not phone_hash or not sms_alert_delivery_configured():
            return PlainTextResponse(api_message(lang, "sms_alert_unavailable"), media_type="text/plain")
        with connect() as db:
            row = db.execute(
                "SELECT active, updated_at, phone_ciphertext FROM sms_alerts WHERE phone_hash=?",
                (phone_hash,),
            ).fetchone()
            pending = False
            if row and row["active"] == 2 and row["phone_ciphertext"]:
                try:
                    requested_at = datetime.fromisoformat(row["updated_at"])
                    pending = datetime.now(timezone.utc) - requested_at <= timedelta(hours=24)
                except ValueError:
                    pending = False
            if not pending:
                reply = api_message(lang, "sms_alert_first")
            else:
                db.execute(
                    "UPDATE sms_alerts SET active=1, updated_at=? WHERE phone_hash=?",
                    (datetime.now(timezone.utc).isoformat(), phone_hash),
                )
                sender = os.getenv("TWILIO_FROM_NUMBER", "").strip()
                reply = api_message(lang, "sms_alert_enabled", sender=sender)
        return PlainTextResponse(format_sms_message(reply), media_type="text/plain")

    if cmd == "ALERT OFF":
        now_iso = datetime.now(timezone.utc).isoformat()
        with connect() as db:
            if phone_hash:
                db.execute(
                    "INSERT OR REPLACE INTO sms_alerts(phone_hash, active, phone_ciphertext, updated_at) VALUES(?, ?, ?, ?)",
                    (phone_hash, 0, None, now_iso),
                )
        reply = api_message(lang, "sms_alert_off")
        return PlainTextResponse(reply, media_type="text/plain")

    # Normal question: run answer pipeline
    sections = indexed_sections()
    result = await answer_question(text, lang, sections, allow_cloud=False, offline_only=offline_mode())
    record_course_gap_analytics(text, lang, sections, result)
    answer = result.get("answer", "")
    sources = result.get("sources", [])

    source_code = None
    if result.get("answerStatus") == "answered" and sources:
        source_code = get_source_short_code(sources[0], sections, lang)

    handoff_suffix = (
        api_message(lang, "sms_person_instruction")
        if result.get("answerStatus") in {"not_found", "off_topic", "refused"}
        else None
    )
    formatted = format_sms_message(answer, source_code, suffix=handoff_suffix)
    return PlainTextResponse(formatted, media_type="text/plain")


@app.post("/sms/inbound", response_class=Response)
@app.post("/api/v1/sms/inbound", response_class=Response)
async def sms_inbound(request: Request, background: BackgroundTasks) -> Response:
    content_type = request.headers.get("content-type", "").lower()
    is_twilio = content_type.startswith("application/x-www-form-urlencoded") or content_type.startswith("multipart/form-data")
    if is_twilio:
        form = await request.form()
        _validate_twilio_webhook(request, form)
        payload = {"from": form.get("From", ""), "text": form.get("Body", "")}
    else:
        # Keep the JSON simulator on the versioned route. The provider-facing
        # route requires signed form posts once live webhook mode is enabled.
        if twilio_webhooks_enabled() and request.url.path == "/sms/inbound":
            raise HTTPException(status_code=415, detail="Live Twilio SMS callbacks must use form encoding.")
        try:
            payload = await request.json()
        except Exception:
            text = api_message("en", "sms_invalid_json")
            return PlainTextResponse(text, status_code=400)
        if not isinstance(payload, dict):
            text = api_message("en", "sms_invalid_object")
            return PlainTextResponse(text, status_code=400)

    result = await _process_sms_payload(payload, background)
    if is_twilio:
        return _sms_webhook_response(result.body.decode("utf-8"), result.status_code, background)
    return result


def ticket_dict(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "ticketId": row["id"], "conversation": json.loads(row["conversation"]),
        "language": row["language"], "page": row["page"], "note": row["note"],
        "reply": row["reply"], "status": row["status"], "createdAt": row["created_at"],
        "audio": json.loads(row["audio_json"]) if row["audio_json"] else None,
        "type": row["type"], "jobId": row["job_id"], "accommodation": row["accommodation"],
        "screenContext": json.loads(row["screen_context_json"]) if row["screen_context_json"] else None,
        "phone": row["phone"],
    }


def helper_handoff_brief(db: sqlite3.Connection, row: sqlite3.Row) -> dict[str, Any]:
    stored = row["handoff_brief_json"]
    if stored:
        brief = json.loads(stored)
        if isinstance(brief, dict) and brief.get("version") == _HANDOFF_BRIEF_VERSION:
            return brief

    conversation = json.loads(row["conversation"])
    if not isinstance(conversation, list):
        conversation = []
    brief = build_handoff_brief(
        conversation,
        row["language"],
        row["page"],
        job_id=row["job_id"],
        sections=indexed_sections(),
    )
    db.execute(
        "UPDATE escalations SET handoff_brief_json=? WHERE id=?",
        (json.dumps(brief, ensure_ascii=False), row["id"]),
    )
    return brief


def helper_ticket_dict(db: sqlite3.Connection, row: sqlite3.Row) -> dict[str, Any]:
    return {**ticket_dict(row), "handoffBrief": helper_handoff_brief(db, row)}


@app.post("/api/v1/escalations", status_code=201)
def create_escalation(payload: dict[str, Any], background: BackgroundTasks) -> dict[str, str]:
    conversation = payload.get("conversation", [])
    language, page, note = payload.get("language"), payload.get("page"), payload.get("note", "")
    error_language = language if isinstance(language, str) and language in SUPPORTED_LANGUAGES else "en"
    if not isinstance(conversation, list) or len(conversation) > 200:
        plain_bad("Conversation must be a list of up to 200 messages.", error_language, "error_ticket_conversation")
    if any(
        not isinstance(message, dict)
        or not isinstance(message.get("text"), str)
        or len(message["text"]) > 4000
        for message in conversation
    ):
        plain_bad("Each conversation message needs text.", error_language, "error_ticket_message")
    if not isinstance(language, str) or language not in SUPPORTED_LANGUAGES:
        plain_bad("Language must be en, am, om, ti, so, or ar.", "en", "error_language")
    if not isinstance(page, str) or not page or len(page) > 2048:
        plain_bad("Add the page address.", language, "error_ticket_page")
    handoff_reason = payload.get("handoffReason")
    if handoff_reason is not None and (
        not isinstance(handoff_reason, str) or handoff_reason not in _HANDOFF_REASONS
    ):
        plain_bad("Handoff reason must be answer_not_found, learner_requested_person, answer_flagged_incorrect, or other.")
    if not isinstance(note, str) or len(note) > 4000:
        plain_bad("The note must be 4000 characters or fewer.", language, "error_ticket_note")
    raw_phone = payload.get("phone", "")
    if not isinstance(raw_phone, str):
        plain_bad("Phone number must be written as text.")
    normalized_phone = normalize_ethiopian_phone(raw_phone) if raw_phone.strip() else None
    if raw_phone.strip() and not normalized_phone:
        plain_bad("Use an Ethiopian mobile number starting with 09, 07, +2519, or +2517.", language, "error_ticket_phone")
    audio = payload.get("audio")
    ticket_type = payload.get("type", "person")
    job_id, accommodation = payload.get("jobId"), payload.get("accommodation")
    if ticket_type not in ("person", "accommodation", "screen-share", "screen-context"):
        plain_bad("Ticket type is not supported.")
    if ticket_type == "accommodation":
        if not isinstance(job_id, str) or not job_id.strip() or not isinstance(accommodation, str) or not accommodation.strip():
            plain_bad("Choose a job and the accommodation you need.")
    screen_context = payload.get("screenContext")
    screen_context_json = None
    if ticket_type == "screen-context":
        if not isinstance(screen_context, dict):
            plain_bad("Page context must be an object.")
        page_url = screen_context.get("pageUrl")
        accessible_name = screen_context.get("focusedAccessibleName", "")
        outer_html = screen_context.get("focusedOuterHTML", "")
        headings = screen_context.get("headings", [])
        if not isinstance(page_url, str) or len(page_url) > 2048:
            plain_bad("Page context needs a valid page URL.")
        if not isinstance(accessible_name, str) or len(accessible_name) > 500:
            plain_bad("Focused accessible name must be 500 characters or fewer.")
        if not isinstance(outer_html, str) or len(outer_html) > 500:
            plain_bad("Focused element HTML must be 500 characters or fewer.")
        if not isinstance(headings, list) or len(headings) > 20 or any(
            not isinstance(heading, str) or len(heading) > 300 for heading in headings
        ):
            plain_bad("Page headings must be a list of up to 20 short strings.")
        normalized_context: dict[str, Any] = {
            "pageUrl": page_url,
            "focusedAccessibleName": accessible_name,
            "focusedOuterHTML": outer_html,
            "headings": headings,
            "screenshot": None,
        }
        screenshot = screen_context.get("screenshot")
        if screenshot is not None:
            if (
                not isinstance(screenshot, dict)
                or screenshot.get("mimeType") not in {"image/jpeg", "image/png", "image/webp", "image/gif"}
                or not isinstance(screenshot.get("dataUrl"), str)
            ):
                plain_bad("Screenshot must be a supported image.")
            mime_type = screenshot["mimeType"]
            data_url = screenshot["dataUrl"]
            if len(data_url) > 4_100_000 or not data_url.startswith(f"data:{mime_type};base64,"):
                plain_bad("Screenshot must be smaller than 3 MB.")
            try:
                decoded_image = base64.b64decode(data_url.split(",", 1)[1], validate=True)
            except (binascii.Error, ValueError):
                plain_bad("Screenshot data is not valid.")
            if len(decoded_image) > 3_000_000:
                plain_bad("Screenshot must be smaller than 3 MB.")
            normalized_context["screenshot"] = {"mimeType": mime_type, "dataUrl": data_url}
        screen_context_json = json.dumps(normalized_context, ensure_ascii=False)
    elif screen_context is not None:
        plain_bad("Page context is only allowed on a screen-context ticket.")
    audio_json = None
    if audio is not None:
        if not isinstance(audio, dict) or not isinstance(audio.get("mimeType"), str) or not isinstance(audio.get("dataUrl"), str):
            plain_bad("Voice note must include its audio type and recording.")
        mime_type, data_url = audio["mimeType"], audio["dataUrl"]
        if not mime_type.startswith("audio/") or len(data_url) > 12_000_000 or not data_url.startswith(f"data:{mime_type};base64,"):
            plain_bad("Voice note format is not supported or is too large.")
        try:
            decoded_audio = base64.b64decode(data_url.split(",", 1)[1], validate=True)
        except (binascii.Error, ValueError):
            plain_bad("Voice note data is not valid.")
        if len(decoded_audio) > 8_000_000:
            plain_bad("Voice note must be smaller than 8 MB.")
        audio_json = json.dumps({"mimeType": mime_type, "dataUrl": data_url})
    access_token = secrets.token_urlsafe(32)
    ticket_id = save_escalation_record(
        conversation, language, page, note, audio_json, ticket_type,
        job_id.strip() if isinstance(job_id, str) else None,
        accommodation.strip() if isinstance(accommodation, str) else None,
        screen_context_json,
        phone=normalized_phone,
        access_token_hash=hashlib.sha256(access_token.encode("utf-8")).hexdigest(),
        handoff_reason=handoff_reason,
    )
    background.add_task(notify_webhook, ticket_id)
    return {"ticketId": ticket_id, "accessToken": access_token}


@app.get("/api/v1/escalations")
def list_waiting(x_helper_token: str | None = Header(default=None)) -> list[dict[str, Any]]:
    helper_auth(x_helper_token)
    with connect() as db:
        purge_expired_tickets(db)
        rows = db.execute("SELECT * FROM escalations WHERE status='waiting' ORDER BY created_at").fetchall()
        tickets = [helper_ticket_dict(db, row) for row in rows]
    return tickets


@app.get("/api/v1/helper/escalations/{ticket_id}/brief", response_model=HandoffBrief)
def get_helper_handoff_brief(
    ticket_id: str,
    x_helper_token: str | None = Header(default=None),
) -> dict[str, Any]:
    helper_auth(x_helper_token)
    with connect() as db:
        purge_expired_tickets(db)
        row = db.execute("SELECT * FROM escalations WHERE id=?", (ticket_id,)).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="We could not find that ticket.")
        return helper_handoff_brief(db, row)


@app.get("/api/v1/escalations/{ticket_id}")
def get_escalation(
    ticket_id: str,
    x_learner_token: str | None = Header(default=None),
) -> dict[str, Any]:
    with connect() as db:
        purge_expired_tickets(db)
        row = db.execute("SELECT * FROM escalations WHERE id=?", (ticket_id,)).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="We could not find that ticket.")
    if row["access_token_hash"]:
        token_hash = hashlib.sha256(x_learner_token.encode("utf-8")).hexdigest() if x_learner_token else ""
        if not hmac.compare_digest(token_hash, row["access_token_hash"]):
            raise HTTPException(status_code=404, detail="We could not find that ticket.")
    result = ticket_dict(row)
    return {"ticketId": result["ticketId"], "reply": result["reply"], "status": result["status"], "language": result["language"]}


def learner_ticket_row(db: sqlite3.Connection, ticket_id: str, token: str) -> sqlite3.Row:
    if not token or len(token) > 256:
        raise HTTPException(status_code=404, detail="We could not find that ticket.")
    purge_expired_tickets(db)
    row = db.execute("SELECT * FROM escalations WHERE id=?", (ticket_id,)).fetchone()
    token_hash = hashlib.sha256(token.encode("utf-8")).hexdigest()
    if row is None or not row["access_token_hash"] or not hmac.compare_digest(token_hash, row["access_token_hash"]):
        raise HTTPException(status_code=404, detail="We could not find that ticket.")
    return row


@app.get("/api/v1/escalations/{ticket_id}/data")
def export_escalation_data(
    ticket_id: str,
    x_learner_token: str = Header(...),
) -> dict[str, Any]:
    with connect() as db:
        row = learner_ticket_row(db, ticket_id, x_learner_token)
        return ticket_dict(row)


@app.delete("/api/v1/escalations/{ticket_id}/data")
def delete_learner_escalation_data(
    ticket_id: str,
    x_learner_token: str = Header(...),
) -> dict[str, str]:
    with connect() as db:
        learner_ticket_row(db, ticket_id, x_learner_token)
        db.execute("DELETE FROM escalation_signals WHERE ticket_id=?", (ticket_id,))
        db.execute("DELETE FROM escalations WHERE id=?", (ticket_id,))
    return {"message": "Ticket data deleted."}


@app.post("/api/v1/escalations/{ticket_id}/signal")
def post_escalation_signal(
    ticket_id: str,
    payload: dict[str, Any],
    x_helper_token: str | None = Header(default=None),
) -> dict[str, bool]:
    signal_type, sdp = payload.get("type"), payload.get("sdp")
    if signal_type not in ("offer", "answer"):
        plain_bad("Signal type must be offer or answer.")
    if signal_type == "answer":
        helper_auth(x_helper_token)
    if not isinstance(sdp, str) or not sdp.strip() or len(sdp) > 200_000:
        plain_bad("A valid WebRTC session description is required.")
    with connect() as db:
        purge_expired_tickets(db)
        ticket = db.execute(
            "SELECT type FROM escalations WHERE id=?", (ticket_id,)
        ).fetchone()
        if ticket is None:
            raise HTTPException(status_code=404, detail="We could not find that ticket.")
        if ticket["type"] != "screen-share":
            plain_bad("Screen signaling is only available for screen-share tickets.")
        db.execute(
            "INSERT INTO escalation_signals(ticket_id, signal_type, sdp, created_at) "
            "VALUES(?, ?, ?, ?) ON CONFLICT(ticket_id, signal_type) "
            "DO UPDATE SET sdp=excluded.sdp, created_at=excluded.created_at",
            (ticket_id, signal_type, sdp.strip(), datetime.now(timezone.utc).isoformat()),
        )
    return {"stored": True}


@app.get("/api/v1/escalations/{ticket_id}/signal")
def get_escalation_signal(
    ticket_id: str,
    signal_type: str = Query(alias="type"),
    x_helper_token: str | None = Header(default=None),
) -> dict[str, str | None]:
    if signal_type not in ("offer", "answer"):
        plain_bad("Signal type must be offer or answer.")
    if signal_type == "offer":
        helper_auth(x_helper_token)
    with connect() as db:
        purge_expired_tickets(db)
        ticket = db.execute(
            "SELECT type FROM escalations WHERE id=?", (ticket_id,)
        ).fetchone()
        if ticket is None:
            raise HTTPException(status_code=404, detail="We could not find that ticket.")
        row = db.execute(
            "SELECT sdp FROM escalation_signals WHERE ticket_id=? AND signal_type=?",
            (ticket_id, signal_type),
        ).fetchone()
    return {"type": signal_type, "sdp": row["sdp"] if row else None}


@app.delete("/api/v1/escalations/{ticket_id}/signal")
def delete_escalation_signal(ticket_id: str) -> dict[str, bool]:
    with connect() as db:
        purge_expired_tickets(db)
        ticket = db.execute(
            "SELECT id FROM escalations WHERE id=?", (ticket_id,)
        ).fetchone()
        if ticket is None:
            raise HTTPException(status_code=404, detail="We could not find that ticket.")
        db.execute("DELETE FROM escalation_signals WHERE ticket_id=?", (ticket_id,))
    return {"deleted": True}


@app.post("/api/v1/escalations/{ticket_id}/reply")
def reply(ticket_id: str, payload: dict[str, Any], x_helper_token: str | None = Header(default=None)) -> dict[str, str]:
    helper_auth(x_helper_token)
    text = payload.get("text")
    if not isinstance(text, str) or not text.strip() or len(text) > 8000:
        plain_bad("Write a reply of 1 to 8000 characters.")
    resolve_ticket = payload.get("resolve", True)
    if not isinstance(resolve_ticket, bool):
        plain_bad("Resolve must be true or false.")
    status = "answered" if resolve_ticket else "waiting"
    with connect() as db:
        purge_expired_tickets(db)
        cursor = db.execute("UPDATE escalations SET reply=?, replied_at=?, status=? WHERE id=?",
                            (text.strip(), datetime.now(timezone.utc).isoformat(), status, ticket_id))
    if not cursor.rowcount:
        raise HTTPException(status_code=404, detail="We could not find that ticket.")
    return {"message": "Reply saved.", "status": status}


@app.post("/api/v1/escalations/{ticket_id}/close")
def close_escalation(ticket_id: str, x_helper_token: str | None = Header(default=None)) -> dict[str, str]:
    """Resolve a ticket without requiring a final learner-facing reply."""
    helper_auth(x_helper_token)
    with connect() as db:
        purge_expired_tickets(db)
        row = db.execute("SELECT status FROM escalations WHERE id=?", (ticket_id,)).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="We could not find that ticket.")
        if row["status"] == "waiting":
            db.execute(
                "UPDATE escalations SET status='answered', replied_at=? WHERE id=?",
                (datetime.now(timezone.utc).isoformat(), ticket_id),
            )
    return {"message": "Ticket closed.", "status": "answered"}


@app.delete("/api/v1/escalations/{ticket_id}")
def delete_escalation(ticket_id: str, x_helper_token: str | None = Header(default=None)) -> dict[str, str]:
    helper_auth(x_helper_token)
    with connect() as db:
        db.execute("DELETE FROM escalation_signals WHERE ticket_id=?", (ticket_id,))
        cursor = db.execute("DELETE FROM escalations WHERE id=?", (ticket_id,))
    if not cursor.rowcount:
        raise HTTPException(status_code=404, detail="We could not find that ticket.")
    return {"message": "Ticket deleted."}


@app.get("/helper", include_in_schema=False)
def helper_page() -> FileResponse:
    return FileResponse(ROOT / "static" / "helper.html")


@app.get("/", include_in_schema=False)
def lesson_page() -> FileResponse:
    return FileResponse(ROOT.parent / "savanna" / "pages" / "concept-with-navigation.html")


@app.get("/savanna", include_in_schema=False)
@app.get("/savanna/", include_in_schema=False)
def savanna_lesson_page() -> FileResponse:
    return FileResponse(ROOT.parent / "savanna" / "pages" / "concept-with-navigation.html")


@app.get("/sw.js", include_in_schema=False)
def service_worker() -> FileResponse:
    return FileResponse(ROOT.parent / "sw.js", media_type="application/javascript")


static_dir = ROOT / "static"
static_dir.mkdir(parents=True, exist_ok=True)
app.mount("/static", StaticFiles(directory=static_dir), name="static")

module_dir = ROOT.parent / "module" if (ROOT.parent / "module").exists() else static_dir
app.mount("/module", StaticFiles(directory=module_dir), name="module")

demo_dir = ROOT.parent / "demo" if (ROOT.parent / "demo").exists() else static_dir
app.mount("/demo", StaticFiles(directory=demo_dir, html=True), name="demo")

savanna_dir = ROOT.parent / "savanna" if (ROOT.parent / "savanna").exists() else static_dir
app.mount("/savanna", StaticFiles(directory=savanna_dir, html=True), name="savanna")
