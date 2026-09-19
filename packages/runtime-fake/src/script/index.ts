// The script shapes of DESIGN 3.10, VERBATIM, and what loads, builds and matches them.
import type { ErrorClass, JsonValue, QuotaInfo, TokenUsage } from '@cohorte/base';

/** YAML/JSON loadable. */
export interface FakeScript {
  version: 1;
  agents: FakeAgentRule[];
  defaults?: { usagePerTurn?: TokenUsage; model?: string };
}

/** Matching is on `SpawnRequest` fields ONLY. `agentId` is a glob. */
export interface FakeAgentRule {
  match: { role?: string; agentId?: string; incarnation?: number | 'any'; attempt?: number };
  steps: FakeStep[];
}

export type FakeStep =
  | { do: 'say'; text: string; chunks?: number }
  | { do: 'think'; text: string }
  // `tool` is ANY string: that is how unknown and forbidden tools are tested
  | {
      do: 'tool';
      tool: string;
      input: JsonValue;
      expect?: { isError?: boolean; textIncludes?: string };
      onDenied?: FakeStep[];
    }
  | { do: 'submit'; output: JsonValue }
  | { do: 'usage'; tokens: Partial<TokenUsage> }
  | { do: 'await-message'; timeoutMs?: number }
  // provider 5xx, rate limit, auth, quota…
  | { do: 'fail'; error: { class: ErrorClass; code: string; retryable: boolean; retryAfterMs?: number } }
  // honours cancel
  | { do: 'hang'; ms: number | 'forever' }
  | { do: 'crash'; at: 'before-next-step' | 'during-tool' }
  | { do: 'stop-without-result' }
  // drives auth-mode-violation tests
  | {
      do: 'model-request';
      status?: number;
      quota?: QuotaInfo;
      authSource?: 'oauth' | 'api-key' | 'none';
      baseUrl?: string;
    };

export type FakeStepOf<K extends FakeStep['do']> = Extract<FakeStep, { do: K }>;

export { type FakeScriptBuilder, fakeScript, step } from './builder.ts';
export { type FakeMatchSubject, globToRegExp, matchFakeRule } from './match.ts';
export { fakeScriptSha256, loadFakeScriptFile, parseFakeScript, validateFakeScript } from './parse.ts';
export { FakeScriptSchema } from './schema.ts';
