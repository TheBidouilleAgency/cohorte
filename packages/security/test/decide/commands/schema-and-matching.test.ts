// Property: every returned CommandEvaluation fragment is schema-valid (plan.json's fourth `commands` test), plus
// direct coverage of the structural-matching pieces the ported tables above do not exercise on their own: flags
// (allow/deny), the `paths-in-worktree` and `none` positional kinds, and `checksToCommandRules`.
import type { CommandRule } from '@cohorte/config/schema';
import { describe, expect, test } from 'vitest';
import { checksToCommandRules, createCommandPolicy } from '../../../src/decide/commands/index.ts';
import {
  assertSchemaValid,
  baseContext,
  commandPolicy,
  commandRequest,
  fakeBranches,
  MAIN_CHECKOUT,
  rule,
  STANDARD_RESOLVER,
  UNPROTECTED_BRANCH,
  WORKTREE,
} from './fixtures.ts';

function engine() {
  return createCommandPolicy({
    programs: STANDARD_RESOLVER,
    branches: fakeBranches({ [WORKTREE]: UNPROTECTED_BRANCH }),
  });
}

const FLAG_RULE: CommandRule = rule({
  id: 'pnpm-run-test',
  program: 'pnpm',
  subcommand: ['run'],
  flags: { allow: ['--reporter'], deny: ['--coverage'] },
  positionals: { kind: 'enum', values: ['test', 'typecheck'], max: 1 },
  decision: 'allow',
});

const PATHS_RULE: CommandRule = rule({
  id: 'git-add-in-worktree',
  program: 'git',
  subcommand: ['add'],
  positionals: { kind: 'paths-in-worktree', max: 5 },
  decision: 'allow',
});

const NONE_RULE: CommandRule = rule({
  id: 'git-status',
  program: 'git',
  subcommand: ['status'],
  positionals: { kind: 'none' },
  decision: 'allow',
});

describe('property: every CommandEvaluation is schema-valid', () => {
  test.for([
    ['allow', ['pnpm', 'run', 'test']],
    ['ask', ['git', 'status']],
    ['deny (trampoline)', ['sh', '-c', 'x']],
    ['deny (global option)', ['git', '-C', '.', 'status']],
    ['deny (no rule)', ['pnpm', 'run', 'lint']],
    ['deny (cwd outside worktree)', ['git', 'status']],
    ['deny (unresolved program)', ['not-a-real-program']],
    ['deny (bare-name violation)', ['./node']],
  ] as const)('%s -> schema-valid', ([label, argv]) => {
    const context = label === 'deny (cwd outside worktree)' ? baseContext({ cwd: MAIN_CHECKOUT }) : baseContext();
    const askRule = rule({
      id: 'git-status-ask',
      program: 'git',
      subcommand: ['status'],
      positionals: { kind: 'none' },
      decision: 'ask',
    });
    assertSchemaValid(engine().evaluate(commandRequest(argv), commandPolicy([FLAG_RULE, askRule]), context));
  });
});

describe('flags: "anything not allowed is denied"', () => {
  test('an allowed flag matches', () => {
    const result = engine().evaluate(
      commandRequest(['pnpm', 'run', 'test', '--reporter']),
      commandPolicy([FLAG_RULE]),
      baseContext(),
    );
    expect(result.decision).toBe('allow');
    expect(result.command?.args).toEqual(['run', 'test', '--reporter']);
  });

  test('an unlisted flag makes the rule NOT match: default-deny', () => {
    const result = engine().evaluate(
      commandRequest(['pnpm', 'run', 'test', '--watch']),
      commandPolicy([FLAG_RULE]),
      baseContext(),
    );
    expect(result.decision).toBe('deny');
    expect(result.ruleId).toBe('builtin/no-rule');
  });

  test('an explicitly denied flag makes the rule NOT match, even if it would otherwise be in `allow`', () => {
    const denyOverridesAllow: CommandRule = rule({
      id: 'both-lists',
      program: 'pnpm',
      subcommand: ['run'],
      flags: { allow: ['--coverage'], deny: ['--coverage'] },
      positionals: { kind: 'enum', values: ['test'], max: 1 },
      decision: 'allow',
    });
    const result = engine().evaluate(
      commandRequest(['pnpm', 'run', 'test', '--coverage']),
      commandPolicy([denyOverridesAllow]),
      baseContext(),
    );
    expect(result.decision).toBe('deny');
  });

  test('no flags declared at all => no flag may be present', () => {
    const result = engine().evaluate(
      commandRequest(['git', 'status', '--short']),
      commandPolicy([NONE_RULE]),
      baseContext(),
    );
    expect(result.decision).toBe('deny');
    expect(result.ruleId).toBe('builtin/no-rule');
  });
});

