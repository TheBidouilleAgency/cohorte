# Changelog

Release notes for the Python Cohorte package. Add a dated section for each published version,
with the newest version first. Describe the verified scope and known limitations of a dev release.

## Unreleased

- Name the upcoming Python distribution `cohorte-engine`; the CLI remains `cohorte`.
- The first Python release has not been published yet.

## 0.1.0a1 — unreleased

- Start the Python 3.12 root rewrite with no dependency on former Cohorte implementations.
- Add strict contracts, a pure reducer, SQLite persistence and immutable artifacts.
- Add project discovery, readiness/auth gates, conflict-aware scheduling and controlled checks.
- Add the CLI, JSON-RPC stdio bridge, event replay and operation deduplication.
- Add Codex subscription inspection and an explicit read-only live verification probe.
- Certify Codex 0.155.1 read-only enforcement, interruption and session resume on Darwin arm64.
- Build and verify wheel/sdist packaging while keeping provider support explicitly uncertified.
