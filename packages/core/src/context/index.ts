import { canonicalJson, sha256Hex } from '@cohorte/base';
import type { ContextManifest, PromptRef, TaskInput } from '@cohorte/runtime-contract';
import type { ContextDeps } from '../contract/factories.ts';
import type { ContextBuilder } from '../contract/internal.ts';
import type { AgentPlan } from '../contract/types.ts';

const bytesOf = (text: string): Uint8Array => new TextEncoder().encode(text);
const estimate = (bytes: number): number => Math.ceil(bytes / 4);

function contextEntry(
  id: string,
  tier: 'system' | 'task',
  trust: 'cohorte' | 'human',
  source: { kind: 'asset' | 'inline'; ref: string },
  bytes: Uint8Array,
) {
  return {
    id,
    tier,
    trust,
    source,
    sha256: sha256Hex(bytes),
    bytes: bytes.byteLength,
    tokenEstimate: estimate(bytes.byteLength),
  };
}

export function createContextBuilder(deps: ContextDeps): ContextBuilder {
  return {
    async build(plan: AgentPlan, pin, _workspace) {
      const promptRef = pin.ref(plan.promptId);
      const promptBytes = await pin.read(plan.promptId);
      const taskText = [plan.task.stablePrefix, plan.task.variableSuffix].filter(Boolean).join('\n\n');
      const taskBytes = bytesOf(taskText);
      const taskRef = await deps.writeTask(plan, taskBytes);
      const entries = [
        contextEntry('system-prompt', 'system', 'cohorte', { kind: 'asset', ref: plan.promptId }, promptBytes),
        contextEntry('task', 'task', 'human', { kind: 'inline', ref: taskRef.path }, taskBytes),
      ].sort((a, b) => (a.tier === b.tier ? a.id.localeCompare(b.id) : a.tier.localeCompare(b.tier)));
      const manifest: ContextManifest = {
        manifestSha256: sha256Hex(canonicalJson(entries)),
        tokenLimit: plan.context.tokenBudget ?? estimate(promptBytes.byteLength + taskBytes.byteLength),
        tokenEstimate: entries.reduce((sum, entry) => sum + entry.tokenEstimate, 0),
        entries,
        reductions: [],
        exclusions: [],
      };
      const systemPrompt: PromptRef = { id: plan.promptId, ...promptRef };
      const task: TaskInput = taskRef;
      return { manifest, systemPrompt, task };
    },
  };
}

export type { ContextDeps } from '../contract/factories.ts';
