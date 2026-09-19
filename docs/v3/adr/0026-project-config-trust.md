# ADR-0026: Project-config trust — what the repository may decide, and what only the local user may decide

- **Status:** Provisional — the first-run prompt needs the human's awareness
- **Date:** 2026-09-18
- **Covers:** spec 10.1 ("jamais activé automatiquement", "sans consentement explicite"), spec 14 (`config.yaml` is versioned), spec 23
  (prompt injection in the repository, supply chain, abusive escalation)
- **Design reference:** DESIGN.md §2.10.1, §0.3, §2.5.1 (T04 guard `config.trust-satisfied`), §3.7, §7.4 (S-37, S-38), §11 D-26

## Context

`.cohorte/config.yaml` is a versioned file: a cloned hostile repository, or a teammate's commit, writes it. As first designed, every
security-lowering switch was honoured from it: `sandbox.require: best-effort` (an allowed command then runs as the user, with the network
and the OAuth token in reach), `policy.commands.allow` and `policy.dangerousCommands` (arbitrary exact-argv commands), `checks.*` and
`provision.argv` (commands Cohorte itself runs), `authentication.allowApiKeys` and the Anthropic opt-in (per-token billing),
`policy.admin.runTool`, `policy.steer`, the unattended pre-authorisation of the `api-billing` approval, `provision.network`. None of that is
the local user's explicit consent, which spec 10.1 requires for billing and which DESIGN 0.3 had promised for `best-effort`. Pi has a
project-trust gate; Cohorte had none.

## Decision

1. Every config key has a **trust class**, frozen as data beside the schema (`CONFIG_KEY_TRUST`): `tighten-only` (the project file is
   honoured only when at least as strict as the layer below), `loosen` (honoured only with the local user's consent), `neutral`.
2. **Loosening keys**: `sandbox.require: best-effort`, `sandbox.brain: process`, `authentication.allowApiKeys`,
   `authentication.anthropicSubscriptionViaPi.*`, additions to `routing.allowedProviders`, `routing.fallback.enabled`,
   `policy.commands.allow`, `policy.dangerousCommands`, `policy.symlinks` towards `allow`, `policy.admin.runTool`, `policy.steer.enabled`,
   `policy.skip`, `policy.inDoubt: continue`, `policy.approvals.{unattended: wait, ship: auto, autoResume}` and any unattended
   pre-authorisation, `checks.*`, `provision.{argv, network, env, cacheDirs, writableCaches, dependencyDirs}`, `network.proxyEnv`,
   `runtime.pi.loadFrom`, `git.worktreeRoot`.
3. **Consent has three forms**, recorded in `RunPlan.trust.grantedBy` and therefore in `pipeline.started`: `user-config` (the same or a
   looser value in `~/.cohorte/config.yaml`), `cli-flag` (given on this run's command line; `--trust-project-config` for CI images that own
   their repository), `trust-record` (trust on first use).
4. **Trust on first use** is bound to a hash: `policySha256 = sha256(canonicalJson(project-file values of every loosen-class key +
   ownership.yaml))`, stored in `~/.cohorte/trust/<projectKeyId>.json` (MAC'd with the project key, `0700`/`0600`, a protected root, in
   every `denyRead` set). On a miss the CLI prints the diff of loosening keys against the last trusted value and asks; `cohorte config
   trust --show|--grant|--revoke` does it outside a run. Any later edit of a loosening key changes the hash and asks again; tightening
   never asks.
5. **No answer means no run**: without a TTY, with `--json` and no flag, or unattended, the CLI fails closed with
   `security/project-policy-untrusted` before a run row exists. The host re-checks at T04, because it is the host that resolves the config
   into the run snapshot.

## Consequences

- A repository cannot downgrade its cloner's sandbox, allow itself commands, switch billing mode, or pre-approve anything.
- The first run on a project that sets loosening keys asks once; in practice every real project does (`checks`, `policy.commands.allow`),
  so the prompt is part of onboarding and must print a short, readable diff.
- CI needs either the flag or a user-scope config in the image. E2E and dogfood harnesses pass the flag.
- One more file under `~/.cohorte` and one more guard in T04; the classification table must be kept total (a unit test enumerates the schema).
- Honest limit, same as ADR-0022: under L0 an allowed command runs as the user and could write a trust record; under L1 it cannot.

## Revisit when

- Users find the prompt noisy for keys that are harmless in their setup → split a key's class by value (already the case for
  `sandbox.require`), never by disabling the mechanism.
- A team wants shared, reviewed trust (a signed policy file) → asymmetric signatures, together with ADR-0022's per-actor identity.
- `ownership.yaml` widening turns out to need the same treatment as a first-class citizen → it is already part of the hash; give it its own
  diff in the prompt.
