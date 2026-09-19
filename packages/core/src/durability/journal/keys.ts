// DESIGN 4.1 (the idempotency-key column of the effect table) / 7.1 ("idempotency keys" row). One deterministic
// builder per effect kind. Plain string templates: the store's `UNIQUE(run_id, idempotency_key)` does the rest.
import type { AgentId, RunId, Sha256 } from '@cohorte/base';

/**
 * DEVIATION (docs/v3/requests/U1.08.md): DESIGN 4.1's table has no row for `git.worktree.remove`, `tool.read`,
 * `tool.network_request` or `tool.git_commit`, though `EffectKind` (persistence/records.ts) lists all four.
 * `worktreeRemove` reuses `worktreeAdd`'s own key namespace (same slot, inverse operation); the three `tool.*`
 * extras reuse `toolCall` (same shape as `tool.write_file` / `tool.patch_file` / `tool.run_command`).
 */
export const effectKeys = {
  /** `fs.snapshot.materialize` */
  snapshotMaterialize: (runId: RunId): string => `snap:${runId}`,
  /** `git.branch.create` / `git.ref.create` */
  gitRefCreate: (runId: RunId, name: string): string => `ref:${runId}:${name}`,
  /** `git.worktree.add` */
  worktreeAdd: (runId: RunId, slot: string): string => `wt:${runId}:${slot}`,
  /** `git.worktree.remove` (deviation above) */
  worktreeRemove: (runId: RunId, slot: string): string => `wt:${runId}:${slot}:remove`,
  /** `provision.command` */
  provisionCommand: (runId: RunId, slot: string, lockfileSha256: Sha256): string =>
    `prov:${runId}:${slot}:${lockfileSha256}`,
  /** `agent.spawn` */
  agentSpawn: (runId: RunId, agentId: AgentId, incarnation: number): string => `${runId}:${agentId}:${incarnation}`,
  /** `tool.write_file` / `tool.patch_file` / `tool.run_command`, and (deviation above) `tool.read` /
   * `tool.network_request` / `tool.git_commit` */
  toolCall: (runId: RunId, agentId: AgentId, incarnation: number, ordinal: number): string =>
    `tool:${runId}:${agentId}:${incarnation}:${ordinal}`,
  /** `check.command` — `treeDigest` computed ONCE before the check sequence (DESIGN 2.5.2), not per check */
  checkCommand: (runId: RunId, name: string, treeDigest: string): string => `check:${runId}:${name}:${treeDigest}`,
  /** `git.commit` */
  gitCommit: (runId: RunId, slot: string, n: number): string => `commit:${runId}:${slot}:${n}`,
  /** `git.merge` */
  gitMerge: (runId: RunId, fromSha: string, intoSha: string): string => `merge:${runId}:${fromSha}:${intoSha}`,
  /** `git.worktree.reset` */
  worktreeReset: (runId: RunId, slot: string, checkpointSha: string, n: number): string =>
    `reset:${runId}:${slot}:${checkpointSha}:${n}`,
  /** an approval bound to one tool call (the fast path, DESIGN 4.5) */
  approvalByToolCall: (toolCallId: string): string => `apr:${toolCallId}`,
  /** an approval not bound to a specific call (`ship`, `budget`, `loop-stalled`, ...) */
  approvalByKind: (runId: RunId, kind: string, phaseRunId: string): string => `apr:${runId}:${kind}:${phaseRunId}`,
} as const;
