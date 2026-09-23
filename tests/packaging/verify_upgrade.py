"""Exercise an installed a1 -> current wheel upgrade without touching user directories."""

from __future__ import annotations

import hashlib
import json
import shutil
import sqlite3
import subprocess
import sys
import tarfile
import tempfile
import tomllib
from contextlib import closing
from pathlib import Path

OLD_COMMIT = "ccb23fb6726287bb60056566c8c14ab28cb9727e"
OLD_VERSION = "0.1.0a1"
OLD_FIXTURE_SHA256 = "3ec72f47c1ba10e9dfabe5264cdaee2ac1394cd69aefcf308a6a3975959ff615"


def run(*argv: str, cwd: Path | None = None, ok: bool = True) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(argv, cwd=cwd, capture_output=True, text=True, check=False, timeout=240)
    if ok and result.returncode != 0:
        raise RuntimeError(f"{' '.join(argv)} failed: {result.stderr or result.stdout}")
    return result


def cli(command: Path, config: Path, data: Path, *args: str) -> dict[str, object]:
    output = run(
        str(command),
        "--json",
        "--config-dir",
        str(config),
        "--data-dir",
        str(data),
        *args,
    )
    payload = json.loads(output.stdout)
    if payload["ok"] is not True:
        raise RuntimeError(f"installed CLI rejected {args}: {payload}")
    return payload["data"]


def snapshot(path: Path) -> dict[str, object]:
    with closing(sqlite3.connect(path, isolation_level=None)) as db:
        integrity = db.execute("PRAGMA integrity_check").fetchone()[0]
        if integrity != "ok":
            raise RuntimeError(f"database integrity failed: {integrity}")
        return {
            "schema": db.execute("PRAGMA user_version").fetchone()[0],
            "projects": db.execute(
                "SELECT id,root_path,profile_artifact_id FROM projects ORDER BY id"
            ).fetchall(),
            "features": db.execute(
                "SELECT id,project_id,title,kind,status FROM features ORDER BY id"
            ).fetchall(),
            "artifacts": db.execute(
                "SELECT id,revision,kind,sha256,content FROM artifacts ORDER BY id,revision"
            ).fetchall(),
        }


