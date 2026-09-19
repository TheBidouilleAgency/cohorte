// DESIGN 2.7 — the shapes every tool implementation and its host share. `ToolImplementation` names `EffectKind`,
// `ReplayClass`, `EffectIntent`, `EffectRecord` through the TYPE-ONLY edge `tools -> @cohorte/persistence/contract`
// (DESIGN 1.2): a value import of persistence from `src/**` is a layering violation, a type import from `./contract`
// is the one edge this package is allowed.
import type { AgentId, JsonValue, RunId, ToolCallId } from '@cohorte/base';
import type { GitPort } from '@cohorte/git/contract';
import type { EffectIntent, EffectKind, EffectRecord, ReplayClass } from '@cohorte/persistence/contract';
import type { AgentOutput, FileTouch } from '@cohorte/protocol';
import type { ToolGrant } from '@cohorte/runtime-contract';
import type { AgentGrant, CanonicalPath, Executor, PathResolver } from '@cohorte/security/contract';
import type { TSchema } from 'typebox';

export type { EffectIntent, EffectKind, EffectRecord, ReplayClass };

/** What `ToolImplementation.execute` reads and the two hooks the pure-state tools use instead of the effect journal:
 * `requestApproval` for `approval_request` (opens an `ask`, no effect — the decision travels back as
 * `{ decision, answer }`) and `acceptResult` for `submit_result` (strict per-role validation, accepted once). */
export interface ToolExecContext {
  runId: RunId;
  agentId: AgentId;
  incarnation: number;
  toolCallId: ToolCallId;
  role: string;
  grant: AgentGrant;
  workspaceRoot: CanonicalPath;
  paths: PathResolver;
  executor: Executor;
  git: GitPort;
  requestApproval(
    question: string,
    options?: readonly string[],
  ): Promise<{ decision: 'allow-once' | 'allow-for-run' | 'deny'; answer?: string }>;
  acceptResult(output: AgentOutput): Promise<{ accepted: boolean; reason?: string }>;
}

/** The normalised call the gate produced (DESIGN 2.6.2 stages 1-5): what `plan`/`execute` actually act on. Named
 * here — not imported from `@cohorte/security/contract` — because `tools` has no edge to that module's internal
 * `NormalizedCall` beyond what the gate hands the host; the host passes this same value through unchanged. */
export interface NormalizedCall {
  tool: string;
  paths: { arg: string; resolved: { canonical: CanonicalPath; relative: string }; intent: string }[];
  command?: {
    file: CanonicalPath;
    args: string[];
    cwd: CanonicalPath;
    ruleId: string;
    replay: ReplayClass;
    timeoutMs: number;
  };
  input: JsonValue;
}

export interface ToolPlan {
  kind: EffectKind;
  replayClass: ReplayClass;
  verify: JsonValue;
  preState?: EffectIntent['preState'];
}

export interface ToolExecuteResult<O> {
  output: O;
  modelText: string;
  filesTouched: FileTouch[];
}

export interface ToolImplementation<I = JsonValue, O = JsonValue> {
  readonly name: string;
  readonly inputSchema: TSchema;
  readonly description: string;
  readonly effect: ToolGrant['effect'];
  readonly terminal: boolean;
  /** null = no journal (pure state) */
  plan(input: I, n: NormalizedCall, ctx: ToolExecContext): ToolPlan | null;
  /** NEVER synchronous heavy work: hashing streams, scans are spawned */
  execute(input: I, n: NormalizedCall, ctx: ToolExecContext, signal: AbortSignal): Promise<ToolExecuteResult<O>>;
  verifyAfterCrash(record: EffectRecord, ctx: ToolExecContext): Promise<'done' | 'not-done' | 'in-doubt'>;
  /** one line for the reconciliation note (DESIGN 4.4) */
  describeForNote(record: EffectRecord): string;
}
