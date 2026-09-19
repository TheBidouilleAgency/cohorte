import type { EffectId } from '@cohorte/base';
import { type JsonValue, sha256Hex } from '@cohorte/base';
import type { RuntimeToolCall, RuntimeToolResult, ToolCallContext, ToolHost } from '@cohorte/runtime-contract';
import type { PolicyVerdict } from '@cohorte/security/contract';
import type { ToolExecuteResult } from '@cohorte/tools/catalogue';
import type { ToolHostDeps } from '../contract/factories.ts';
import { effectKeys } from '../durability/journal/keys.ts';

const asJson = (value: unknown): JsonValue => value as JsonValue;

function textResult(deps: ToolHostDeps, text: string, isError = true): RuntimeToolResult {
  const sealed = deps.redactor.sealText(text).text;
  return { isError, content: [{ type: 'text', text: sealed }] };
}

function denial(deps: ToolHostDeps, _call: RuntimeToolCall, verdict: PolicyVerdict): RuntimeToolResult {
  return textResult(deps, `${verdict.modelFacingReason} [${verdict.stage}/${verdict.ruleId}]`);
}

function effectIdFor(call: RuntimeToolCall): EffectId {
  return `eff_${sha256Hex(`${call.runId}:${call.agentId}:${call.incarnation}:${call.ordinal}`).slice(0, 32)}` as EffectId;
}

function outputPayload(
  deps: ToolHostDeps,
  call: RuntimeToolCall,
  effectId: EffectId,
  result: ToolExecuteResult<JsonValue>,
) {
  const text = deps.redactor.sealText(result.modelText).text;
  const bytes = new TextEncoder().encode(result.modelText);
  return {
    type: 'tool.completed' as const,
    payload: {
      toolCallId: call.toolCallId,
      tool: call.tool,
      effectId,
      isError: false,
      timedOut: false,
      durationMs: 0,
      waitedMs: 0,
      output: {
        sha256: sha256Hex(bytes),
        bytes: bytes.byteLength,
        truncated: false,
        preview: text,
      },
      filesTouched: result.filesTouched,
      replayed: false,
    } as unknown as JsonValue,
    summary: `tool completed: ${call.tool}`,
    source: 'cohorte' as const,
    severity: 'success' as const,
  };
}

/** Host-side gate and execution pipeline. Runtime code never receives the policy or the executor. */
export function createToolHost(deps: ToolHostDeps): ToolHost {
  return {
    async handleToolCall(call, ctx: ToolCallContext): Promise<RuntimeToolResult> {
      if (ctx.signal.aborted) return textResult(deps, 'tool call aborted');

      const gateCall = {
        runId: call.runId,
        agentId: call.agentId,
        incarnation: call.incarnation,
        toolCallId: call.toolCallId,
        tool: call.tool,
        input: call.input,
        phase: 'unknown',
        role: 'unknown',
      } as const;
      try {
        await deps.recordRequested(gateCall);
      } catch (cause) {
        return textResult(deps, cause instanceof Error ? cause.message : 'unable to record tool request');
      }
      const verdict = deps.policy.evaluate(gateCall, deps.grantFor(gateCall), deps.policySnapshot, deps.policyPorts);
      if (verdict.decision === 'deny') {
        try {
          await deps.recordDenied(gateCall, verdict);
        } catch (cause) {
          return textResult(deps, cause instanceof Error ? cause.message : 'unable to record tool denial');
        }
        return denial(deps, call, verdict);
      }

      let decision = verdict.decision;
      let approvalId = verdict.approvalId;
      if (decision === 'ask') {
        const answer = await deps.requestApproval(gateCall, verdict, ctx.signal);
        if (answer.decision === 'deny') {
          try {
            await deps.recordDenied(gateCall, verdict);
          } catch (cause) {
            return textResult(deps, cause instanceof Error ? cause.message : 'unable to record tool denial');
          }
          return denial(deps, call, verdict);
        }
        decision = answer.decision;
        approvalId = answer.approvalId as typeof approvalId;
      }

      const implementation = deps.toolRegistry.get(call.tool);
      if (!implementation || !verdict.normalized)
        return textResult(deps, `tool ${call.tool} has no executable implementation`);

      const execution = deps.executionFor(gateCall);
      const normalized = verdict.normalized;
      const plan = implementation.plan(call.input as never, normalized as never, execution);
      const execute = (): Promise<ToolExecuteResult<JsonValue>> =>
        implementation.execute(call.input as never, normalized as never, execution, ctx.signal) as Promise<
          ToolExecuteResult<JsonValue>
        >;

      if (plan === null) {
        try {
          const result = await execute();
          return {
            isError: false,
            content: [{ type: 'text', text: deps.redactor.sealText(result.modelText).text }],
          };
        } catch (cause) {
          return textResult(deps, cause instanceof Error ? cause.message : 'tool execution failed');
        }
      }

      const effectId = effectIdFor(call);
      const key = effectKeys.toolCall(call.runId, call.agentId, call.incarnation, call.ordinal);
      const started = {
        type: 'tool.started' as const,
        payload: {
          toolCallId: call.toolCallId,
          tool: call.tool,
          effectId,
          decision,
          ruleId: verdict.ruleId,
          ...(verdict.grantId === undefined ? {} : { grantId: verdict.grantId }),
          normalizedArgs: call.input,
          replayClass: plan.replayClass,
          sandbox: deps.sandbox,
        } as unknown as JsonValue,
        summary: `tool started: ${call.tool}`,
        source: 'cohorte' as const,
      };

      try {
        const executionResult = await deps.journal.run(
          deps.leaseFor(gateCall),
          {
            intent: {
              runId: call.runId,
              idempotencyKey: key,
              kind: plan.kind,
              replayClass: plan.replayClass,
              agentId: call.agentId,
              toolCallId: call.toolCallId,
              request: asJson({ tool: call.tool, input: call.input }),
              verify: plan.verify,
              ...(decision === 'allow-once' && approvalId ? { consumesGrant: approvalId as never } : {}),
            },
            before: [started],
            async perform(signal) {
              const result = await implementation.execute(call.input as never, normalized as never, execution, signal);
              return {
                result: asJson(result),
                after: [outputPayload(deps, call, effectId, result as ToolExecuteResult<JsonValue>)],
              };
            },
          },
          ctx.signal,
        );
        const result = executionResult.result as unknown as ToolExecuteResult<JsonValue>;
        return {
          isError: false,
          content: [{ type: 'text', text: deps.redactor.sealText(result.modelText).text }],
          ...(implementation.terminal ? { terminate: true } : {}),
        };
      } catch (cause) {
        return textResult(deps, cause instanceof Error ? cause.message : 'journaled tool execution failed');
      }
    },
  };
}
