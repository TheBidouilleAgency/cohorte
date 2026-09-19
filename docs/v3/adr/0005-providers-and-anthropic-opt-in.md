# ADR-0005: Providers and models at launch; the Anthropic-via-Pi opt-in is accounted as metered

- **Status:** Provisional — the Anthropic treatment needs the human's sign-off
- **Date:** 2026-09-18
- **Covers:** spec 31 open question 5; brief D2
- **Design reference:** DESIGN.md §3.7, §2.10, §11 D-5

## Context

Spec 10.1 asks for ChatGPT Plus/Pro and Claude Pro/Max subscriptions through Pi OAuth and forbids turning a subscription into API billing
without explicit consent. Evidence on 0.85.1: `openai-codex` is OAuth-only by declaration (env, a stored api_key and a request override all
resolve to undefined). Under Anthropic OAuth, pi-ai presents itself as Claude Code; Anthropic's terms reserve subscription OAuth for
first-party clients; and **Pi's own documentation says third-party harness usage "draws from extra usage and is billed per token, not against
Claude plan limits"** (`docs/providers.md:35`). Pi flags Anthropic OAuth as `isSubscription: true` regardless. The 0.73.1-era Codex model ids
no longer exist; the 0.85.1 catalogue has `gpt-5.3-codex-spark`, `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.5`, `gpt-5.6-*`, `gpt-6-astra`.

## Decision

1. **One officially supported real provider in V3.0: `openai-codex`** via Pi OAuth, accounted `authMode: subscription`,
   `monetaryCost: not_applicable`.
2. Tier defaults live in `providers/src/catalogue.ts` and are validated fail-closed at run start: `coding` and `reasoning` → `gpt-5.5`
   (thinking `medium` / `high`), `fast` and `cheap` → `gpt-5.4-mini`. Tool-calling variation is absorbed by one flat tool schema, strict
   host-side validation, sequential execution and `constrainedSampling: prefer` on the result tool.
3. **Anthropic-via-Pi stays a D2 opt-in but is accounted as metered**: it requires
   `authentication.anthropicSubscriptionViaPi.{enabled, acknowledgePerTokenBilling, acknowledgeProviderTermsRisk}` all true, is recorded as
   `authMode: api` / `billing: metered`, always carries a cost (never `not_applicable`), appears in `RunPlan.meteredProviders`, opens an
   `api-billing` approval at run start, and `doctor`/`auth status` print both caveats. Cohorte implements no identity spoofing itself.
4. Cohorte stamps accounting from **its own billing table**, never from Pi's `isSubscription` flag or pi-ai's catalogue cost.
5. API-key mode is an explicit opt-in (`authentication.allowApiKeys`), visible in the plan, never automatic.
6. The sanctioned future path for Claude subscriptions is a second `AgentRuntime` on the Claude Agent SDK (V3.2+): mentioned, not built.
7. **Where an engine may be named.** The config keys `runtime.pi.*` and `authentication.anthropicSubscriptionViaPi` keep their names: a
   project's config legitimately names the engine it configures, and "via Pi" is exactly the information the terms caveat needs. The
   "no Pi identifier" rule (R10, spec 17, AC-07) is about the **protocol**: the identifier scan of gate G0 and of AC-07 covers the schemas
   generated from `@cohorte/protocol` and `@cohorte/runtime-contract` (events, commands, run-state, agent-output, the `--json` documents),
   **not** `schemas/config.schema.json` — scanning every file under `schemas/` would have made G0 red by construction. The alternative
   (engine-neutral key names such as `runtime.engineOptions.loadFrom`, `authentication.meteredOAuth.anthropic`) was rejected: it hides
   from the human which harness carries the OAuth session.
8. The opt-in block, `allowApiKeys` and any unattended pre-authorisation of the `api-billing` approval are **loosening keys**: they take
   effect only with the local user's consent, never from the repository file alone (ADR-0026).

## Consequences

- Spec 10.1's "Claude Pro/Max" support is narrowed in V3.0 (listed as deviation D-5).
- No path exists by which a user believes they are on plan limits while being billed per token.
- A minimal versioned price catalogue ships even though the nominal path never uses it.
- The metered legs are implemented and tested against fakes only; they are not exercised live in V3.0.

## Revisit when

- Anthropic or Pi change terms/billing so that third-party OAuth draws from plan limits → the billing table row changes, nothing else.
- The human prefers "not selectable in V3.0" → remove the config block; the design is otherwise unchanged.
- A Claude Agent SDK runtime is scheduled → it supersedes this opt-in for Claude subscriptions.
- OpenAI changes its tolerance of third-party harnesses, or the Codex catalogue changes → update the tier table behind the pin.
