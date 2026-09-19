// `@cohorte/runtime-contract/conformance` — the suite every AgentRuntime must pass (DESIGN 2.2). Delivered COMPLETE in
// Wave 0: a runtime package RUNS it (`runtimeConformance(factory, options)` in one of its test files), nobody fills it.
import { describe, test } from 'vitest';
import { type ConformanceOptions, ConformanceViolation, type RuntimeFactory } from './lab.ts';
import { CONFORMANCE_RULES, type ConformanceRule } from './rules.ts';

export type {
  AgentKey,
  BrainScript,
  ConformanceOptions,
  ModelInput,
  ModelInputMessage,
  RuntimeFactory,
  RuntimeFactoryContext,
  ScriptedTurn,
} from './lab.ts';
export { ConformanceViolation, ECHO_TOOL, HOLD_TOOL, UNGRANTED_TOOL } from './lab.ts';
export { CONFORMANCE_RULES, type ConformanceRule } from './rules.ts';

export type RuleOutcome =
  | { rule: number; title: string; status: 'passed' }
  | { rule: number; title: string; status: 'not-applicable'; why: string }
  | { rule: number; title: string; status: 'failed'; error: Error };

async function runRule(
  rule: ConformanceRule,
  factory: RuntimeFactory,
  options: ConformanceOptions,
): Promise<RuleOutcome> {
  const { id, title } = rule;
  try {
    const verdict = await rule.run(factory, options);
    return verdict.applies
      ? { rule: id, title, status: 'passed' }
      : { rule: id, title, status: 'not-applicable', why: verdict.why };
  } catch (thrown) {
    const error = thrown instanceof Error ? thrown : new ConformanceViolation(String(thrown));
    return { rule: id, title, status: 'failed', error };
  }
}

/** Runs the twelve rules one after the other and reports each outcome. Never rejects: a broken runtime is a `failed` row. */
export async function checkConformance(factory: RuntimeFactory, options: ConformanceOptions): Promise<RuleOutcome[]> {
  const outcomes: RuleOutcome[] = [];
  for (const rule of CONFORMANCE_RULES) outcomes.push(await runRule(rule, factory, options));
  return outcomes;
}

/** Registers one vitest test per rule. A rule the runtime's `capabilities()` rule out is reported as skipped, with the reason. */
export function runtimeConformance(factory: RuntimeFactory, options: ConformanceOptions): void {
  const timeout = (options.boundMs ?? 10_000) * 6;
  describe(`AgentRuntime conformance${options.label ? ` (${options.label})` : ''}`, () => {
    for (const rule of CONFORMANCE_RULES) {
      test(`rule ${rule.id}: ${rule.title}`, { timeout }, async (context) => {
        const outcome = await runRule(rule, factory, options);
        if (outcome.status === 'not-applicable') context.skip(outcome.why);
        if (outcome.status === 'failed') throw outcome.error;
      });
    }
  });
}
