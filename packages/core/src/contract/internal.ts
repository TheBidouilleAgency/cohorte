// DESIGN 2.5 — the INTERNAL ports of `@cohorte/core`, frozen in Wave 0 so that five core units (Wave 1) can be built
// in parallel against them without ever importing each other. Verbatim from DESIGN 2.5 where given; `CommitService`
// and `MergeService` are new (PLAN PC-4: "a few more frozen seams than DESIGN 2.5 lists"), sized to what `git.commit`
// / `git.merge` (DESIGN 4.1) and the BUILD phase ("commit + merge succeeded", DESIGN 2.5.2) need.
import type { AgentId, ApprovalId, EffectId, ErrorInfo, JsonValue, Result, RunId, Sha256 } from '@cohorte/base';
import type {
  ApprovalDecisionRecord,
  ApprovalRecord,
  DurableEnvelope,
  EffectIntent,
  LeaseToken,
  LedgerEntry,
  StoreTx,
  WorktreeRecord,
} from '@cohorte/persistence/contract';
import type { ArtifactRef, ResumeReport, StopRecord } from '@cohorte/protocol';
import type {
  ContextManifest,
  PromptRef,
  RuntimeToolCall,
  RuntimeToolResult,
  TaskInput,
} from '@cohorte/runtime-contract';
import type { WorkspaceReader } from '@cohorte/tools/workspace';
import type { RunSnapshotManifest } from './snapshot-manifest.ts';
import type {
  AgentPlan,
  AgentResult,
  ApprovalDraft,
  CheckpointCause,
  EphemeralInput,
  EventDraftInput,
  HostContext,
  LedgerAudit,
  PhaseOutcome,
  PhaseRunContext,
  SnapshotInput,
} from './types.ts';

/** strict-validate -> summary/severity (C0/C1 stripped, 2.3.6) -> Redactor.seal -> tx.appendEvents. A redactor
 * exception replaces the event by error{security/redaction-failed}. `ephemeral()`: queued behind the pending durable
 * drafts of the same agent and stamped (sequence, sub) only after that batch commits (2.3.2 ordering rule). */
export interface EventWriter {
  append(tx: StoreTx, drafts: EventDraftInput[]): DurableEnvelope[];
  ephemeral(runId: RunId, e: EphemeralInput): void;
}

export interface EffectSpec<R> {
  intent: Omit<EffectIntent, 'request' | 'verify'> & { request: JsonValue; verify: JsonValue };
  before: EventDraftInput[];
  perform(signal: AbortSignal): Promise<{
    result: R;
    after: EventDraftInput[];
    post?: { treeDigest?: string; head?: string };
    ledger?: LedgerEntry[];
  }>;
}
export interface EffectJournal {
  run<R extends JsonValue>(
    lease: LeaseToken,
    spec: EffectSpec<R>,
    signal: AbortSignal,
  ): Promise<{ status: 'done' | 'replayed'; result: R }>;
}

export interface ApprovedCall {
  approvalId: ApprovalId;
  /** the ORIGINAL call: same toolCallId, same ordinal */
  call: RuntimeToolCall;
  grantKey: string;
  answer?: string;
}

export interface ApprovalService {
  request(tx: StoreTx, draft: ApprovalDraft): ApprovalId;
  await(id: ApprovalId, signal: AbortSignal): Promise<ApprovalDecisionRecord>;
  grantFor(tx: StoreTx, grantKey: string): ApprovalRecord | undefined;
  /** 4.5 parked path: resolved-allow approvals of this agent whose stored call was never executed (requester gone).
   * Read-only; the replay itself is `ToolHostReplay`'s. */
  approvedUnconsumed(runId: RunId, agentId: AgentId): Promise<ApprovedCall[]>;
}

/** Implemented by `CohorteToolHost` next to `handleToolCall`. Re-runs stages 1-5 on the stored call, recomputes the
 * pre-state binding, and ONLY if the grant key still matches executes it through the journal under the ORIGINAL
 * idempotency key (`tool:<runId>:<agentId>:<inc>:<ordinal>`), consuming the grant in the intent tx. Never opens an
 * ask. */
