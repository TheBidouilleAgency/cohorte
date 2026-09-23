from __future__ import annotations

import json

from cohorte.domain.redaction import REDACTED, redact, redact_text


def test_redact_removes_nested_and_inline_secrets() -> None:
    secret = "sk-fake-never-store"
    payload = {
        "OPENAI_API_KEY": secret,
        "nested": {
            "client_secret": secret,
            "message": f"OPENAI_API_KEY={secret} Authorization: Bearer {secret}",
        },
        "token_count": 42,
    }

    encoded = json.dumps(redact(payload))

    assert secret not in encoded
    assert encoded.count(REDACTED) >= 3
    assert '"token_count": 42' in encoded


def test_redact_text_preserves_context_without_bearer_value() -> None:
    secret = "ey.fake.token"
    sanitized = redact_text(f"request failed: authorization=Bearer {secret}")

    assert secret not in sanitized
    assert "authorization=" in sanitized
    assert REDACTED in sanitized
