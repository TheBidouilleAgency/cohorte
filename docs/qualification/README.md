# AC01–AC30 qualification

The machine-readable source of truth is [`ac-matrix.json`](ac-matrix.json). A criterion is `passed`
only when every behavior required by the complete specification has evidence for its stated
boundary. Engine tests, synthetic native-client tests, and real-account evidence remain distinct.

Current baseline:

| Status | Count |
| --- | ---: |
| Passed | 29 |
| Partial | 1 |
| Blocked | 0 |
| Deferred | 0 |
| Not started | 0 |

François is back in scope. Its existing Cohorte integration was merged in François PR #154, but
targets the earlier TypeScript 3.0.0-dev.8 CLI and is incompatible with this Python runtime's
`cohorte/1` protocol. The external client and UI remain unqualified against the Python service;
see `docs/evidence/g5-ac19-francois-current-integration.json`. AC14 now passes on a
disposable GitLab repository: Cohorte committed and pushed a candidate, opened an MR with
configured release notes, and refreshed its successful CI pipeline. The first diagnostic MR
failed because GitLab required account identity verification; it was closed without merge.
See `docs/evidence/g5-ac14-gitlab-darwin-arm64.json`. Isolated native Claude
and Codex profiles passed passive subscription status and live SDK probes. A newly connected Claude
account also passed a structured read, a workspace edit and an observed denial of an outside write.
AC03 passes at the runtime-reported subscription boundary. AC02 now passes: both
`cohorte auth login` handoffs completed through the official provider CLIs, and concurrent
handoffs on each native context rejected the second process with `AUTH_BUSY` while the first
provider CLI was active. No credentials were copied into Cohorte; the earlier organization-policy
refusal remains historical evidence for the previous Claude account.
AC27 is qualified with bounded, redacted check logs and atomic CLI/RPC run exports. AC28 now
classifies missing dependencies, unavailable container runtimes, network outages, and full disks as
retryable environment failures while preserving durable state. AC29 now covers protocol versions,
invalid and oversized frames, concurrent mutation deduplication, bounded replay, and slow-client
reconnection without cursor gaps. AC04, AC11, AC16, and AC17 now cover provider suspension,
bounded overload retry, reviewer death, hard controller crashes, active-wave pause, descendant
interruption, and uncertain termination. AC30 now passes on the pinned Darwin runtime: two
agent-driven file edits outside a workspace failed, and two separate reviewer-style read-only
turns emitted denied command events without permission escalation. The earlier reviewer probe
that emitted no mutation event remains inconclusive; model text and marker absence alone are not
accepted as proof. Live provider behavior on other operating systems is still unqualified.
AC23 now handles missing connections at the CLI and runtime failures in design/retrieval ports:
design capture blocks, retrieval blocks or uses only an explicitly enabled file fallback, and
provider error text is redacted. An installed Serena MCP server returned a real hit from a
disposable source project without modifying it, and Cohorte CLI retrieval reported Serena as its
effective provider. Graphify-Labs 0.9.66 also returned a real file/line hit through Cohorte CLI
from a prebuilt local code-only graph. A user-run Cohorte CLI probe captured a real Figma test
file, while an agent-run request with an invalid token returned an explicit HTTP 403 block and no
content. Live Graphify/Serena process outages, larger projects, and a Figma probe with a
least-privilege token remain outside the AC23 passed boundary and remain open for hardening.
AC06 now has live evidence from three independent Codex perspective sessions plus a separate
synthesis session in a synthetic read-only repository; contributions, disagreements and the user
answer are content-addressed in SQLite. AC07 validates completeness and references, derives the
covered task plan, and requires a user approval bound to the exact final frozen-spec hash.
AC26 qualifies an installed wheel upgrade from 0.1.0a1 to 0.1.0a2 on the six hosted CI
OS/Python combinations. It checks preserved user configuration and project data, the schema 1→2
migration with backup, and refusal of a future schema by the older installed binary. This does
not certify a published release or real-host support.
