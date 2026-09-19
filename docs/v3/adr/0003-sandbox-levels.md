# ADR-0003: Sandbox levels, the default requirement and the accepted degradation

- **Status:** Provisional — the default (`native`) needs the human's sign-off
- **Date:** 2026-09-18
- **Covers:** spec 31 open question 3
- **Design reference:** DESIGN.md §0.3, §2.6.6, §3.6

## Context

Spec 9 requires a bounded working directory, a filtered environment, network disabled by default, timeout, CPU/memory limits where available,
an output cap and a kill tree, and says `doctor` must report what is really active. Spec 28 lists "sandbox renforcé par OS" under V3.2+, but
spec 29 (binding for V3.0) says an agent cannot execute a refused command, and the most likely real attack on a coding agent is a
prompt-injected agent writing a test that reads `~/.pi/agent/auth.json` and posts it, then running the allowlisted `pnpm test`. Without an OS
sandbox, filesystem and network confinement of an *allowed* command are advisory: it runs as the user, can read the state DB, the command key
and the OAuth token. `@anthropic-ai/sandbox-runtime` is a 0.0.x process-global singleton with a SOCKS proxy; Linux `bwrap` under Ubuntu 24.04
AppArmor userns restrictions was documented but not executed during research. The macOS Seatbelt profile around the Pi child was executed.

## Decision

1. **L0** (process hygiene: allowlisted env, kill-tree with pgid + start-token sweep, timeout, output cap, rlimits through a constant wrapper)
   is mandatory on every OS.
2. **L1** (in-house Seatbelt and bubblewrap backends: write only under the worktree, `denyRead` for credentials/state/keys, network off, pid
   namespace on Linux) is **built in V3.0**. The executor profiles are **deny-by-default**: the `(allow default)` profile verified during
   research proves that Seatbelt enforces, but under it agent-written test code can call `open`/`osascript` (LaunchServices / AppleEvents
   start a process *outside* the sandbox, with the network and the OAuth token) or signal the run host; and `bwrap --ro-bind / /` with
   `--unshare-net` leaves path-based Unix sockets (docker, user D-Bus → `systemd-run`, ssh-agent, gpg-agent) connectable. Seatbelt:
   `(deny default)` + explicit allows (exec, fork, reads minus `denyRead`, writes on the listed roots minus the read-only ones,
   `sysctl-read`, a minimal `mach-lookup` list, signals to self/children); never `network*`, `lsopen`, `appleevent-send`, job creation or
   `signal (target others)`. bubblewrap: an explicit root set, `--tmpfs /run --tmpfs /tmp`, `--unshare-ipc --unshare-uts --new-session
   --cap-drop ALL`, a private `XDG_RUNTIME_DIR`. The slot's dependency directories are read-only for agent commands and checks.
2b. **The word "enforced" is earned per platform.** Escape tests S-28 (macOS: `open -a`, `osascript`, signalling the host) and S-29 (Linux:
   `connect()` to a Unix socket outside the worktree) gate it; `probe()` runs the platform's escape self-test, and until it passes `doctor`
   and `SandboxCapabilities` say `partial`, which does not satisfy `native`.
3. **Default `sandbox.require` = `native` when the runtime is a real model runtime and any role holds `run_command`**; otherwise
   `best-effort`. `native` with no usable backend refuses to start with the exact `doctor` remediation.
4. `best-effort` is an explicit, recorded opt-in **of the local user**: it is honoured from the user-scope config, a CLI flag or a trust
   grant, never from the repository's own config file alone (ADR-0026). It still uses a `partial` L1 backend when one exists. Under it, rules flagged `network` are denied, the level is written in the run plan,
   `pipeline.started` and every `tool.started`, and `doctor` states that an allowed command is arbitrary code running as the user.
5. The brain (Pi child) runs under the spike's Seatbelt profile by default on macOS (`sandbox.brain: os-if-available`); Linux and hostname
   filtering are reported `partial`.
6. Network inside the sandbox is `none`; `unrestricted` exists only for Cohorte-run provisioning effects. Host allowlisting needs an egress
   proxy and is V3.2.

## Consequences

- Spec 9's sandbox MUSTs and spec 29 bullet 3 are demonstrable for commands, not only for file tools.
- Linux users without a usable `bwrap` must install it, apply the documented userns remediation, or opt into `best-effort`.
- Two small security-critical generators (profile / argv) must be maintained and golden-tested; CI needs a Linux job with `bubblewrap`.
- A deny-default profile can break a real toolchain (a missing mach service, a tool that needs `/run`): the fixture's real checks run under
  L1 in CI on both OSes, and every widening of the golden profile is a reviewed change — never a fallback to `(allow default)`.
- Fake-runtime CI is unaffected (deterministic scripts, default `best-effort`).

## Revisit when

- Wave-0 probe P3 shows `bwrap` cannot be made to work on mainstream CI/dev Linux without root → reconsider the default, or a different backend.
- Apple removes `sandbox-exec` → move macOS to another mechanism or degrade with a loud capability.
- `@anthropic-ai/sandbox-runtime` reaches a stable, non-singleton API → adopt it behind the existing `SandboxBackend` seam.
- Real projects need network for tests (service containers, registries) → design the egress proxy earlier than V3.2.
