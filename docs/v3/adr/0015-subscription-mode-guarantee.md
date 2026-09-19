# ADR-0015: Subscription-mode guarantee — six layers, and the secret-bearing Pi calls are banned

- **Status:** Provisional
- **Date:** 2026-09-18
- **Covers:** brief D3; spec 10.1 MUSTs
- **Design reference:** DESIGN.md §3.7, §1.2 (check-layers rule e), §7.4 (S-40..S-46)

## Context

Evidence on 0.85.1: a stored credential now owns its provider (no silent env fallback after a failed refresh), but "nothing stored + an env key
⇒ paid API" is unchanged for every api-key provider, and `ModelRuntime` exposes no injectable auth context — the only structural defence is a
process with an allowlisted environment. `readStoredCredential()` returns the full `Credential` (OAuth `access` and `refresh` tokens);
`getAuth()` returns the bearer; `pi auth print-bearer-token` prints it; `login()` returns a `Credential`. pi-ai always computes a catalogue
cost, even under OAuth. Refresh/login error text can embed provider response bodies.

## Decision

Defence in depth, each layer with a test:

1. **Allowlisted child environment** (no `*_API_KEY`, `*_TOKEN`, `AWS_*`, `GOOGLE_*`, `GH_*`, …); the child attests the *names* it sees and
   the parent requires them to lie in `allow ∪ OS_INJECTED_ENV[platform]` (macOS injects `__CF_USER_TEXT_ENCODING` into every process:
   verified; an exact-equality check would refuse every spawn there).
2. **Cohorte-owned Pi agent dir** (no `models.json`, settings, trust file or extensions); only `authPath` points at the user's Pi store, which
   Cohorte never copies or rewrites (shared login with François).
3. **Typed, secret-free pre-spawn check, decided on live calls**: `(await checkAuth(p))?.type === 'oauth'` ∧ `(await listCredentials())`
   contains `{ providerId: p, type: 'oauth' }` ∧ `getProvider(p).auth.apiKey === undefined` for `openai-codex`. The snapshot accessors
   `isUsingSubscription()` / `getProviderAuthStatus()` are **cross-checks only**, read after an explicit `refresh({ providers: [p],
   allowNetwork: false })`: they are empty until a refresh and stale afterwards (delta hazard H-4), which is also why `ModelRuntime.create`
   is called **without** `refreshOnCreate: false`. A credential-store lock is transient, never `AUTH_REQUIRED` — and the classifier does not
   take `ModelsError.code` at face value: `auth` also means "Credential store read/modify failed", `oauth` also wraps a network timeout
   (DESIGN 3.8).
4. **Explicit model, provider allowlist, pinned `baseUrl`**; any model fallback is fatal.
5. **Per-request evidence** asserted in the parent: a production **guard fetch**, installed through the executed `options.fetch` seam,
   requires the request origin to equal the pinned `baseUrl` origin, refuses `x-api-key`/`api-key` headers, and reports
   `{ origin, authScheme }` (never a header value) for every request. Comparing `effectiveModel`/`authSource` alone would be an echo of the
   child's own static data; it remains as a secondary check. A contradiction blocks the run.
6. **Cohorte stamps accounting itself** from its own billing table (ADR-0005); pi-ai's cost is dropped at the child boundary.

**Banned in Cohorte code, enforced by `check-layers`:** `readStoredCredential`, `modelRuntime.getAuth(`, `pi auth print-*`; `login()`'s return
value is dropped unread. Every error text coming from the child is sealed by the parent before it becomes an event or a log line. `pi` and
`cohorte` are non-overridable denied programs for agents.

## Consequences

- "Verify the authentication state without reading or exporting the token" (spec 10.1) holds literally.
- A user with only an API key in the environment gets `AUTH_REQUIRED`, never a silent paid run.
- **Spec 10.1's "compte/tenant non secret" is not shown for Pi 0.85.1** (deviation D-24): the account id is reachable only through the
  banned `readStoredCredential()`; `auth status` and `doctor` print `account: not exposed by the engine` and `authStatusWithoutSecret` is
  reported `partial`. An audited single-file exception was considered and rejected: a label is not worth a token-bearing object in
  Cohorte's address space.

## Revisit when

- Pi exposes an injectable auth context or a typed billing statement → layers 1 and 6 can be simplified (never removed without tests).
- Pi exposes a metadata-only credential accessor → populate `accountLabel` and close D-24.
- Probe A-5 (cross-process lock on OAuth refresh) fails → serialise refresh through one auth child.
- A second runtime arrives → the six layers become conformance requirements of `AgentRuntimeProvider`.
