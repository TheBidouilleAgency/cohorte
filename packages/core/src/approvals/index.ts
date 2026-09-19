// Durable approval service (DESIGN 4.5). Resolution is state-only: an approval never
// executes a tool; consumption belongs to the consuming effect transaction.
import { type ApprovalId, canonicalJson, type JsonValue, sha256Hex } from '@cohorte/base';
import type { ApprovalDecisionRecord, ApprovalRecord } from '@cohorte/persistence/contract';
import type { ApprovalRequest } from '@cohorte/protocol';
import type { RuntimeToolCall } from '@cohorte/runtime-contract';
import type { PolicyEngine } from '@cohorte/security/contract';
import { createRedactor } from '@cohorte/security/redact';
import type { ApprovalsDeps, ToolHostDeps } from '../contract/factories.ts';
import type { ApprovalService, ApprovedCall, ToolHostReplay } from '../contract/internal.ts';
import type { ApprovalDraft } from '../contract/types.ts';
import { createToolHost } from '../toolhost/implementation.ts';

export type { ApprovalsDeps };

const sleep = (signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, 50);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });

function grantKey(draft: ApprovalDraft): string {
  const material = {
    tool: draft.tool ?? null,
    args: draft.args ?? null,
    preStateSha256: draft.preStateSha256 ?? null,
  } as unknown as JsonValue;
  return sha256Hex(canonicalJson(material));
}

function requestOf(draft: ApprovalDraft, approvalId: ApprovalId): ApprovalRequest {
  const {
    idempotencyKey: _idempotencyKey,
    grantKey: _grantKey,
    agentId: _agentId,
    incarnation: _incarnation,
    toolCallId: _toolCallId,
    ...rest
  } = draft;
  return { ...rest, approvalId, cli: `cohorte approve ${approvalId}` } as ApprovalRequest;
}

export function createApprovalService(deps: ApprovalsDeps): ApprovalService {
  const redactor = deps.redactor ?? createRedactor();
  const runs = new Map<ApprovalId, string>();

  return {
    request(tx, draft): ApprovalId {
      const approvalId = deps.ids.next<'ApprovalId'>('apr');
      const request = requestOf(draft, approvalId);
      const sealed = redactor.sealJson(request as unknown as JsonValue).value;
      const event = deps.events.append(tx, [
        {
          type: 'approval.requested',
          payload: request as unknown as JsonValue,
          summary: request.preview.text,
          severity: 'warning',
          source: 'cohorte',
        },
      ])[0];
      const now = deps.clock.now();
      const record: ApprovalRecord = {
        approvalId,
        runId: tx.run().runId,
        idempotencyKey: draft.idempotencyKey,
        kind: request.kind,
        ...(draft.agentId === undefined ? {} : { agentId: draft.agentId }),
        ...(draft.incarnation === undefined ? {} : { incarnation: draft.incarnation }),
        ...(draft.toolCallId === undefined ? {} : { toolCallId: draft.toolCallId }),
        status: 'pending',
        request: sealed,
        grantKey: draft.grantKey || grantKey(draft),
        requestedSeq: event?.sequence ?? tx.run().lastSequence,
        createdAt: now,
        ...(request.expiresAt === undefined ? {} : { expiresAt: request.expiresAt }),
      };
      tx.putApproval(record);
      runs.set(approvalId, record.runId);
      return approvalId;
    },

    async await(id, signal): Promise<ApprovalDecisionRecord> {
      let runId = runs.get(id);
      while (!signal.aborted) {
        if (runId) {
          const tree = await deps.store.readRunTree(runId as never);
          const record = tree.approvals.find((approval) => approval.approvalId === id);
          if (record?.decision) return { ...record.decision, resolvedSeq: record.resolvedSeq ?? 0 };
        } else {
          const candidates = await deps.store.listRuns({ limit: 1000, offset: 0 });
          for (const candidate of candidates) {
            const tree = await deps.store.readRunTree(candidate.runId);
            if (tree.approvals.some((approval) => approval.approvalId === id)) {
              runId = candidate.runId;
              break;
            }
          }
        }
        await sleep(signal);
      }
      throw new Error('approval wait aborted');
    },

    grantFor(tx, key) {
      return tx.findGrant(tx.run().runId, key);
    },

    async approvedUnconsumed(runId, agentId): Promise<ApprovedCall[]> {
      const tree = await deps.store.readRunTree(runId);
      return tree.approvals
        .filter((approval) => approval.agentId === agentId && approval.consumedByEffect === undefined)
        .filter((approval) => approval.status === 'allow-once' || approval.status === 'allow-for-run')
        .flatMap((approval) => {
          const request = approval.request as unknown as Partial<ApprovalRequest> & {
            call?: RuntimeToolCall;
            answer?: string;
          };
          if (!request.call || typeof request.call !== 'object') return [];
          return [
            {
              approvalId: approval.approvalId,
              call: request.call,
              grantKey: approval.grantKey,
              ...(request.answer === undefined ? {} : { answer: request.answer }),
            } satisfies ApprovedCall,
          ];
        });
    },
  };
}

export function createToolHostReplay(deps: ToolHostDeps): ToolHostReplay {
  return {
    async replayApproved(lease, approved, signal) {
      const gateCall = {
        runId: approved.call.runId,
        agentId: approved.call.agentId,
        incarnation: approved.call.incarnation,
        toolCallId: approved.call.toolCallId,
        tool: approved.call.tool,
        input: approved.call.input,
        phase: 'unknown',
        role: 'unknown',
      } as const;
      const verdict = deps.policy.evaluate(gateCall, deps.grantFor(gateCall), deps.policySnapshot, deps.policyPorts);
      if (verdict.decision === 'deny') return { outcome: 'denied-by-gate' };
      if (deps.grantKeyFor(gateCall, verdict) !== approved.grantKey) return { outcome: 'binding-changed' };

      const replayPolicy: PolicyEngine = {
        evaluate(call, grant, policy, ports) {
          const replayVerdict = deps.policy.evaluate(call, grant, policy, ports);
          if (replayVerdict.decision !== 'ask') return replayVerdict;
          return {
            ...replayVerdict,
            decision: 'allow-once' as const,
            approvalId: approved.approvalId,
          };
        },
      };
      const host = createToolHost({
        ...deps,
        policy: replayPolicy,
        leaseFor: () => lease,
        requestApproval: async () => ({ decision: 'deny' as const }),
        recordRequested: async () => undefined,
        recordDenied: async () => undefined,
      });
      const result = await host.handleToolCall(approved.call, {
        signal,
        progress: () => undefined,
      });
      return { outcome: 'executed', result };
    },
  };
}
