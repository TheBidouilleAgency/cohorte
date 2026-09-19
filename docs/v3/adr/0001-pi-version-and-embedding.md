# ADR-0001: Pi version, supported subset and embedding mode

- **Status:** Provisional
- **Date:** 2026-09-18
- **Covers:** spec 31 open question 1; brief D1
- **Design reference:** DESIGN.md §3, §1.2, §1.4

## Context

The Pi package named by the spec (`@mariozechner/pi-coding-agent`) is npm-deprecated and frozen at 0.73.1. The live package is
`@earendil-works/pi-coding-agent` 0.85.1 (Node >= 22.19, roughly weekly releases, breaking changes even in patches; the auth surface was
rewritten around 0.80.8 and the SDK construction surface broke again in 0.84.0). Pi gives no security: built-in tools are unconfined, the
`tool_call` hook is block-only and fail-open by omission, the SDK path trusts project settings by default.

Three embeddings were evaluated with executed evidence on 0.85.1 (two delta reports, two spikes):
A in-process SDK; B `main()` in RPC mode with a forwarding `tool_call` gate and tools in the child; C a Cohorte-owned child per agent that
embeds Pi with only forwarding tools, every effect in the parent.

## Decision

1. Depend on `@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai` and `@earendil-works/pi-agent-core` at **0.85.1 exact**, as direct
   dependencies, with pnpm `overrides` for every `@earendil-works/*` and a start-up assertion that the three versions are equal. Pi is never
   inlined in the bundle.
2. Only `packages/runtime-pi/src/child/**` (and that package's tests) may import Pi; the parent side of `runtime-pi` imports none.
3. **Embedding = candidate C, SDK in the child**: `createAgentSession` + `ModelRuntime.create({ authPath, modelsPath: null,
   allowModelNetwork: false })` — **`refreshOnCreate` is left at its default**: the create-time refresh (offline under `PI_OFFLINE=1` +
   `allowModelNetwork: false`) is what fills the auth snapshot; with `refreshOnCreate: false` `isUsingSubscription()` and
   `getProviderAuthStatus()` stay false/unconfigured (model-runtime.js:51-57, :97-103, :330-338, :411-421) —
   + `SettingsManager.inMemory(…, { projectTrusted: false })` + a literal 11-method `ResourceLoader` + the `tools`
   allowlist + `customTools` that only forward to the parent. Transport = the Node `'ipc'` stdio channel carrying the Cohorte-owned
   `AgentHostProtocol`; the same frames as LF-JSON over fd 3/4 where a sandbox cannot pass the IPC fd.
4. The executed `createAgentSessionRuntime` + `runRpcMode` + `ctx.ui.input` host is the pre-validated fallback, confined to the child directory.
5. Supported Pi subset: the symbols above plus `defineTool`, `SessionManager.open`, the public `Agent` fields `streamFunction`, `onResponse`,
   `shouldStopAfterTurn`, `toolExecution`, `transport` (all assigned before the first `prompt()`), `ModelsError`, pi-ai's `lazyStream` and the
   `SimpleStreamOptions.fetch` seam, and `fauxProvider` / `InMemoryCredentialStore` in tests. The `streamFunction` wrapper is written with
   `lazyStream`: the `StreamFn` contract (pi-agent-core types.d.ts:3-13) forbids throwing or returning a rejected promise. Pi values are
   obtained through one file, `child/load-pi.ts` (the only computed `import()` outside the CLI's lazy loader). Only child code looks at
   engine error classes; it sends an `ErrorSignal` and the Pi-free parent classifies it. No Pi extension, skill, prompt template, settings file, built-in tool or RPC command is used.
   `beforeToolCall`/`afterToolCall` are owned by `AgentSession` and never assigned.

## Consequences

- "Intercept every tool call before execution" (spec 5.2) is fail-closed by construction: nothing executable exists in the child.
- Env isolation, crash containment, a hashable entry and a tight OS sandbox around the LLM loop become possible.
- Cost: ~200 MB RSS and ~330 ms cold start per agent incarnation; default agent concurrency 3.
- A private third contract (`AgentHostProtocol`) must be maintained; a Pi-free fake brain keeps it honest.
- Upgrades are deliberate PRs gated by the conformance suite and the permanent Pi-bump tripwires; a scheduled `pi-latest` job gives early warning.

## Revisit when

- A Pi release breaks the SDK construction surface in a way the child cannot absorb → switch the child to the `runRpcMode` host.
- Upstream ships a supported headless server with typed tool delegation and auth-context injection → re-evaluate B-like shapes.
- Memory per child becomes the limiting factor for real projects (many parallel surfaces) → evaluate loading Pi from `dist/bundle` by default
  (needs proof that OAuth refresh/login work from that layout), or a pooled child.
- Probe A-1 (`streamFunction` wrapper honoured for every request) fails → keep model-boundary pause and request budgets `partial`.
- A tripwire added by the design revision turns red on a Pi bump (`tw-auth-snapshot`, `tw-stream-contract`, `tw-credential-lock`,
  `tw-continuation-note`, `tw-guard-fetch`) → the corresponding statement of DESIGN 3.4/3.7/3.8 is re-verified before the pin moves.
