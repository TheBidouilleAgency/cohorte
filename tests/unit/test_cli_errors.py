from __future__ import annotations

import json

import pytest

from cohorte.cli.main import _fail


def test_cli_error_redacts_secrets(capsys: pytest.CaptureFixture[str]) -> None:
    secret = "sk-fake-cli-error"

    with pytest.raises(SystemExit) as caught:
        _fail(ValueError(f"OPENAI_API_KEY={secret}"), json_mode=True)

    payload = json.loads(capsys.readouterr().out)
    assert caught.value.code == 3
    assert secret not in json.dumps(payload)
    assert "[REDACTED]" in payload["error"]["message"]
