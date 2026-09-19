import type { JsonValue } from '@cohorte/base';
import { CATALOGUE_ROWS } from '../../catalogue/schemas.ts';
import { stubImplementation } from '../../catalogue/stub.ts';
import type { ToolImplementation } from '../../catalogue/types.ts';

export const STATE_TOOL_NAMES = [
  'approval_request',
  'submit_result',
  'git_commit',
  'network_request',
  'secret_read',
] as const;

const metadata = (name: (typeof STATE_TOOL_NAMES)[number]) => {
  const row = CATALOGUE_ROWS.find((candidate) => candidate.name === name);
  if (row === undefined) throw new Error(`missing catalogue row: ${name}`);
  return row;
};

const approvalRequest: ToolImplementation = {
  ...metadata('approval_request'),
  plan: () => null,
  execute: async (input, _normalized, ctx) => {
    const value = input as { question: string; options?: string[] };
    const decision = await ctx.requestApproval(value.question, value.options);
    return {
      output: decision as unknown as JsonValue,
      modelText: decision.answer ?? decision.decision,
      filesTouched: [],
    };
  },
  verifyAfterCrash: async () => 'done',
  describeForNote: () => 'approval request',
};

const submitResult: ToolImplementation = {
  ...metadata('submit_result'),
  plan: () => null,
  execute: async (input, _normalized, ctx) => {
    const accepted = await ctx.acceptResult(input as never);
    if (!accepted.accepted) throw new Error(`validation/agent-output: ${accepted.reason ?? 'result was rejected'}`);
    return { output: { accepted: true }, modelText: 'result submitted', filesTouched: [] };
  },
  verifyAfterCrash: async () => 'done',
  describeForNote: () => 'submit result',
};

export const STATE_TOOLS: Readonly<Record<(typeof STATE_TOOL_NAMES)[number], ToolImplementation>> = Object.freeze({
  approval_request: approvalRequest,
  submit_result: submitResult,
  git_commit: stubImplementation('git_commit'),
  network_request: stubImplementation('network_request'),
  secret_read: stubImplementation('secret_read'),
});
