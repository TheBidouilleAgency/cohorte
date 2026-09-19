import type { JsonValue, TokenUsage } from '@cohorte/base';
import type { FakeAgentRule, FakeScript, FakeStep, FakeStepOf } from './index.ts';

export interface FakeScriptBuilder {
  defaults(defaults: NonNullable<FakeScript['defaults']>): FakeScriptBuilder;
  agent(match: FakeAgentRule['match'], steps: FakeStep[]): FakeScriptBuilder;
  build(): FakeScript;
}

/** Rules are tried in the order they were added. `build()` hands out a copy: the builder can go on being used. */
export function fakeScript(): FakeScriptBuilder {
  const agents: FakeAgentRule[] = [];
  let defaults: FakeScript['defaults'];
  const builder: FakeScriptBuilder = {
    defaults(next) {
      defaults = { ...defaults, ...next };
      return builder;
    },
    agent(match, steps) {
      agents.push({ match, steps });
      return builder;
    },
    build() {
      return structuredClone({ version: 1, agents, ...(defaults === undefined ? {} : { defaults }) });
    },
  };
  return builder;
}

type ToolOptions = Pick<FakeStepOf<'tool'>, 'expect' | 'onDenied'>;
type ModelRequestOptions = Omit<FakeStepOf<'model-request'>, 'do'>;

/** One constructor per step kind, so that a TypeScript test never spells a `do:` literal. */
export const step = {
  say: (text: string, chunks?: number): FakeStep => ({ do: 'say', text, ...(chunks === undefined ? {} : { chunks }) }),
  think: (text: string): FakeStep => ({ do: 'think', text }),
  tool: (tool: string, input: JsonValue, options: ToolOptions = {}): FakeStep => ({
    do: 'tool',
    tool,
    input,
    ...options,
  }),
  submit: (output: JsonValue): FakeStep => ({ do: 'submit', output }),
  usage: (tokens: Partial<TokenUsage>): FakeStep => ({ do: 'usage', tokens }),
  awaitMessage: (timeoutMs?: number): FakeStep => ({
    do: 'await-message',
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  }),
  fail: (error: FakeStepOf<'fail'>['error']): FakeStep => ({ do: 'fail', error }),
  hang: (ms: number | 'forever'): FakeStep => ({ do: 'hang', ms }),
  crash: (at: FakeStepOf<'crash'>['at']): FakeStep => ({ do: 'crash', at }),
  stopWithoutResult: (): FakeStep => ({ do: 'stop-without-result' }),
  modelRequest: (options: ModelRequestOptions = {}): FakeStep => ({ do: 'model-request', ...options }),
} as const;