def main() -> None:
    repository = Path(__file__).resolve().parents[2]
    new_version = tomllib.loads((repository / "pyproject.toml").read_text())["project"]["version"]
    current_wheels = list((repository / "dist").glob(f"cohorte_engine-{new_version}-*.whl"))
    if len(current_wheels) != 1:
        raise RuntimeError(f"expected one {new_version} wheel, found {len(current_wheels)}")
    uv = shutil.which("uv")
    if uv is None:
        raise RuntimeError("uv is required for installed-wheel upgrade qualification")

    with tempfile.TemporaryDirectory(prefix="cohorte-upgrade-") as raw:
        root = Path(raw)
        old_source = root / "old-source"
        old_source.mkdir()
        fixture = repository / "tests/packaging/fixtures/cohorte-local-0.1.0a1-source.tar.gz"
        if hashlib.sha256(fixture.read_bytes()).hexdigest() != OLD_FIXTURE_SHA256:
            raise RuntimeError("pinned a1 source fixture changed")
        with tarfile.open(fixture, mode="r:gz") as files:
            files.extractall(old_source, filter="data")
        old_wheels = root / "old-wheels"
        run(uv, "build", "--wheel", "--out-dir", str(old_wheels), str(old_source))
        old_candidates = list(old_wheels.glob(f"cohorte_local-{OLD_VERSION}-*.whl"))
        if len(old_candidates) != 1:
            raise RuntimeError("pinned a1 source did not build exactly one wheel")

        environment = root / "venv"
        run(uv, "venv", "--python", sys.executable, str(environment))
        python = environment / ("Scripts/python.exe" if sys.platform == "win32" else "bin/python")
        command = environment / (
            "Scripts/cohorte.exe" if sys.platform == "win32" else "bin/cohorte"
        )
        run(uv, "pip", "install", "--python", str(python), str(old_candidates[0]))
        if run(str(command), "--version").stdout.strip() != f"cohorte {OLD_VERSION}":
            raise RuntimeError("old installed command has the wrong version")

        config = root / "user-config"
        config.mkdir()
        config_file = config / "preferences.json"
        config_file.write_bytes(b'{"theme":"private-user-setting","revision":7}\n')
        config_hash = hashlib.sha256(config_file.read_bytes()).hexdigest()
        project = root / "project"
        project.mkdir()
        (project / "pyproject.toml").write_text(
            "[project]\nname='upgrade-fixture'\nversion='0.1.0'\n"
        )
        data = root / "user-data"
        initialized = cli(command, config, data, "init", str(project))
        project_id = initialized["profile"]["project_id"]
        cli(command, config, data, "intake", project_id, "--text", "Add a bounded local export")
        before = snapshot(data / "cohorte.sqlite3")
        if not before["projects"] or not before["features"] or len(before["artifacts"]) < 2:
            raise RuntimeError("old installed package did not create meaningful user state")

        future = root / "future-data"
        future.mkdir()
        future_db = future / "cohorte.sqlite3"
        with closing(sqlite3.connect(future_db, isolation_level=None)) as db:
            db.execute("PRAGMA user_version=999")
        future_hash = hashlib.sha256(future_db.read_bytes()).hexdigest()
        old_response = run(
            str(command),
            "--json",
            "--config-dir",
            str(config),
            "--data-dir",
            str(future),
            "doctor",
            ok=False,
        )
        old_diagnostics = old_response.stdout + old_response.stderr
        if old_response.returncode == 0 or "RUNTIME_INCOMPATIBLE" not in old_diagnostics:
            raise RuntimeError("installed old binary accepted a future database schema")
        if hashlib.sha256(future_db.read_bytes()).hexdigest() != future_hash:
            raise RuntimeError("old binary mutated an unsupported future database")

        run(uv, "pip", "uninstall", "--python", str(python), "cohorte-local")
        run(uv, "pip", "install", "--python", str(python), str(current_wheels[0]))
        if run(str(command), "--version").stdout.strip() != f"cohorte {new_version}":
            raise RuntimeError("new wheel did not replace the installed command")
        upgraded = cli(command, config, data, "doctor")
        if upgraded["database"]["ok"] is not True:
            raise RuntimeError("upgraded database is unhealthy")
        after = snapshot(data / "cohorte.sqlite3")
        if before != after:
            raise RuntimeError("installed upgrade changed user projects, features or artifacts")
        if hashlib.sha256(config_file.read_bytes()).hexdigest() != config_hash:
            raise RuntimeError("installed upgrade replaced user configuration")

        legacy_data = root / "legacy-data"
        legacy_data.mkdir()
        legacy_db = legacy_data / "cohorte.sqlite3"
        with closing(sqlite3.connect(legacy_db, isolation_level=None)) as db:
            db.executescript(
                "CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);"
                "INSERT INTO schema_migrations VALUES(1, '2026-09-21T00:00:00+00:00');"
                "CREATE TABLE sentinel(value TEXT NOT NULL);"
                "INSERT INTO sentinel VALUES('preserved');"
                "PRAGMA user_version=1;"
            )
        migrated = cli(command, config, legacy_data, "doctor")
        if migrated["database"]["schema_version"] != 2:
            raise RuntimeError("installed wheel did not migrate schema 1 to 2")
        with closing(sqlite3.connect(legacy_db, isolation_level=None)) as db:
            if db.execute("SELECT value FROM sentinel").fetchone()[0] != "preserved":
                raise RuntimeError("schema upgrade lost legacy user data")
        backups = list(legacy_data.glob("cohorte.sqlite3.pre-v2-*.bak"))
        if len(backups) != 1:
            raise RuntimeError("schema migration did not create exactly one backup")
        with closing(sqlite3.connect(backups[0], isolation_level=None)) as db:
            if db.execute("PRAGMA user_version").fetchone()[0] != 1:
                raise RuntimeError("pre-migration backup has the wrong schema")
            if db.execute("SELECT value FROM sentinel").fetchone()[0] != "preserved":
                raise RuntimeError("pre-migration backup lost legacy user data")

        print(
            json.dumps(
                {
                    "ok": True,
                    "from": OLD_VERSION,
                    "to": new_version,
                    "old_commit": OLD_COMMIT,
                    "installed_wheels": True,
                    "user_config_preserved": True,
                    "user_data_preserved": True,
                    "schema_migration": "1->2",
                    "pre_migration_backup_verified": True,
                    "old_binary_refused_future_schema": True,
                    "python": sys.version.split()[0],
                    "platform": sys.platform,
                },
                sort_keys=True,
            )
        )


if __name__ == "__main__":
    main()
