# AC01–AC30 qualification

The machine-readable source of truth is [`ac-matrix.json`](ac-matrix.json). A criterion is `passed`
only when every behavior required by the complete specification has evidence for its stated
boundary. Engine tests, synthetic native-client tests, and real-account evidence remain distinct.

Current baseline:

| Status | Count |
| --- | ---: |
| Passed | 21 |
| Partial | 6 |
| Blocked | 1 |
| Deferred | 1 |
| Not started | 1 |

François is explicitly deferred. Claude account qualification blocks AC02 and keeps AC03 partial.
AC27 is qualified with bounded, redacted check logs and atomic CLI/RPC run exports. AC28 now
classifies missing dependencies, unavailable container runtimes, network outages, and full disks as
retryable environment failures while preserving durable state. AC29 now covers protocol versions,
invalid and oversized frames, concurrent mutation deduplication, bounded replay, and slow-client
reconnection without cursor gaps. AC04, AC11, AC16, and AC17 now cover provider suspension,
bounded overload retry, reviewer death, hard controller crashes, active-wave pause, descendant
interruption, and uncertain termination. AC30 remains partial because the live permission probe
emitted no command or auto-review event; model text is not treated as proof.
