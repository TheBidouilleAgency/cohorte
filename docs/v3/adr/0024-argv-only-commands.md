# ADR-0024: `run_command` is argv-only — no shell string, pinned program resolution, non-overridable trampolines

- **Status:** Provisional
- **Date:** 2026-09-18
- **Covers:** spec 9 ("allowlist de commandes", "command/network policy"), spec 23 ("commande destructrice")
- **Design reference:** DESIGN.md §2.6.4, §2.7, §7.4 (EV-01..EV-15)

## Context

V2's gate was a substring matcher over shell strings with 11 confirmed evasions (quoting, line continuation, variables, pipes into a shell,
case, `npx`, `git -C`/`-c`, aliases, `pushd`, subshells, overwriting the gate config). One V3 proposal kept a `{ script }` form parsed by an
in-house tokenizer and executed by an in-house pipeline runner — fail-closed, but a large security-critical parser re-creating the same attack
family. The delta report also found that `pi auth print-bearer-token` prints the OAuth token.

## Decision

1. `run_command` input is `{ argv: string[], cwd?, timeoutMs? }`. **No string form exists**; execution is `shell: false`. The only shell use
   in the product is the L0 executor's constant `ulimit` wrapper (constant script, positional arguments).
2. `argv[0]` must be a bare name, alias-normalised, resolved to an absolute **realpath through a PATH pinned at run start** and recorded in the
   snapshot; the pinned PATH never contains Pi's or Cohorte's bin directory.
3. **Trampolines are denied and cannot be allowlisted**: shells, `env`, `xargs`, `sudo`/`su`/`doas`, `eval`/`exec`, `nohup`, `time`, `watch`,
   `npx`/`pnpx`/`bunx`, `corepack`, `ssh`/`scp`, `curl`/`wget`/`nc`, `python*`/`perl`/`ruby`, `osascript`, and **`pi` and `cohorte`**. A
   project that truly needs one declares an exact-argv rule under `policy.dangerousCommands`; every use is an `ask`.
4. Programs with a **profile** (git, pnpm, npm, yarn, node, docker) are parsed structurally; global options that re-target the command
   (`git -C/-c/--git-dir/--work-tree`, `pnpm -C/--dir`, `node -e/-r/--import/--loader`) are denied. Programs without a profile need an
   exact-argv rule. No rule ⇒ deny; deny over ask over allow.
5. `cwd` is a validated, worktree-confined field; branch-conditional rules treat detached/unknown as protected.
6. Every rule declares `replay` (`idempotent` | `at-most-once`) and `network`; these drive recovery (ADR-0025) and the L0 network denial (ADR-0003).
7. What an allowed script *does* is contained by the sandbox, not by the matcher.

## Consequences

- All eleven V2 evasions are structurally impossible rather than pattern-denied; the MUST-DENY table asserts the mechanism of each.
- Models must issue two tool calls instead of `a && b`, and cannot pipe; prompts and tool descriptions say so.
- Project check commands are argv arrays in `config.yaml`.

## Revisit when

- Real projects show a legitimate, frequent need for pipelines → add a *structured* pipeline input (array of argv + operators), still no text.
- Model behaviour degrades measurably without shell idioms → improve tool descriptions and examples first.
- More ecosystems need profiles (cargo, go, make, gradle) → add profiles; never loosen the no-profile rule.
