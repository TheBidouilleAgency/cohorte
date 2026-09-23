from __future__ import annotations

import json
from collections import Counter
from pathlib import Path


def test_ac01_ac30_matrix_is_complete_honest_and_linked() -> None:
    root = Path(__file__).resolve().parents[2]
    matrix = json.loads((root / "docs/qualification/ac-matrix.json").read_text())
    criteria = matrix["criteria"]

    assert [item["id"] for item in criteria] == [f"AC{index:02d}" for index in range(1, 31)]
    counts = Counter(item["status"] for item in criteria)
    statuses = {"passed", "partial", "blocked", "deferred", "not_started"}
    assert {status: counts.get(status, 0) for status in statuses} == matrix["summary"]
    assert set(counts) <= statuses

    for item in criteria:
        if item["status"] == "passed":
            assert item["evidence"], item["id"]
            assert item["remaining"] == [], item["id"]
        else:
            assert item["remaining"], item["id"]
        for reference in item["evidence"]:
            path = reference.split("::", 1)[0]
            assert (root / path).exists(), f"{item['id']} references missing evidence: {path}"
