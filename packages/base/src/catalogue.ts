import { ERROR_CLASSES, type ErrorClass } from './errors.ts';

/** DESIGN 2.8, column "CLI exit": the exit code of a process that waited for a run which ended on an error of that class. */
export const EXIT_CODE_BY_CLASS: Readonly<Record<ErrorClass, number>> = Object.freeze({
  configuration: 10,
  validation: 11,
  permission: 12,
  security: 13,
  'provider-transient': 14,
  'provider-terminal': 14,
  'tool-transient': 15,
  'tool-terminal': 15,
  conflict: 16,
  budget: 17,
  timeout: 18,
  corruption: 19,
  'human-required': 20,
});

export interface ErrorCatalogueEntry {
  class: ErrorClass;
  retryable: boolean;
  impact: string;
  remediation: string;
  exit: number;
}

interface Row<C extends string> {
  readonly code: C;
  readonly retryable: boolean;
  readonly impact: string;
  readonly remediation: string;
}

const RETRY = true;
const NO_RETRY = false;

const row = <const C extends `${ErrorClass}/${string}`>(
  code: C,
  retryable: boolean,
  impact: string,
  remediation: string,
): Row<C> => ({
  code,
  retryable,
  impact,
  remediation,
});

/**
 * APPEND-ONLY. A code is a public, stable identifier (spec 24): never rename one, never remove one, never move one
 * to another class; add new rows at the END of their class block. `impact` says what the error means for the run,
 * `remediation` is the imperative next action (spec 21). Every `<class>/unexpected` row is the landing place of a
 * throwable nobody classified (DESIGN 2.8) and is never retried.
 */