describe('a flag never narrows a deny or an ask rule (DESIGN 2.6.4 step 5: deny > ask > allow)', () => {
  // The flags allowlist exists so that "anything not allowed is denied" for a PERMISSIVE rule — narrowing one
  // fails closed. Applying it to a deny rule narrows in the other direction: the deny stops matching as soon as a
  // flag it does not declare is present, while a broader allow rule that DOES list that flag keeps matching, and
  // `deny > ask > allow` is defeated by one token. So flags only ever narrow an `allow` rule.
  const ALLOW_RUN: CommandRule = rule({
    id: 'allow-run',
    program: 'pnpm',
    subcommand: ['run'],
    flags: { allow: ['--silent'] },
    positionals: { kind: 'enum', values: ['test', 'build'], max: 1 },
    decision: 'allow',
  });
  const DENY_BUILD: CommandRule = rule({
    id: 'deny-build',
    program: 'pnpm',
    subcommand: ['run'],
    positionals: { kind: 'exact', values: ['build'] },
    decision: 'deny',
  });

  test.for([
    ['plain', ['pnpm', 'run', 'build']],
    ['a global the deny rule does not declare', ['pnpm', '--silent', 'run', 'build']],
    ['a post-subcommand flag the deny rule does not declare', ['pnpm', 'run', 'build', '--silent']],
  ] as const)('%s -> still the deny rule', ([_label, argv]) => {
    const result = engine().evaluate(commandRequest(argv), commandPolicy([ALLOW_RUN, DENY_BUILD]), baseContext());
    expect(result.decision).toBe('deny');
    expect(result.ruleId).toBe('deny-build');
  });

  test('the same holds for an `ask` rule shadowed by a broader `allow`', () => {
    const askBuild: CommandRule = rule({
      id: 'ask-build',
      program: 'pnpm',
      subcommand: ['run'],
      positionals: { kind: 'exact', values: ['build'] },
      decision: 'ask',
    });
    const result = engine().evaluate(
      commandRequest(['pnpm', '--silent', 'run', 'build']),
      commandPolicy([ALLOW_RUN, askBuild]),
      baseContext(),
    );
    expect(result.decision).toBe('ask');
    expect(result.ruleId).toBe('ask-build');
  });

  test('an allow rule is still narrowed by its own allowlist: the asymmetry is deliberate', () => {
    const result = engine().evaluate(
      commandRequest(['pnpm', '--reporter=json', 'run', 'test']),
      commandPolicy([ALLOW_RUN]),
      baseContext(),
    );
    expect(result.decision).toBe('deny');
    expect(result.ruleId).toBe('builtin/no-rule');
  });
});

