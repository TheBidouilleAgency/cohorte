"""Validate release metadata and deliver the published notes to Discord."""

from __future__ import annotations

import argparse
import ast
import json
import os
import re
import tomllib
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
VERSION = re.compile(r"\d+\.\d+\.\d+(?:(?:a|b|rc)\d+)?")
HEADING = re.compile(r"^##\s+\[?([^\]\s]+)\]?\s+[—-]\s+\d{4}-\d{2}-\d{2}\s*$")


def project_version(root: Path = ROOT) -> str:
    version = tomllib.loads((root / "pyproject.toml").read_text())["project"]["version"]
    if not isinstance(version, str) or VERSION.fullmatch(version) is None:
        raise ValueError(f"unsupported release version: {version}")
    module = ast.parse((root / "src/cohorte/__init__.py").read_text())
    runtime = next(
        (
            node.value.value
            for node in module.body
            if isinstance(node, ast.Assign)
            and any(
                isinstance(target, ast.Name) and target.id == "__version__"
                for target in node.targets
            )
            and isinstance(node.value, ast.Constant)
        ),
        None,
    )
    if runtime != version:
        raise ValueError(f"runtime version {runtime!r} differs from package version {version!r}")
    return version


def release_notes(version: str, changelog: str) -> str:
    sections = changelog.splitlines()
    for index, line in enumerate(sections):
        match = HEADING.fullmatch(line)
        if match is None or match.group(1) != version:
            continue
        end = next(
            (
                position
                for position in range(index + 1, len(sections))
                if sections[position].startswith("## ")
            ),
            len(sections),
        )
        notes = "\n".join(sections[index + 1 : end]).strip()
        if not notes or not any(
            line.lstrip().startswith(("- ", "* ")) for line in notes.splitlines()
        ):
            raise ValueError(f"release {version} needs non-empty changelog bullets")
        if re.search(r"\b(?:TODO|TBD|à décrire)\b", notes, flags=re.IGNORECASE):
            raise ValueError(f"release {version} still contains a placeholder")
        return notes + "\n"
    raise ValueError(f"CHANGELOG.md needs a dated '## {version} — YYYY-MM-DD' section")


def discord_payload(version: str, notes: str, release_url: str) -> bytes:
    description = notes.strip()
    if len(description) > 3800:
        description = description[:3799].rsplit("\n", 1)[0] or description[:3799]
        description += "…"
    return json.dumps(
        {
            "allowed_mentions": {"parse": []},
            "embeds": [
                {
                    "title": f"Cohorte {version}",
                    "description": description,
                    "url": release_url,
                    "color": 3066993,
                }
            ],
        },
        ensure_ascii=False,
    ).encode("utf-8")


def notify_discord(version: str, notes: str, release_url: str) -> None:
    webhook = os.environ.get("DISCORD_FORUM_WEBHOOK", "")
    thread = os.environ.get("DISCORD_THREAD_ID", "")
    if not webhook or not thread:
        raise ValueError("DISCORD_FORUM_WEBHOOK and DISCORD_THREAD_ID must be configured")
    parts = urllib.parse.urlsplit(webhook)
    if parts.scheme != "https" or parts.hostname not in {"discord.com", "discordapp.com"}:
        raise ValueError("Discord webhook has an unexpected host")
    query = urllib.parse.parse_qsl(parts.query, keep_blank_values=True)
    query.extend([("thread_id", thread), ("wait", "true")])
    url = urllib.parse.urlunsplit(parts._replace(query=urllib.parse.urlencode(query)))
    request = urllib.request.Request(
        url,
        data=discord_payload(version, notes, release_url),
        headers={
            "Content-Type": "application/json",
            "User-Agent": "CohorteRelease/1.0 (+https://github.com/TheBidouilleAgency/cohorte)",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            if response.status not in {200, 204}:
                raise RuntimeError(f"Discord returned HTTP {response.status}")
    except urllib.error.HTTPError as error:
        # Discord's numeric API code is diagnostic, while the body can contain
        # untrusted text. Never print the webhook URL or raw response in CI.
        try:
            details = json.loads(error.read(4096))
        except (ValueError, OSError):
            details = None
        api_code = details.get("code") if isinstance(details, dict) else None
        suffix = f" (API code {api_code})" if type(api_code) is int else ""
        raise RuntimeError(f"Discord returned HTTP {error.code}{suffix}") from None
    except urllib.error.URLError:
        raise RuntimeError("Discord notification could not connect") from None


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["check", "version", "notes", "discord"])
    parser.add_argument("--output", type=Path)
    parser.add_argument("--release-url")
    args = parser.parse_args()
    version = project_version()
    if args.command == "version":
        print(version)
        return
    notes = release_notes(version, (ROOT / "CHANGELOG.md").read_text())
    if args.command == "check":
        print(f"Release metadata OK: {version}")
    elif args.command == "notes":
        if args.output is None:
            parser.error("notes requires --output")
        args.output.write_text(notes)
    elif args.command == "discord":
        if not args.release_url:
            parser.error("discord requires --release-url")
        notify_discord(version, notes, args.release_url)
        print(f"Discord notified for {version}")


if __name__ == "__main__":
    main()
