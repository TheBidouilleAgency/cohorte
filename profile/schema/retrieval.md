## Code retrieval — `retrieval.provider`

Agents spend most of their wall-clock reading the repo; a retrieval provider replaces grep-and-read
with symbol/graph queries. The flag is a **value, not a boolean**, so switching provider later is a
one-line profile change + re-running the wiring (no agent re-render needed — the guidance agents
follow is provider-agnostic: _"prefer the retrieval MCP tools over Grep/Glob + whole-file Reads"_).

| Provider | Mechanism | Freshness | Cost |
| --- | --- | --- | --- |
| `serena` (default) | live LSP symbol navigation (find symbol, references, semantic edits) | always current | none — no index |
| `graphify` | persistent tree-sitter knowledge graph over code + docs | as fresh as the last rescan | index step + re-index discipline |
| `none` | agents fall back to Grep/Glob/Read | — | — |

**Wiring (done by `/cohorte-init-pipeline`, or `/cohorte-update-pipeline` retroactively):**

- `serena` — requires the `serena` CLI (`uv tool install -p 3.13 serena-agent`). For day-to-day CLI
  use it should also be on PATH (`uv tool update-shell`; uv installs to `~/.local/bin`). Register at
  **project scope** so the registration is committed and portable (`--project-from-cwd` resolves the
  project at server start, so the committed entry works on every machine) — and register the
  **PATH-proof launcher**, not the bare command: Claude Code spawns MCP servers with whatever
  environment it was launched from (a stale terminal, a GUI/IDE launch that never sourced a shell
  profile), where `~/.local/bin` may be missing from PATH — a bare `serena` entry then dies with
  ENOENT and agents silently fall back to Grep/Read:

  ```sh
  claude mcp add --scope project serena -- sh -c 'exec "$(command -v serena || echo "$HOME/.local/bin/serena")" start-mcp-server --context claude-code --project-from-cwd --open-web-dashboard False'
  ```

  (Windows-native teams: no `sh` — register the bare `serena` form instead and ensure the uv tools
  dir is on PATH; keep the `--open-web-dashboard False` flag.) `--open-web-dashboard False` keeps the
  dashboard available (reachable at `http://localhost:24282/dashboard/`) but stops it popping a browser
  tab on every server start — the flag overrides the machine's `serena_config.yml`, so the behaviour is
  the same for everyone on the repo. Gitignore `.serena/` (per-machine cache/config). Optionally
  pre-index large repos once: `serena project index`.
- `graphify` — requires `uv tool install graphify` + `graphify install`; build the initial graph
  (`/graphify .`) and rescan incrementally after big changes (`--update`). See graphify.net.
- Rendered agents get the provider's MCP tools appended to their `tools:` list (e.g. `mcp__serena`
  grants the whole server); `none` ⇒ nothing appended.

**Serena health check** — run after wiring in `/cohorte-init-pipeline` AND on every `/cohorte-update-pipeline`
reconcile (wiring that worked once can rot: PATH changes, tool uninstalled, entry hand-edited):

1. **CLI resolves:** `command -v serena`. Fails but `~/.local/bin/serena` exists ⇒ PATH repair
   above; missing entirely ⇒ reinstall.
2. **Registered:** this repo's `.mcp.json` has the `serena` entry ⇒ else re-run the `claude mcp add`.
   If the entry is the bare `serena` form on a POSIX machine, upgrade it to the PATH-proof launcher
   above (immune to launch-environment PATH gaps). If a launcher entry predates the
   `--open-web-dashboard False` flag, append it so the dashboard no longer auto-opens a browser tab.
3. **Gitignored:** `.serena/` is in `.gitignore` ⇒ else append it.
4. **Actually connected:** the `mcp__serena` tools are exposed in the session (or `claude mcp list`
   shows serena connected). If 1–3 pass but this fails, a session restart is needed — say so
   explicitly instead of reporting success.

Report each check's result; never report Serena "wired" on registration alone.

Teammates cloning the repo get the committed `.mcp.json` and only need the provider CLI installed
and on PATH — if either is missing, the MCP server fails to start and agents silently fall back to
Grep/Read; the health check above is the diagnostic.
