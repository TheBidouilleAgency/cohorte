# AC01–AC30 qualification

The machine-readable source of truth is [`ac-matrix.json`](ac-matrix.json). A criterion is `passed`
only when every behavior required by the complete specification has evidence for its stated
boundary. Engine tests, synthetic native-client tests, and real-account evidence remain distinct.

Current baseline:

| Status | Count |
| --- | ---: |
| Passed | 25 |
| Partial | 5 |
| Blocked | 0 |
| Deferred | 0 |
| Not started | 0 |

François is back in scope; its external client and UI remain unqualified. Isolated native Claude
and Codex profiles passed passive subscription status and live SDK probes. A newly connected Claude
account also passed a structured read, a workspace edit and an observed denial of an outside write.
AC03 passes at the runtime-reported subscription boundary. AC02 remains partial because login was
user-assisted through the official CLIs, the new Cohorte CLI handoff lacks end-to-end evidence, and
its native login lock lacks a simultaneous real-provider-CLI probe. The earlier organization-policy refusal remains
historical evidence for the previous account.
AC27 is qualified with bounded, redacted check logs and atomic CLI/RPC run exports. AC28 now
classifies missing dependencies, unavailable container runtimes, network outages, and full disks as
retryable environment failures while preserving durable state. AC29 now covers protocol versions,
invalid and oversized frames, concurrent mutation deduplication, bounded replay, and slow-client
reconnection without cursor gaps. AC04, AC11, AC16, and AC17 now cover provider suspension,
bounded overload retry, reviewer death, hard controller crashes, active-wave pause, descendant
interruption, and uncertain termination. AC30 remains partial: two direct app-server commands
were denied by the read-only sandbox and two agent-driven file edits outside the workspace emitted
failed events. The read-only reviewer emitted no mutation event, so model text and marker absence
cannot certify that role.
AC23 now handles missing connections at the CLI and runtime failures in design/retrieval ports:
design capture blocks, retrieval blocks or uses only an explicitly enabled file fallback, and
provider error text is redacted. Real Figma, Serena and Graphify snapshots and outages remain
unqualified.
AC06 now has live evidence from three independent Codex perspective sessions plus a separate
synthesis session in a synthetic read-only repository; contributions, disagreements and the user
answer are content-addressed in SQLite. AC07 validates completeness and references, derives the
covered task plan, and requires a user approval bound to the exact final frozen-spec hash.
AC26 qualifies an installed wheel upgrade from 0.1.0a1 to 0.1.0a2 on the six hosted CI
OS/Python combinations. It checks preserved user configuration and project data, the schema 1→2
migration with backup, and refusal of a future schema by the older installed binary. This does
not certify a published release or real-host support.
