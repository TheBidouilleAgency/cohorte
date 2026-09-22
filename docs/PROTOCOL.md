# Local protocol

Cohorte exposes JSON-RPC 2.0 using protocol `cohorte/1`. The implemented bridge is
`cohorte rpc --stdio`: UTF-8 JSON Lines, one frame per line, with a 1 MiB frame limit. Clients must
call `initialize` first.

Implemented methods: `health.get`, `projects.list/get/init`, `accounts.list/status`,
`features.list/get`, `runs.start/get/list/export/pause/resume/cancel`, `requests.list/respond`,
`artifacts.get`, `metrics.get`, and `events.subscribe/unsubscribe`. Mutations require a
deduplication identifier. Reusing it with different content is rejected. Events are durable and
replayed by sequence. Account methods expose passive official-client status and never credentials.

`runs.export` returns the run state and its durable events, requests, approvals, tasks, attempts,
sessions, findings, checks, and effects. The RPC export defaults to 512 KiB and cannot exceed
768 KiB, leaving space below the 1 MiB frame limit. `cohorte export RUN_ID --output FILE` provides
the same redacted document with an atomic file replacement and a configurable 1 KiB to 50 MiB
limit. Check output is capped at 256 KiB. Secret-shaped keys, inline assignments, and bearer
credentials are redacted before durable log writes and again at CLI and protocol boundaries.

On POSIX, `cohorte service start` hosts the same protocol on a Unix socket inside the private data
directory. The directory is mode `0700`, the socket and service identity are `0600`, and the host
requires the peer UID to match the service UID (`LOCAL_PEERCRED` on macOS, `SO_PEERCRED` where
available). `service status` performs a real protocol health call and `service stop` uses a
deduplicated RPC shutdown instead of signaling an unverified PID. Each connection has its own
handshake state; disconnecting a client does not change workflow state. On the socket,
`events.subscribe` returns the durable replay and watermark, then emits `events.notification`
frames for later events. A bounded writer timeout disconnects a slow client; it resumes from its
last processed sequence. Replay responses are capped below the transport frame limit and individual
event payloads cannot exceed 512 KiB. The equivalent Windows live-follow behavior remains a later
gate.

The Windows backend is implemented with `pywin32`: a deterministic local named pipe, remote-client
rejection, a DACL containing only the current user SID, and a per-user-session mutex preventing a
second service instance. It shares the same JSON-RPC dispatcher and lifecycle commands. Its runtime
test passes on GitHub-hosted Windows with Python 3.12 and 3.13; this is CI lifecycle evidence rather
than a complete Windows release-support claim.
Live follow is withheld from the Windows capability list until asynchronous slow-writer behavior is
validated on a real Windows host.

Success confirms acceptance of a mutation. It does not claim that a run or external effect has
finished. Structured errors include a stable code, impact, retryability, and remediation.