export const ERROR_CATALOGUE_ROWS = [
  // configuration — refuse to start / FAILED
  row(
    'configuration/policy-invalid',
    NO_RETRY,
    'The security policy is missing or cannot be parsed, so nothing may execute and the run does not start.',
    'Fix the policy keys named in the message in .cohorte/config.yaml, then run `cohorte doctor`.',
  ),
  row(
    'configuration/phase-not-available',
    NO_RETRY,
    'The requested phase or pipeline profile is not part of this version, so the run does not start.',
    'Choose a profile that `cohorte doctor` lists as available, or upgrade Cohorte.',
  ),
  row(
    'configuration/incompatible-state-schema',
    NO_RETRY,
    'The state database was written by an incompatible Cohorte version and is left untouched.',
    'Run the Cohorte version named in the message, or back up the state and run `cohorte migrate --apply`.',
  ),
  row(
    'configuration/platform-unsupported',
    NO_RETRY,
    'This operating system or architecture cannot provide what the configuration requires, so the run does not start.',
    'Run on a supported platform, or relax the requirement named in the message in your user configuration.',
  ),
  row(
    'configuration/telemetry-remote-unavailable',
    NO_RETRY,
    'Remote telemetry is configured but does not exist in this version; nothing was sent.',
    'Remove the remote telemetry settings; local logs and metrics stay available.',
  ),
  row(
    'configuration/worktree-root-protected',
    NO_RETRY,
    'The configured worktree root lies inside a protected directory, so no worktree can be created there.',
    'Set git.worktreeRoot to a directory outside the protected roots, or remove the setting to use the default.',
  ),
  row(
    'configuration/provision-store-unavailable',
    NO_RETRY,
    'Dependencies cannot be provisioned offline because the package manager store is not reachable.',
    'Populate the package manager store (install once with network access), then start the run again.',
  ),
  row(
    'configuration/engine-init',
    NO_RETRY,
    'The agent runtime could not initialise its model engine, so the agent never started.',
    'Run `cohorte doctor` and fix the provider or model configuration it reports.',
  ),
  row(
    'configuration/fake-script-unmatched',
    NO_RETRY,
    'The fake runtime script has no entry for this spawn request, so the scripted run cannot continue.',
    'Add a matching entry to the fake runtime script, or correct the spawn fields it matches on.',
  ),
  row(
    'configuration/unexpected',
    NO_RETRY,
    'An unclassified configuration failure stopped the run before or while it started.',
    'Read the message, run `cohorte doctor`, and report the error if the configuration looks correct.',
  ),

  // validation — agent failed, retry policy, then FAILED
  row(
    'validation/tool-input',
    NO_RETRY,
    'A tool call did not match the input schema of the tool and was not executed.',
    'Nothing to do if the agent recovers; otherwise inspect the rejected call with `cohorte logs`.',
  ),
  row(
    'validation/agent-output',
    NO_RETRY,
    'The final output of the agent does not match the schema of its phase, so it cannot be used.',
    'Inspect the agent transcript; retry the phase or escalate the model tier.',
  ),
  row(
    'validation/agent-no-result',
    NO_RETRY,
    'The agent stopped without delivering a structured result, so its phase has no outcome.',
    'Retry the phase; if it repeats, inspect the transcript and escalate the model tier.',
  ),
  row(
    'validation/spec',
    NO_RETRY,
    'The spec file is invalid, so the run cannot be planned from it.',
    'Fix the fields named in the message in the spec file, then start the run again.',
  ),
  row(
    'validation/invalid-id',
    NO_RETRY,
    'A value is not a well-formed identifier of the expected kind and was refused before reaching a path, a ref or the store.',
    'Pass an identifier of the shape named in the message, as printed by `cohorte status`.',
  ),
  row(
    'validation/unexpected',
    NO_RETRY,
    'An unclassified validation failure made a value unusable.',
    'Read the message, inspect the offending input with `cohorte logs`, and report the error if the input looks valid.',
  ),

  // permission — tool.denied; repeated => policy-violation
  row(
    'permission/tool-not-granted',
    NO_RETRY,
    'The agent called a tool its role was not granted; the call was denied and nothing executed.',
    'Nothing to do if the agent adapts; grant the tool to the role in the configuration if the call was legitimate.',
  ),
  row(
    'permission/path-outside-grant',
    NO_RETRY,
    'The agent addressed a path outside what its grant allows; the call was denied and nothing was read or written.',
    'Nothing to do if the agent adapts; widen the ownership of the surface if the path legitimately belongs to it.',
  ),
  row(
    'permission/command-not-allowed',
    NO_RETRY,
    'The command is not in the allowlist of the command policy; it was denied and nothing executed.',
    'Add a rule for the command to the command policy if it is legitimate, then resume.',
  ),
  row(
    'permission/network-denied',
    NO_RETRY,
    'The call needs network access, which agents never have in this version; it was denied.',
    'Provide what the agent needed locally, for example through provisioning, then resume.',
  ),
  row(
    'permission/denied-by-human',
    NO_RETRY,
    'A human denied the approval request; the call was not executed.',
    'Nothing to do; approve a new request if the denial was a mistake.',
  ),
  row(
    'permission/unexpected',
    NO_RETRY,
    'An unclassified permission failure denied the call; nothing executed.',
    'Read the message and inspect the denied call with `cohorte logs`.',
  ),

  // security — BLOCKED, agents cancelled, worktrees frozen
  row(
    'security/symlink-escape',
    NO_RETRY,
    'A path resolves through a symbolic link to a location outside its allowed root; the run is blocked and its worktrees are frozen.',
    'Inspect the link named in the message, remove it if it is hostile, then acknowledge with `cohorte resume --ack`.',
  ),
  row(
    'security/protected-path',
    NO_RETRY,
    'The agent targeted a protected path such as .git, .cohorte or a credential file; the run is blocked.',
    'Inspect the attempted call with `cohorte logs`, then acknowledge with `cohorte resume --ack` or cancel the run.',
  ),
  row(
    'security/write-outside-ownership',
    NO_RETRY,
    'Changes were found outside the ownership of the surface that produced them; they are not integrated and the run is blocked.',
    'Inspect the diff of the frozen worktree, revert or re-assign the files, then acknowledge with `cohorte resume --ack`.',
  ),
  row(
    'security/runtime-pin-mismatch',
    NO_RETRY,
    'The installed runtime no longer matches the pin taken when the run started; no agent is spawned.',
    'Reinstall the pinned Cohorte and runtime versions named in the message, then resume.',
  ),
  row(
    'security/asset-hash-mismatch',
    NO_RETRY,
    'An embedded prompt, skill, schema or migration does not match its recorded hash; the installation is not trusted.',
    'Reinstall Cohorte from the registry and compare with `cohorte doctor`.',
  ),
  row(
    'security/pin-tampered',
    NO_RETRY,
    'The recorded runtime pin or run snapshot was modified after the run started; the run is blocked.',
    'Inspect the run directory for tampering; start a new run if the snapshot cannot be trusted.',
  ),
  row(
    'security/runtime-inside-target',
    NO_RETRY,
    'Cohorte is running from inside the repository it would modify, so agents could rewrite their own supervisor; the run does not start.',
    'Run an installed Cohorte that lives outside the target repository.',
  ),
  row(
    'security/auth-mode-violation',
    NO_RETRY,
    'A request was about to use another billing mode than the one the run plan allows; it was stopped before leaving the machine.',
    'Check the provider authentication with `cohorte auth status`; opt in to metered billing explicitly if that is intended.',
  ),
  row(
    'security/auth-endpoint-mismatch',
    NO_RETRY,
    'The provider endpoint differs from the pinned one for this authentication mode; no credential was sent.',
    'Remove the endpoint override, or pin the endpoint in your user configuration if it is legitimate.',
  ),
  row(
    'security/command-auth-invalid',
    NO_RETRY,
    'A control command carried a missing, unknown or wrong authenticator; it was rejected and never applied.',
    'Send the command again through the `cohorte` CLI as the user who owns the project key.',
  ),
  row(
    'security/event-chain-broken',
    NO_RETRY,
    'The event history of the run fails its hash chain or anchor check, so it may have been rewritten; the run is blocked.',
    'Inspect the state database and its backups; never delete the run, restore a verified backup instead.',
  ),
  row(
    'security/root-refused',
    NO_RETRY,
    'Cohorte refuses to run as root; nothing was started.',
    'Run Cohorte as an unprivileged user.',
  ),
  row(
    'security/sandbox-unavailable',
    NO_RETRY,
    'The required operating-system sandbox is not available, so commands would run unconfined; the run does not start.',
    'Follow the sandbox remediation printed by `cohorte doctor`, or opt in to best-effort isolation in your user configuration.',
  ),
  row(
    'security/secret-staged',
    NO_RETRY,
    'A secret was detected in the changes about to be committed; the commit was not created and the run is blocked.',
    'Remove the secret from the worktree and rotate it, then acknowledge with `cohorte resume --ack`.',
  ),
  row(
    'security/command-trampoline',
    NO_RETRY,
    'The command would launch another program on behalf of the agent (a shell, an interpreter flag, an exec wrapper); it was denied.',
    'Inspect the attempted command with `cohorte logs`; expose the real program through the command policy if it is legitimate.',
  ),
  row(
    'security/project-policy-untrusted',
    NO_RETRY,
    'The configuration of the repository loosens security settings that only the local user may loosen; the run does not start.',
    'Review the keys named in the message, then grant them with `cohorte config trust` or set them in your user configuration.',
  ),
  row(
    'security/deps-tampered',
    NO_RETRY,
    'Provisioned dependencies changed after they were installed and sealed; the run is blocked.',
    'Inspect the slot named in the message, then provision it again from the lockfile.',
  ),
  row(
    'security/review-ref-mutated',
    NO_RETRY,
    'The immutable ref under review changed while it was being reviewed; the review result cannot be trusted.',
    'Inspect who moved the ref, then run the review again on a fresh ref.',
  ),
  row(
    'security/command-global-option',
    NO_RETRY,
    'The command carries a global option that redirects the program (for git: -C, -c, --git-dir, --work-tree); it was denied.',
    'Inspect the attempted command with `cohorte logs`; no configuration allows these options.',
  ),
  row(
    'security/gate-internal-error',
    NO_RETRY,
    'A stage of the permission gate failed unexpectedly; the call was denied because the gate fails closed.',
    'Report the error with the run logs; resume once the cause is understood.',
  ),
  row(
    'security/redaction-failed',
    NO_RETRY,
    'The redactor failed on an event; the payload was dropped instead of being stored unredacted.',
    'Report the error with the run logs; the dropped payload is not recoverable.',
  ),
  row(
    'security/unexpected',
    NO_RETRY,
    'An unclassified security failure blocked the run; its worktrees are frozen.',
    'Inspect the run with `cohorte logs` before acknowledging with `cohorte resume --ack`.',
  ),

  // provider-transient — bounded, visible retry, then FAILED
  row(
    'provider-transient/rate-limited',
    RETRY,
    'The provider is rate limiting requests; the request is retried with a bounded back-off.',
    'Nothing to do; if it persists, lower the agent concurrency or wait for the limit to reset.',
  ),
  row(
    'provider-transient/overloaded',
    RETRY,
    'The provider is overloaded or returned a server error; the request is retried with a bounded back-off.',
    'Nothing to do; check the status page of the provider if it persists.',
  ),
  row(
    'provider-transient/network',
    RETRY,
    'The connection to the provider failed; the request is retried with a bounded back-off.',
    'Check the network connection and any proxy settings if it persists.',
  ),
  row(
    'provider-transient/credential-store-locked',
    RETRY,
    'The credential store is locked by another process; the request is retried shortly.',
    'Close other programs that use the same login if it persists.',
  ),
  row(
    'provider-transient/unexpected',
    NO_RETRY,
    'An unclassified provider failure interrupted a model request; it is not retried because its cause is unknown.',
    'Read the message, then resume the run; report the error if it repeats.',
  ),

  // provider-terminal — FAILED, or AUTH_REQUIRED / QUOTA_EXCEEDED
  row(
    'provider-terminal/auth-required',
    NO_RETRY,
    'The provider needs a new login; the run is suspended until authentication is restored.',
    'Run `cohorte auth login`, then `cohorte resume`.',
  ),
  row(
    'provider-terminal/quota-exceeded',
    NO_RETRY,
    'The plan limit of the provider is reached; the run is suspended until the quota resets.',
    'Wait for the reset time shown by `cohorte status`, then resume; automatic resume does it when enabled.',
  ),
  row(
    'provider-terminal/entitlement',
    NO_RETRY,
    'The account is not entitled to this model or usage; the request cannot succeed as configured.',
    'Choose a model your plan includes, or change the plan with the provider.',
  ),
  row(
    'provider-terminal/model-not-found',
    NO_RETRY,
    'The configured model does not exist for this provider; the agent cannot start.',
    'Correct the model in the tier table of the configuration; `cohorte doctor` lists the known models.',
  ),
  row(
    'provider-terminal/policy-refused',
    NO_RETRY,
    'The provider refused the request under its usage policies; repeating it unchanged will not help.',
    'Inspect the refused request in the transcript and rephrase the task or the spec.',
  ),
  row(
    'provider-terminal/unexpected',
    NO_RETRY,
    'An unclassified provider failure ended a model request for good.',
    'Read the message and the transcript; report the error if the request looks valid.',
  ),

  // tool-transient — retry once, then report to the agent
  row(
    'tool-transient/spawn-failed',
    RETRY,
    'The process of a tool could not be started; the call is retried once.',
    'Check that the program exists on the pinned PATH reported by `cohorte doctor` if it persists.',
  ),
  row(
    'tool-transient/interrupted',
    RETRY,
    'A tool call was interrupted before it finished, for example by a host restart; it is replayed when that is safe.',
    'Nothing to do; inspect the effect journal with `cohorte inspect` if the call is reported in doubt.',
  ),
  row(
    'tool-transient/agent-process-exit',
    RETRY,
    'The process of the agent exited without settling; a fresh incarnation takes over from the file ledger.',
    'Nothing to do; check the memory and the logs of the machine if it repeats.',
  ),
  row(
    'tool-transient/cancelled',
    RETRY,
    'The tool call was cancelled before it finished because its agent or its run was paused or cancelled.',
    'Nothing to do; resume the run to let the agent issue the call again.',
  ),
  row(
    'tool-transient/unexpected',
    NO_RETRY,
    'An unclassified failure interrupted a tool call; it is not retried because its cause is unknown.',
    'Read the message and inspect the call with `cohorte logs`; report the error if it repeats.',
  ),

  // tool-terminal — error result to the agent
  row(
    'tool-terminal/nonzero-exit',
    NO_RETRY,
    'The command exited with a non-zero status; the result was handed to the agent.',
    'Nothing to do; the agent sees the output and decides what to do next.',
  ),
  row(
    'tool-terminal/output-cap',
    NO_RETRY,
    'The output of the tool exceeded its cap and was truncated or the process was stopped.',
    'Nothing to do; narrow the command if the agent keeps hitting the cap.',
  ),
  row(
    'tool-terminal/patch-preimage-mismatch',
    NO_RETRY,
    'The file no longer matches the content the patch was written against; nothing was written.',
    'Nothing to do; the agent must read the file again before patching it.',
  ),
  row(
    'tool-terminal/unexpected',
    NO_RETRY,
    'An unclassified failure ended a tool call; an error result was handed to the agent.',
    'Read the message and inspect the call with `cohorte logs`.',
  ),

  // conflict — WAITING_APPROVAL or FIX
  row(
    'conflict/merge',
    NO_RETRY,
    'The branch of a surface does not merge cleanly into the integration branch; the conflict goes to a fix round or to a human.',
    'Let the fix round resolve it, or resolve the conflict on the integration branch and resume.',
  ),
  row(
    'conflict/zone-reserved',
    NO_RETRY,
    'Another agent holds the lock on an overlapping zone of files; the writer must wait for it.',
    'Nothing to do; it clears when the holder finishes. Cancel the holder if it is stuck.',
  ),
  row(
    'conflict/incarnation-exists',
    NO_RETRY,
    'An incarnation of this agent is already registered; a second one was refused.',
    'Nothing to do; if no such process is alive, `cohorte resume` sweeps the stale incarnation.',
  ),
  row(
    'conflict/command-id-reuse',
    NO_RETRY,
    'A command identifier was reused with a different body; the second command was rejected.',
    'Send the command again with a fresh identifier.',
  ),
  row(
    'conflict/run-host-alive',
    NO_RETRY,
    'A run host already drives this run; a second one was refused.',
    'Observe the run with `cohorte tail`; stop the other host first if you mean to replace it.',
  ),
  row(
    'conflict/lease-lost',
    NO_RETRY,
    'This run host lost its lease to a newer one and was fenced off; it stopped writing.',
    'Nothing to do; the newer host owns the run. Observe it with `cohorte status`.',
  ),
  row(
    'conflict/reconcile-human-edit',
    NO_RETRY,
    'A generated file was edited by hand since it was rendered; reconcile will not overwrite it.',
    'Keep your edit and mark the field as overridden, or restore the generated content, then plan the reconcile again.',
  ),
  row(
    'conflict/not-running',
    NO_RETRY,
    'The command applies to a running pipeline only and the run is not running; it was rejected.',
    'Check the state with `cohorte status` and use the command that fits it.',
  ),
  row(
    'conflict/run-terminal',
    NO_RETRY,
    'The run has already ended; the command was rejected.',
    'Start a new run; a completed or cancelled run cannot change.',
  ),
  row(
    'conflict/run-active',
    NO_RETRY,
    'The run is active, and this command applies to a halted run only; it was rejected.',
    'Wait for the run to halt, or pause it, before sending this command.',
  ),
  // Added at gate G0 (docs/v3/requests/U0.09.md R2): the five codes `COMMAND_MATRIX` already rejects with. The
  // catalogue is append-only and its rows carry the impact + remediation a renderer needs (DESIGN 2.8), which is
  // exactly what `apps/cli` will print for these rejections.
  row(
    'conflict/run-halted',
    NO_RETRY,
    'The run is halted (FAILED or BLOCKED) rather than running; the command was rejected. A halted run is not over.',
    'Resume it the way its state allows — `cohorte retry` out of FAILED, `cohorte resume --ack` out of BLOCKED.',
  ),
  row(
    'conflict/use-retry',
    NO_RETRY,
    'The run is FAILED, and this command resumes a suspended run only; it was rejected.',
    'Use `cohorte retry` to resume a FAILED run.',
  ),
  row(
    'conflict/use-resume',
    NO_RETRY,
    'The run is suspended, and this command resumes a FAILED run only; it was rejected.',
    'Use `cohorte resume` to resume a suspended run.',
  ),
  row(
    'conflict/use-resume-ack',
    NO_RETRY,
    'The run is BLOCKED by a security stop, and this command does not acknowledge it; it was rejected.',
    'Read the stop record, then use `cohorte resume --ack` to acknowledge it and resume.',
  ),
  row(
    'conflict/run-blocked',
    NO_RETRY,
    'The run is BLOCKED by a security stop; the command was rejected while the stop stands.',
    'Read the stop record and resume with `cohorte resume --ack` before sending this command again.',
  ),
  row(
    'conflict/unexpected',
    NO_RETRY,
    'An unclassified conflict stopped an operation; the state it competed for was left as it was.',
    'Check the state with `cohorte status`, then repeat the operation.',
  ),

  // budget — WAITING_APPROVAL(budget)
  row(
    'budget/tokens',
    NO_RETRY,
    'A token budget is exhausted; the run waits for a human decision.',
    'Raise the budget with `cohorte approve`, or cancel the run.',
  ),
  row(
    'budget/tool-calls-exhausted',
    NO_RETRY,
    'The tool-call budget of the agent is exhausted; further calls are refused.',
    'Raise the tool-call budget with `cohorte approve`, or let the agent conclude with what it has.',
  ),
  row(
    'budget/context-window',
    NO_RETRY,
    'The conversation no longer fits the context window of the model; a fresh incarnation continues with a smaller context built by Cohorte.',
    'Nothing to do; split the task or narrow the ownership if it repeats.',
  ),
  row(
    'budget/fix-rounds',
    NO_RETRY,
    'The maximum number of fix rounds is reached with findings still open; the run waits for a human decision.',
    'Review the open findings, then raise the limit with `cohorte approve` or take over by hand.',
  ),
  row(
    'budget/provider',
    NO_RETRY,
    'The budget configured for this provider is exhausted; the run waits for a human decision.',
    'Raise the provider budget with `cohorte approve`, or cancel the run.',
  ),
  row(
    'budget/estimated-quota',
    NO_RETRY,
    'The estimated share of the plan quota used by this run reached its limit; the run waits for a human decision.',
    'Raise the limit with `cohorte approve`, or wait for the quota window to reset.',
  ),
  row(
    'budget/incarnations',
    NO_RETRY,
    'The agent was restarted as many times as allowed and is now failed.',
    'Inspect why the agent keeps dying with `cohorte logs`, then retry the phase.',
  ),
  row(
    'budget/unexpected',
    NO_RETRY,
    'An unclassified budget failure stopped the run from spending more.',
    'Check the counters with `cohorte status`, then approve a higher budget or cancel the run.',
  ),

  // timeout — retry (agent / tool) or WAITING_APPROVAL (run)
  row(
    'timeout/tool',
    RETRY,
    'A tool call exceeded its time limit and its process tree was killed; the call is retried once.',
    'Raise the timeout of the command in the configuration if the command is legitimately slow.',
  ),
  row(
    'timeout/model-request',
    RETRY,
    'A model request exceeded its time limit; it is retried with a bounded back-off.',
    'Nothing to do; check the network and the status of the provider if it persists.',
  ),
  row(
    'timeout/agent',
    RETRY,
    'The agent exceeded its wall-clock limit and was stopped; the retry policy decides what follows.',
    'Raise the agent time limit, or split the task, if the work is legitimately long.',
  ),
  row(
    'timeout/run',
    NO_RETRY,
    'The run exceeded its wall-clock budget; it waits for a human decision.',
    'Extend the run with `cohorte approve`, or cancel it.',
  ),
  row(
    'timeout/unexpected',
    NO_RETRY,
    'An unclassified timeout stopped an operation; it is not retried because its cause is unknown.',
    'Read the message, then resume the run; report the error if it repeats.',
  ),

  // corruption — refuse to open; never delete a run
  row(
    'corruption/event-gap',
    NO_RETRY,
    'The event sequence of the run has a gap or a duplicate; the store refuses to open it and deletes nothing.',
    'Restore the state database from a backup; keep the damaged file for inspection.',
  ),
  row(
    'corruption/projection-mismatch',
    NO_RETRY,
    'The stored projections disagree with what the events replay to; the run is not resumed from them.',
    'Run `cohorte doctor --verify-state` to see which projection differs from the event log, and report it; the events are the truth.',
  ),
  row(
    'corruption/snapshot-hash',
    NO_RETRY,
    'A state snapshot does not match its recorded hash; it is ignored and an older one is used when available.',
    'Nothing to do if resume succeeds; otherwise restore the state database from a backup.',
  ),
  row(
    'corruption/incompatible-schema',
    NO_RETRY,
    'The schema of the state database is not one this version can read; it refuses to open it and never migrates on its own.',
    'Run the Cohorte version that wrote the database, or back up the state and run `cohorte migrate --apply`.',
  ),
  row(
    'corruption/unexpected',
    NO_RETRY,
    'An unclassified integrity failure made stored state untrustworthy; nothing was deleted.',
    'Back up the .cohorte/state directory before anything else, then run `cohorte doctor`.',
  ),

  // human-required — WAITING_APPROVAL / AUTH_REQUIRED
  row(
    'human-required/approval',
    NO_RETRY,
    'A call needs the approval of a human; the run waits and nothing executes meanwhile.',
    'Review the request with `cohorte status`, then `cohorte approve` or `cohorte deny`.',
  ),
  row(
    'human-required/approval-timeout',
    NO_RETRY,
    'An approval request expired without an answer; the call was not executed.',
    'Resume the run to let the agent ask again, then answer in time.',
  ),
  row(
    'human-required/blocked-ack',
    NO_RETRY,
    'The run is blocked after a security event and needs a human to inspect it.',
    'Inspect the run with `cohorte logs`, then acknowledge with `cohorte resume --ack` or cancel it.',
  ),
  row(
    'human-required/in-doubt-effect',
    NO_RETRY,
    'An effect was interrupted and cannot be proven done or not done; repeating it blindly could apply it twice.',
    'Inspect the effect with `cohorte inspect`, then resolve it by hand and resume.',
  ),
  row(
    'human-required/unexpected',
    NO_RETRY,
    'An unclassified situation needs a human decision; the run waits.',
    'Check what the run waits for with `cohorte status`, then answer it.',
  ),
] as const;