describe('the shapes a CommandRule may take for a profiled program (DESIGN 2.6.4)', () => {
  test("a multi-token `subcommand` matches: DESIGN's own example, `['run','test']`", () => {
    // The profile parser splits structurally — the FIRST non-flag token is the subcommand, the rest are
    // positionals — so `subcommand` is matched as a PREFIX of the whole non-flag token stream. Without that,
    // `subcommand?: readonly string[] // exact tokens, e.g. ['run','test']` could never match anything.
    const multi: CommandRule = rule({
      id: 'pnpm-run-test-exact',
      program: 'pnpm',
      subcommand: ['run', 'test'],
      positionals: { kind: 'none' },
      decision: 'allow',
    });
    const result = engine().evaluate(commandRequest(['pnpm', 'run', 'test']), commandPolicy([multi]), baseContext());
    expect(result.decision).toBe('allow');
    expect(result.ruleId).toBe('pnpm-run-test-exact');

    // The prefix really is consumed: a trailing token is a positional, and `none` refuses it.
    const extra = engine().evaluate(
      commandRequest(['pnpm', 'run', 'test', 'extra']),
      commandPolicy([multi]),
      baseContext(),
    );
    expect(extra.decision).toBe('deny');
  });

  test('a rule with NO `subcommand` constrains flags and positionals only — the natural shape for `node`', () => {
    const noSubcommand: CommandRule = rule({
      id: 'node-script',
      program: 'node',
      positionals: { kind: 'paths-in-worktree', max: 1 },
      decision: 'allow',
    });
    const result = engine().evaluate(
      commandRequest(['node', 'scripts/x.ts']),
      commandPolicy([noSubcommand]),
      baseContext(),
    );
    expect(result.decision).toBe('allow');
    expect(result.ruleId).toBe('node-script');

    // The constraint still binds: an escaping path is not a `paths-in-worktree` positional.
    const escaping = engine().evaluate(
      commandRequest(['node', '../outside.ts']),
      commandPolicy([noSubcommand]),
      baseContext(),
    );
    expect(escaping.decision).toBe('deny');
    expect(escaping.ruleId).toBe('builtin/no-rule');
  });

  test("a benign leading global is NOT ignored: it is held to the rule's `flags` allowlist", () => {
    // "anything not allowed is denied" (DESIGN 2.6.4) must cover the globals too, or `pnpm --silent run test`
    // would satisfy a rule written for `pnpm run test` — a fail-OPEN.
    const withGlobal = engine().evaluate(
      commandRequest(['pnpm', '--silent', 'run', 'test']),
      commandPolicy([FLAG_RULE]),
      baseContext(),
    );
    expect(withGlobal.decision).toBe('deny');
    expect(withGlobal.ruleId).toBe('builtin/no-rule');

    const allowsGlobal: CommandRule = rule({
      id: 'pnpm-run-test-silent',
      program: 'pnpm',
      subcommand: ['run'],
      flags: { allow: ['--silent'] },
      positionals: { kind: 'enum', values: ['test'], max: 1 },
      decision: 'allow',
    });
    const permitted = engine().evaluate(
      commandRequest(['pnpm', '--silent', 'run', 'test']),
      commandPolicy([allowsGlobal]),
      baseContext(),
    );
    expect(permitted.decision).toBe('allow');
  });
});

describe('positionals kinds', () => {
  test('"none": zero positionals required', () => {
    const zero = engine().evaluate(commandRequest(['git', 'status']), commandPolicy([NONE_RULE]), baseContext());
    expect(zero.decision).toBe('allow');
    const one = engine().evaluate(commandRequest(['git', 'status', 'x']), commandPolicy([NONE_RULE]), baseContext());
    expect(one.decision).toBe('deny');
  });

  test('"paths-in-worktree": worktree-relative-looking positionals match, up to `max`', () => {
    const ok = engine().evaluate(
      commandRequest(['git', 'add', 'src/index.ts', 'README.md']),
      commandPolicy([PATHS_RULE]),
      baseContext(),
    );
    expect(ok.decision).toBe('allow');

    const escaping = engine().evaluate(
      commandRequest(['git', 'add', '../outside']),
      commandPolicy([PATHS_RULE]),
      baseContext(),
    );
    expect(escaping.decision).toBe('deny');

    const absolute = engine().evaluate(
      commandRequest(['git', 'add', '/etc/passwd']),
      commandPolicy([PATHS_RULE]),
      baseContext(),
    );
    expect(absolute.decision).toBe('deny');

    const tooMany = engine().evaluate(
      commandRequest(['git', 'add', 'a', 'b', 'c', 'd', 'e', 'f']),
      commandPolicy([PATHS_RULE]),
      baseContext(),
    );
    expect(tooMany.decision).toBe('deny');
  });

  test('the two value-bearing kinds also have a LOWER bound: zero positionals is a different command', () => {
    // `every()` over an empty array is vacuously true, so without a lower bound a rule written for
    // `pnpm run test` also matched the bare `pnpm run`, and one for `git add <paths>` the argument-less
    // `git add` — every such rule silently wider than its author wrote it. `none` and `exact` already pin
    // the count, so only `enum` and `paths-in-worktree` need the guard.
    const bareRun = engine().evaluate(commandRequest(['pnpm', 'run']), commandPolicy([FLAG_RULE]), baseContext());
    expect(bareRun.decision).toBe('deny');
    expect(bareRun.ruleId).toBe('builtin/no-rule');

    const bareAdd = engine().evaluate(commandRequest(['git', 'add']), commandPolicy([PATHS_RULE]), baseContext());
    expect(bareAdd.decision).toBe('deny');
    expect(bareAdd.ruleId).toBe('builtin/no-rule');
  });
});

