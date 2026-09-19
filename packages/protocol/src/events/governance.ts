// DESIGN 2.3.3 — what a human or a limit decides: approvals, budgets, quotas, authentication, retries, commands.
import { ApprovalId, AuthMode, BudgetCounters, CommandId, ErrorInfo, JsonValueSchema, QuotaInfo } from '@cohorte/base';
import { Type } from 'typebox';
import { COMMAND_AUTH_SCHEMES, COMMAND_TYPES, CommandAuth } from '../commands.ts';
import { ClosedEnum, OpenEnum } from '../open-enum.ts';
import { ApprovalRequest } from '../refs.ts';
import { Actor } from '../vocabulary.ts';
import { count, durable, milliseconds } from './declare.ts';

export const APPROVAL_DECISIONS = ['allow-once', 'allow-for-run', 'deny', 'expired', 'superseded'] as const;
export const BUDGET_LEVELS = ['run', 'phase', 'agent', 'provider', 'tool'] as const;
export const BUDGET_THRESHOLDS = [50, 80, 100] as const;
export const BUDGET_COUNTER_NAMES = [
  'tokens',
  'modelRequests',
  'toolCalls',
  'wallClockMs',
  'retries',
  'fixRounds',
  'contextTokens',
  'concurrentAgents',
  'estimatedQuotaPercent',
] as const satisfies readonly (keyof BudgetCounters)[];
type Assert<T extends true> = T;
type _EveryCounterIsNamed = Assert<
  [keyof BudgetCounters] extends [(typeof BUDGET_COUNTER_NAMES)[number]] ? true : false
>;

export const AUTH_REQUIRED_CAUSES = [
  'absent',
  'expired',
  'refresh-failed',
  'revoked',
  'entitlement',
  'mode-mismatch',
  'ambient-source',
] as const;
export const RETRY_TARGET_KINDS = ['agent', 'model-request', 'tool', 'phase'] as const;

const BudgetScope = Type.Object({ level: ClosedEnum(BUDGET_LEVELS), id: Type.String() });

/** A MINOR may add commands (2.3.2), so the `type` a command event names is open on the wire. */
const CommandTypeName = OpenEnum(COMMAND_TYPES);

/** Exported because `inspect { kind: 'approval' }` returns this payload as the decision (R6). */
export const ApprovalResolvedPayload = Type.Object({
  approvalId: ApprovalId,
  decision: ClosedEnum(APPROVAL_DECISIONS),
  actor: Actor,
  commandId: Type.Optional(CommandId),
  /** the authenticator of the approve / deny command, copied so that the decision stays verifiable from the journal */
  commandAuth: Type.Optional(CommandAuth),
  grantId: Type.Optional(Type.String()),
  /** one of `ApprovalRequest.options` */
  answer: Type.Optional(Type.String()),
  note: Type.Optional(Type.String()),
});

export const GOVERNANCE_EVENTS = {
  /** R6 */
  'approval.requested': durable(ApprovalRequest),
  'approval.resolved': durable(ApprovalResolvedPayload),
  /** coalesced: thresholds + at most 1 per 5 s per scope */
  'budget.updated': durable(
    Type.Object({
      scope: BudgetScope,
      consumed: BudgetCounters,
      limit: BudgetCounters,
      threshold: Type.Optional(
        Type.Unsafe<(typeof BUDGET_THRESHOLDS)[number]>({ type: 'integer', enum: [...BUDGET_THRESHOLDS] }),
      ),
    }),
  ),
  'budget.exceeded': durable(
    Type.Object({
      scope: BudgetScope,
      counter: ClosedEnum(BUDGET_COUNTER_NAMES),
      limit: Type.Number({ minimum: 0 }),
      consumed: Type.Number({ minimum: 0 }),
    }),
  ),
  /** on change only */
  'quota.updated': durable(Type.Object({ provider: Type.String(), authMode: AuthMode, quota: QuotaInfo })),
  'auth.required': durable(
    Type.Object({ provider: Type.String(), cause: ClosedEnum(AUTH_REQUIRED_CAUSES), cli: Type.String() }),
  ),
  'retry.scheduled': durable(
    Type.Object({
      target: Type.Object({ kind: ClosedEnum(RETRY_TARGET_KINDS), id: Type.String() }),
      attempt: count(),
      maxAttempts: count(),
      delayMs: milliseconds(),
      cause: ErrorInfo,
    }),
  ),
  /** `actor` as normalised by the host (2.6.7). An accepted command was authenticated: `authVerified` has one value. */
  'command.accepted': durable(
    Type.Object({
      commandId: CommandId,
      type: CommandTypeName,
      actor: Actor,
      authVerified: Type.Literal(true),
      scheme: OpenEnum(COMMAND_AUTH_SCHEMES),
    }),
  ),
  'command.completed': durable(Type.Object({ commandId: CommandId, type: CommandTypeName, result: JsonValueSchema })),
  'command.rejected': durable(Type.Object({ commandId: CommandId, type: CommandTypeName, error: ErrorInfo })),
} as const;