export interface ToolHostReplay {
  replayApproved(
    lease: LeaseToken,
    approved: ApprovedCall,
    signal: AbortSignal,
  ): Promise<{ outcome: 'executed' | 'binding-changed' | 'denied-by-gate'; result?: RuntimeToolResult }>;
}

/** spawn by key, roll-call, retry/escalation, nudges, the ONE `RuntimeEvent -> Envelope` mapper (`satisfies`-total). */
export interface AgentSupervisor {
  runAgents(plans: AgentPlan[], ctx: PhaseRunContext): Promise<AgentResult[]>;
}

export interface ContextBuilder {
  build(
    plan: AgentPlan,
    pin: PinReader,
    workspace: WorkspaceReader,
  ): Promise<{ manifest: ContextManifest; systemPrompt: PromptRef; task: TaskInput }>;
}

export interface RunSnapshotter {
  capture(input: SnapshotInput): Promise<RunSnapshotManifest>;
  verify(manifest: RunSnapshotManifest): Promise<Result<true, ErrorInfo>>;
}

/** Serves from the CAS, re-hashes on every read. */
export interface PinReader {
  read(logicalPath: string): Promise<Uint8Array>;
  ref(logicalPath: string): { sha256: Sha256; bytes: number; path: string };
}

export interface WorktreeService {
  acquire(slot: string, forAgent: AgentId): Promise<WorktreeRecord>;
  checkpoint(slot: string, cause: CheckpointCause): Promise<string>;
  release(slot: string): Promise<void>;
  audit(slot: string): Promise<LedgerAudit>;
  quarantineAndReset(slot: string, because: EffectId): Promise<ArtifactRef>;
  /** journaled `git.worktree.reset` + clean; used on `_integration` after every check sequence (DESIGN 2.5.2) */
  resetClean(slot: string, to: string): Promise<void>;
}

/** DESIGN 5.7; `verify` = the dependency manifest digest, before each TEST. */
export interface Provisioner {
  ensure(slot: string): Promise<'fresh' | 'reused'>;
  verifyDependencies(slot: string): Promise<Result<true, ErrorInfo>>;
}

/** New (PLAN PC-4): what the BUILD phase's "commit + merge succeeded" step (DESIGN 2.5.2) and the `git.commit`
 * effect (DESIGN 4.1) need, without either core area importing `@cohorte/git` directly. */
export interface CommitService {
  commit(
    slot: string,
    kind: 'result' | 'checkpoint',
    paths?: string[],
  ): Promise<{ sha: string; treeDigest: string } | { kind: 'nothing' }>;
}

/** New (PLAN PC-4): the `git.merge` effect (DESIGN 4.1) as a port, so the BUILD phase's merge step never imports
 * `@cohorte/git` directly either. */
export interface MergeService {
  merge(
    fromSlot: string,
    intoSlot: string,
  ): Promise<{ mergeSha: string; treeDigest: string } | { kind: 'conflict'; files: string[] }>;
}

export interface PhaseExecutor {
  execute(ctx: PhaseRunContext): Promise<PhaseOutcome>;
}

export interface Resumer {
  recover(runId: RunId, host: HostContext): Promise<ResumeReport>;
}

export interface RunEngine {
  run(runId: RunId, host: HostContext): Promise<StopRecord>;
}

/** New (PLAN PC-4): the `durability/lease` area's own port over the store's lock/lease primitives (DESIGN 2.4, spec
 * 15), so it never imports `@cohorte/persistence` itself beyond the type-only edge every core area already has. */
export interface LeaseManager {
  acquire(
    scope: { runId: RunId } | 'project',
    key: string,
    mode: 'shared' | 'exclusive',
    ttlMs: number,
  ): Promise<LeaseToken>;
  renew(lease: LeaseToken, ttlMs: number): Promise<boolean>;
  release(lease: LeaseToken): Promise<void>;
}