describe('network rules under L0', () => {
  test('an allow rule needing network is converted into `permission/network-denied`', () => {
    const networked: CommandRule = rule({
      id: 'git-fetch',
      program: 'git',
      subcommand: ['fetch'],
      positionals: { kind: 'none' },
      decision: 'allow',
      network: true,
    });
    const result = engine().evaluate(commandRequest(['git', 'fetch']), commandPolicy([networked]), baseContext());
    expect(result.decision).toBe('deny');
    expect(result.code).toBe('permission/network-denied');
  });

  test('a DENY rule keeps its own code even when it carries `network: true`', () => {
    // Otherwise the audit event and `cohorte policy explain` would report a policy deny as a network-enforcement
    // problem, with `securityViolation: false` and a reason about the sandbox.
    const networkedDeny: CommandRule = rule({
      id: 'no-fetching',
      program: 'git',
      subcommand: ['fetch'],
      positionals: { kind: 'none' },
      decision: 'deny',
      network: true,
    });
    const result = engine().evaluate(commandRequest(['git', 'fetch']), commandPolicy([networkedDeny]), baseContext());
    expect(result.decision).toBe('deny');
    expect(result.ruleId).toBe('no-fetching');
    expect(result.code).toBe('permission/command-not-allowed');
    expect(result.reason).toMatch(/denied by rule no-fetching/);
  });
});

describe('checksToCommandRules', () => {
  test('one rule per non-empty check, exact positionals, idempotent, allow, origin project-checks', () => {
    const rules = checksToCommandRules({
      typecheck: ['pnpm', 'exec', 'tsc', '--noEmit'],
      test: ['pnpm', 'run', 'test'],
      timeoutMs: 60_000,
    });
    expect(rules).toHaveLength(2);
    const typecheck = rules.find((r) => r.id === 'checks/typecheck');
    expect(typecheck).toMatchObject({
      program: 'pnpm',
      decision: 'allow',
      replay: 'idempotent',
      network: false,
      origin: 'project-checks',
      positionals: { kind: 'exact', values: ['exec', 'tsc', '--noEmit'] },
    });
  });

  test('an unset check produces no rule; the whole result is empty when none are set', () => {
    expect(checksToCommandRules({ timeoutMs: 1000 })).toEqual([]);
  });

  test('the generated rule actually gates the check command through the evaluator', () => {
    const rules = checksToCommandRules({ test: ['pnpm', 'run', 'test'], timeoutMs: 1000 });
    const result = engine().evaluate(commandRequest(['pnpm', 'run', 'test']), commandPolicy(rules), baseContext());
    expect(result.decision).toBe('allow');
    expect(result.command?.replay).toBe('idempotent');
  });

  test('a check declared with an ALIAS mints the canonical program name, or the rule would be dead on arrival', () => {
    // `evaluate()` matches rules against the alias-normalised program (EV-10), so minting `program: argv[0]` raw
    // produced a permanently unreachable rule and the project's own check command was denied.
    const rules = checksToCommandRules({ test: ['docker-compose', 'up'], timeoutMs: 1000 });
    expect(rules[0]).toMatchObject({
      id: 'checks/test',
      program: 'docker',
      positionals: { kind: 'exact', values: ['up'] },
      decision: 'allow',
    });

    const result = engine().evaluate(commandRequest(['docker-compose', 'up']), commandPolicy(rules), baseContext());
    expect(result.decision).toBe('allow');
    expect(result.ruleId).toBe('checks/test');
  });
});
