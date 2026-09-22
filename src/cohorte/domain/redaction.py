from __future__ import annotations

import re
from typing import Any

REDACTED = "[REDACTED]"
_SENSITIVE_KEY = re.compile(
    r"^(?:(?:[a-z0-9]+[_-])*(?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|token|secret|password|authorization|cookie|credentials?))$",
    re.IGNORECASE,
)
_ASSIGNMENT = re.compile(
    r"(?i)\b([a-z0-9_-]*(?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|token|secret|password|authorization|cookie))"
    r"(\s*[:=]\s*)([^\s,;]+)"
)
_BEARER = re.compile(r"(?i)\bbearer\s+[A-Za-z0-9._~+/=-]+")


def redact_text(value: str) -> str:
    value = _BEARER.sub(f"Bearer {REDACTED}", value)
    value = _ASSIGNMENT.sub(lambda match: f"{match.group(1)}{match.group(2)}{REDACTED}", value)
    return value


def redact(value: Any) -> Any:
    if isinstance(value, dict):
        return {
            str(key): REDACTED if _SENSITIVE_KEY.fullmatch(str(key)) else redact(child)
            for key, child in value.items()
        }
    if isinstance(value, list):
        return [redact(child) for child in value]
    if isinstance(value, tuple):
        return [redact(child) for child in value]
    if isinstance(value, str):
        return redact_text(value)
    return value