/** The closed set of codes this version can mint. `errorOf` takes nothing else. */
export type ErrorCode = (typeof ERROR_CATALOGUE_ROWS)[number]['code'];

const classOf = (code: string): ErrorClass => {
  const prefix = code.slice(0, code.indexOf('/'));
  const found = ERROR_CLASSES.find((candidate) => candidate === prefix);
  if (!found) throw new TypeError(`error catalogue: ${code} does not start with an error class`);
  return found;
};

const build = (): Readonly<Record<string, ErrorCatalogueEntry>> => {
  const catalogue: Record<string, ErrorCatalogueEntry> = Object.create(null);
  for (const { code, retryable, impact, remediation } of ERROR_CATALOGUE_ROWS) {
    if (code in catalogue) throw new TypeError(`error catalogue: ${code} is listed twice`);
    const errorClass = classOf(code);
    catalogue[code] = Object.freeze({
      class: errorClass,
      retryable,
      impact,
      remediation,
      exit: EXIT_CODE_BY_CLASS[errorClass],
    });
  }
  return Object.freeze(catalogue);
};

/** DESIGN 2.8 (PLAN PC-1: the data lives in base so that L2 packages can mint complete `ErrorInfo`s). */
export const ERROR_CATALOGUE: Readonly<
  Record<string, { class: ErrorClass; retryable: boolean; impact: string; remediation: string; exit: number }>
> = build();

export function isErrorCode(code: string): code is ErrorCode {
  return Object.hasOwn(ERROR_CATALOGUE, code);
}
