from __future__ import annotations

import hashlib
import re
from datetime import UTC, datetime
from enum import StrEnum
from pathlib import Path
from urllib.request import Request, urlopen

from pydantic import Field

from cohorte.domain.models import Sha256, StrictModel

MAX_INTAKE_BYTES = 2 * 1024 * 1024


class IntakeSourceType(StrEnum):
    TEXT = "text"
    FILE = "file"
    URL = "url"


class IntakeTriage(StrEnum):
    PATCH = "patch"
    FEATURE = "feature"
    QUESTIONS = "questions"


class IntakeReport(StrictModel):
    schema_version: int = 1
    source_type: IntakeSourceType
    locator: str
    source_sha256: Sha256
    captured_at: datetime
    title: str = Field(min_length=1, max_length=200)
    triage: IntakeTriage
    reasons: list[str]
    questions: list[str]
    content: str = Field(min_length=1, max_length=MAX_INTAKE_BYTES)
    untrusted_instructions_ignored: bool = True


def _decode(raw: bytes) -> str:
    if not raw or len(raw) > MAX_INTAKE_BYTES:
        raise ValueError("intake source must contain between 1 byte and 2 MiB")
    return raw.decode("utf-8", errors="replace")


def load_intake_source(
    source_type: IntakeSourceType, value: str, *, timeout_seconds: int = 10
) -> tuple[str, str]:
    if source_type == IntakeSourceType.TEXT:
        return value, "inline:text"
    if source_type == IntakeSourceType.FILE:
        path = Path(value).expanduser().resolve(strict=True)
        if not path.is_file():
            raise ValueError("intake file source is not a regular file")
        return _decode(path.read_bytes()), str(path)
    if not value.startswith(("https://", "http://")):
        raise ValueError("intake URL must use http or https")
    request = Request(value, headers={"User-Agent": "cohorte-intake/1"})
    with urlopen(request, timeout=timeout_seconds) as response:
        final_url = response.geturl()
        if not final_url.startswith(("https://", "http://")):
            raise ValueError("intake URL redirected to an unsupported scheme")
        raw = response.read(MAX_INTAKE_BYTES + 1)
    return _decode(raw), final_url


def classify_intake(
    content: str,
    source_type: IntakeSourceType = IntakeSourceType.TEXT,
    locator: str = "inline:text",
    title: str | None = None,
) -> IntakeReport:
    normalized = content.strip()
    if not normalized:
        raise ValueError("intake source is empty")
    title = title or next(line.strip() for line in normalized.splitlines() if line.strip())
    lowered = normalized.casefold()
    bug_signals = [
        r"\bbug\b",
        r"\berror\b",
        r"\bexception\b",
        r"\bregression\b",
        r"\bincorrect\b",
        r"\bfail(?:s|ed|ing|ure)?\b",
        r"\bne (?:marche|fonctionne) pas\b",
        r"\berreur\b",
        r"\bplant(?:e|age)\b",
    ]
    feature_signals = [
        r"\bfeature\b",
        r"\badd\b",
        r"\bimplement\b",
        r"\bnew capability\b",
        r"\bajout(?:er)?\b",
        r"\bnouvelle? fonctionnalit",
    ]
    reproduction_signals = [
        r"\bsteps? to reproduce\b",
        r"\brepro(?:duction|duce)?\b",
        r"\bwhen\b.+\bthen\b",
        r"\bétapes? (?:de|pour) reproduire\b",
        r"\bquand\b.+\balors\b",
    ]
    bug = any(re.search(pattern, lowered, re.DOTALL) for pattern in bug_signals)
    feature = any(re.search(pattern, lowered, re.DOTALL) for pattern in feature_signals)
    reproduction = any(re.search(pattern, lowered, re.DOTALL) for pattern in reproduction_signals)
    reasons: list[str] = []
    questions: list[str] = []
    if bug and reproduction and not feature:
        triage = IntakeTriage.PATCH
        reasons.extend(["bug signal detected", "explicit reproduction signal detected"])
    elif feature and not bug:
        triage = IntakeTriage.FEATURE
        reasons.append("feature signal detected")
    else:
        triage = IntakeTriage.QUESTIONS
        reasons.append("source is ambiguous or lacks an explicit reproduction")
        if bug and not reproduction:
            questions.append("What exact steps reproduce the observed behavior?")
        if not bug and not feature:
            questions.append("Is this a bug fix or a new feature?")
        questions.append("What observable behavior should prove completion?")
    return IntakeReport(
        source_type=source_type,
        locator=locator,
        source_sha256=hashlib.sha256(content.encode()).hexdigest(),
        captured_at=datetime.now(UTC),
        title=title[:200],
        triage=triage,
        reasons=reasons,
        questions=questions,
        content=content,
        untrusted_instructions_ignored=True,
    )
