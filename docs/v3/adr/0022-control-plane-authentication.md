# ADR-0022: Control-plane authentication — file modes + HMAC, chain anchors, no root

- **Status:** Provisional
- **Date:** 2026-09-18
- **Covers:** spec 17.2 ("commandes … authentifiées par transport local"), spec 23 ("event forgé", "approvals signées/loggées", "journal
  append-only local", "absence de privilèges root")
- **Design reference:** DESIGN.md §0.3, §2.6.7, §2.3.4, §2.4 (DDL), §7.4 (S-30..S-35, S-72)

## Context

Control goes through a durable command inbox in a SQLite file (ADR-0004). Without a mechanism, any process able to write that file can insert an
`approve`, `skip` or `cancel` command; an unkeyed hash chain detects tampering only if the attacker does not recompute it. The adversary the
spec names is a compromised agent escalating its own privileges. One proposal kept its approval key inside `.cohorte/state`, readable by any
allowed command.

## Decision

1. "Authenticated by local transport" is defined concretely as **file modes + a MAC**. A per-project 32-byte key lives at
   `~/.cohorte/keys/<projectId>-<hash of the git common dir>.key` (`0600`, directory `0700`): outside the repository, outside every executor
   read root, in the brain sandbox's `denyRead`.
2. **Every mutating command** (not only approvals) carries `auth = { scheme: 'hmac-sha256', value: HMAC-SHA256(key, canonical body) }`,
   where the canonical body is the envelope minus `auth`. The wire field is **scheme-neutral** (not `mac`) and `scheme` is an open enum, so
   the asymmetric signatures of "Revisit when" are a MINOR protocol change, not a MAJOR. The run host verifies on claim and again in
   recovery; an unknown scheme, a bad or a missing value is rejected with `security/command-auth-invalid` and never applied. Read-only
   commands need no authenticator. `CommandAuthenticator` signs **bytes** handed in by the caller: `security` names no protocol type.
3. `approval.resolved` records the resolving command's authenticator; `doctor --verify-state` re-verifies every resolved approval.
3b. **Separation of identities** (spec 23): key holders (a human or a client program, as the OS user) produce commands; the system (the
   run host, holding the lease) produces events and `system` transitions and can never produce a command; agents hold nothing and can
   produce neither (test S-36). `actor.kind` is a claim *among key holders*: the CLI stamps `human` only on a TTY without `--yes`, the host
   never upgrades it. Rows of the transition table marked `human` fire only from an accepted command.
4. Each `checkpoint.created` carries a **MAC anchor** over `(runId, atSequence, chainHash)`; `verifyChain` checks anchors when given the key.
5. The events table is append-only by trigger; every write transaction is fenced by the run lease.
6. `run`, `resume` and the run host **refuse uid 0**; no override.
7. **Honest limit, printed by `doctor`:** the MAC authenticates "a process able to read the key as this user". Under L1 that excludes agent
   commands and the sandboxed brain. Under L0 an allowed command runs as the same uid and could read the key — another reason the default is
   `sandbox.require: native` (ADR-0003).

## Consequences

- Forged commands, forged approvals and rewritten histories are detectable and rejected for every adversary the sandbox contains.
- ~150 lines of code and one key file; no asymmetric crypto, no key distribution problem in a single-user local tool.
- Losing the key makes pending commands unverifiable: a new key is generated and old anchors are reported as unverifiable, not as corruption.

## Revisit when

- A remote daemon or multi-user control (V3.2+) arrives → per-actor asymmetric signatures and a real identity model.
- An OS keychain integration is cheap on both platforms → move the key out of the filesystem.
- Evidence that same-uid threats matter more than assumed under L0 → make L1 non-optional for model runtimes.
