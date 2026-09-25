import subprocess
from pathlib import Path

import pytest

from cohorte.adapters.git import GitRepository, path_is_owned


def git(root: Path, *args: str) -> None:
    subprocess.run(["git", *args], cwd=root, check=True, capture_output=True)


def test_path_ownership_requires_path_boundary() -> None:
    assert path_is_owned("src/module.py", ["src"])
    assert path_is_owned("src", ["src"])
    assert not path_is_owned("src-secret/file", ["src"])


def test_runtime_bytecode_does_not_change_candidate_snapshot(tmp_path: Path) -> None:
    root = tmp_path / "repo"
    root.mkdir()
    (root / "module.py").write_text("VALUE = 1\n")
    git(root, "init", "-b", "main")
    git(root, "config", "user.email", "test@example.invalid")
    git(root, "config", "user.name", "Test")
    git(root, "add", ".")
    git(root, "commit", "-m", "base")
    repository = GitRepository(root)
    original = repository.snapshot_digest()

    cache = root / "__pycache__"
    cache.mkdir()
    (cache / "module.cpython-313.pyc").write_bytes(b"generated")

    assert repository.changed_files(repository.head) == []
    assert repository.snapshot_digest() == original


def test_snapshot_hashes_symlink_targets_without_reading_outside_files(tmp_path: Path) -> None:
    root = tmp_path / "repo"
    root.mkdir()
    outside = tmp_path / "outside.txt"
    outside.write_text("first secret")
    git(root, "init", "-b", "main")
    try:
        (root / "link.txt").symlink_to(outside)
    except OSError:
        pytest.skip("symlink creation is unavailable")
    repository = GitRepository(root)
    initial = repository.snapshot_digest()
    outside.write_text("different secret")
    assert repository.snapshot_digest() == initial
    (root / "link.txt").unlink()
    (root / "link.txt").symlink_to(tmp_path / "other.txt")
    assert repository.snapshot_digest() != initial
