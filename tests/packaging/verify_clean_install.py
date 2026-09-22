from __future__ import annotations

import json
import shutil
import subprocess
import sys
import tempfile
import tomllib
from pathlib import Path


def run(*argv: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(argv, check=True, capture_output=True, text=True, timeout=180)


def main() -> None:
    repository = Path(__file__).resolve().parents[2]
    project = tomllib.loads((repository / "pyproject.toml").read_text())
    expected_version = project["project"]["version"]
    wheels = sorted((repository / "dist").glob(f"cohorte_local-{expected_version}-*.whl"))
    if len(wheels) != 1:
        raise RuntimeError(f"expected exactly one Cohorte wheel, found {len(wheels)}")
    uv = shutil.which("uv")
    if uv is None:
        raise RuntimeError("uv is required for the clean-install qualification")

    with tempfile.TemporaryDirectory(prefix="cohorte-clean-install-") as raw:
        root = Path(raw)
        environment = root / "venv"
        run(uv, "venv", "--python", sys.executable, str(environment))
        python = environment / ("Scripts/python.exe" if sys.platform == "win32" else "bin/python")
        command = environment / (
            "Scripts/cohorte.exe" if sys.platform == "win32" else "bin/cohorte"
        )
        run(uv, "pip", "install", "--python", str(python), str(wheels[0]))

        version = run(str(command), "--version").stdout.strip()
        if version != f"cohorte {expected_version}":
            raise RuntimeError(f"unexpected installed version: {version}")
        help_text = run(str(command), "--help").stdout
        if "Local coding-agent workflow engine" not in help_text:
            raise RuntimeError("installed command did not expose the expected help")
        doctor = run(
            str(command),
            "--json",
            "--config-dir",
            str(root / "config"),
            "--data-dir",
            str(root / "data"),
            "doctor",
        )
        payload = json.loads(doctor.stdout)
        if payload.get("ok") is not True or payload["data"]["database"]["ok"] is not True:
            raise RuntimeError("installed doctor did not report a healthy package")

        print(
            json.dumps(
                {
                    "ok": True,
                    "wheel": wheels[0].name,
                    "version": version,
                    "help": "passed",
                    "doctor": "passed",
                    "python": sys.version.split()[0],
                    "platform": sys.platform,
                },
                sort_keys=True,
            )
        )


if __name__ == "__main__":
    main()
