// MUST-DENY evasions EV-01..EV-13 (DESIGN 7.4). Each case asserts the VERDICT and the MECHANISM by which it is
// now structurally impossible, not merely pattern-denied. EV-14/15 (overwriting or forging `.cohorte/**` state) are
// out of this unit's scope: they belong to the protected-root check of `packages/security/src/decide/paths` and to
// the event-chain / hash-anchor checks of `packages/persistence` — U1.03 owns `decide/commands` only, and the
// unit's own plan.json "tests" entry names EV-01..EV-13, not EV-15.
import type { CommandRule } from '@cohorte/config/schema';
import { describe, expect, test } from 'vitest';
import type { CommandPolicy, CommandRequest, ProgramProfile } from '../../../src/contract/index.ts';
import type { CommandContext, CommandEvaluation } from '../../../src/decide/commands/index.ts';
import { checksToCommandRules, createCommandPolicy } from '../../../src/decide/commands/index.ts';
import {
  assertSchemaValid,
  baseContext,
  canonical,
  commandPolicy,
  commandRequest,
  fakeBranches,
  MAIN_CHECKOUT,
  OTHER_WORKTREE,
  rule,
  STANDARD_RESOLVER,
  UNPROTECTED_BRANCH,
  WORKTREE,
} from './fixtures.ts';

const DENY_MIGRATION_FRESH = rule({
  id: 'deny-migration-fresh',
  program: 'node',
  subcommand: ['ace'],
  positionals: { kind: 'exact', values: ['migration:fresh'] },
  decision: 'deny',
});

/** Every evaluation this suite makes goes through here, and every returned verdict is asserted schema-valid: that
 * is plan.json's fourth `commands` test ("every returned verdict fragment is schema-valid"), which DESIGN 7.4
 * states over "every verdict of every table row" — so it has to wrap the table helpers, not a hand-picked sample. */
function engine(programs = STANDARD_RESOLVER, options: { profiles?: readonly ProgramProfile[] } = {}) {
  const evaluator = createCommandPolicy({
    programs,
    branches: fakeBranches({ [WORKTREE]: UNPROTECTED_BRANCH }),
    ...(options.profiles === undefined ? {} : { profiles: options.profiles }),
  });
  return {
    evaluate: (request: CommandRequest, policy: CommandPolicy, context: CommandContext): CommandEvaluation =>
      assertSchemaValid(evaluator.evaluate(request, policy, context)),
  };
}

function evaluate(argv: string[], programs = STANDARD_RESOLVER, context = baseContext()) {
  return engine(programs).evaluate(commandRequest(argv), commandPolicy([DENY_MIGRATION_FRESH]), context);
}

describe('MUST-DENY evasions (DESIGN 7.4)', () => {
  test('baseline: node ace migration:fresh -> deny', () => {
    const result = evaluate(['node', 'ace', 'migration:fresh']);
    expect(result.decision).toBe('deny');
    expect(result.ruleId).toBe('deny-migration-fresh');
  });

  test('EV-01: node ./ace migration:fresh -> deny (default: no rule matches the literal token)', () => {
    const result = evaluate(['node', './ace', 'migration:fresh']);
    expect(result.decision).toBe('deny');
    expect(result.ruleId).toBe('builtin/no-rule'); // NOT the migration-fresh rule: a different literal token
  });

  test('EV-02/03: quoting cannot be removed — there is no shell to remove it', () => {
    // No shell ⇒ no quote stripping: these tokens are literally `"migration:fresh"` and `migration:"fresh"`, never
    // equal to the rule's `migration:fresh`.
    for (const token of ['"migration:fresh"', 'migration:"fresh"']) {
      const result = evaluate(['node', 'ace', token]);
      expect(result.decision).toBe('deny');
      expect(result.ruleId).toBe('builtin/no-rule');
    }
  });

  test('EV-04: a literal newline inside one token is not a line continuation — there are no lines', () => {
    const result = evaluate(['node', 'ace', 'migration:\nfresh']);
    expect(result.decision).toBe('deny');
    expect(result.ruleId).toBe('builtin/no-rule');
  });

  test('EV-05: no shell variables — `$a` is a literal token, never substituted, and `a=x` is not `argv[0]`', () => {
    const result = evaluate(['node', 'ace', '$a']);
    expect(result.decision).toBe('deny');
    expect(result.ruleId).toBe('builtin/no-rule');
  });

  test('EV-06: no pipes — base64-decode-into-sh is not one CommandRequest, and `sh` is a non-overridable trampoline', () => {
    const shResult = evaluate(['sh', '-c', 'echo <payload> | base64 -d | sh']);
    expect(shResult.decision).toBe('deny');
    expect(shResult.code).toBe('security/command-trampoline');
    expect(shResult.overridable).toBe(false);
    // `base64` on its own is not a trampoline, but it has no profile and no rule: still denied, by default.
    const base64Result = evaluate(['base64', '-d']);
    expect(base64Result.decision).toBe('deny');
    expect(base64Result.code).not.toBe('security/command-trampoline');
  });

  test('EV-07: "Node" (wrong case) does not resolve; npx is a trampoline', () => {
    // The fake resolver only knows the lowercase `node`: a case-sensitive PATH lookup would behave the same way.
    const capitalised = evaluate(['Node', 'ace', 'db:wipe']);
    expect(capitalised.decision).toBe('deny');
    expect(capitalised.ruleId).toBe('builtin/resolve');
    expect(capitalised.code).not.toBe('security/command-trampoline');

    const npxResult = evaluate(['npx', 'ace', 'db:wipe']);
    expect(npxResult.decision).toBe('deny');
    expect(npxResult.code).toBe('security/command-trampoline');
  });

  test('EV-08/09: git -C/-c re-target and are denied; --no-pager is benign so the subcommand is still seen (D9)', () => {
    const dashC = evaluate(['git', '-C', '.', 'commit', '-m', 'x']);
    expect(dashC.decision).toBe('deny');
    expect(dashC.code).toBe('security/command-global-option');
    expect(dashC.ruleId).toBe('builtin/global-option');

    const dashLowerC = evaluate(['git', '-c', 'user.name=a', 'commit', '-m', 'x']);
    expect(dashLowerC.decision).toBe('deny');
    expect(dashLowerC.code).toBe('security/command-global-option');

    // `--no-pager` is not a re-targeting option: it is parsed as a benign global, so `push` is still the
    // subcommand the agent built-in D9 deny sees — a DIFFERENT mechanism than the global-option deny above.
    const noPager = evaluate(['git', '--no-pager', 'push']);
    expect(noPager.decision).toBe('deny');
    expect(noPager.ruleId).toBe('builtin/agent-git-deny');
    expect(noPager.code).not.toBe('security/command-global-option');
  });

  test('EV-08/09 (quater): the D9 git deny does not depend on a git profile being configured (ADR-0007 item 2)', () => {
    // `CommandPolicyOptions.profiles` is a public, caller-supplied option: with the D9 check nested inside "a
    // profile was found", a caller that passes a profile list without git turns a NON-OVERRIDABLE invariant off.
    const exactCommit = rule({
      id: 'exact-commit',
      program: 'git',
      positionals: { kind: 'exact', values: ['commit', '-m', 'x'] },
      decision: 'allow',
    });
    const noProfiles = engine(STANDARD_RESOLVER, { profiles: [] });
    const result = noProfiles.evaluate(
      commandRequest(['git', 'commit', '-m', 'x']),
      commandPolicy([exactCommit]),
      baseContext(),
    );
    expect(result.decision).toBe('deny');
    expect(result.ruleId).toBe('builtin/agent-git-deny');
    expect(result.overridable).toBe(false);

    // Without a profile nothing can tell a subcommand from a global option's VALUE, so every token is held against
    // the D9 set: a benign value-taking global cannot shift `commit` out from under the check.
    const shifted = noProfiles.evaluate(
      commandRequest(['git', '--super-prefix', 'x', 'commit']),
      commandPolicy([exactCommit]),
      baseContext(),
    );
    expect(shifted.decision).toBe('deny');
    expect(shifted.ruleId).toBe('builtin/agent-git-deny');

    // With the built-in profiles the same argv is refused one step EARLIER, by the re-targeting parse itself.
    const withProfiles = evaluate(['git', '--super-prefix', 'x', 'commit']);
    expect(withProfiles.decision).toBe('deny');
    expect(withProfiles.code).toBe('security/command-global-option');
    expect(withProfiles.overridable).toBe(false);
  });

  test('EV-06 (bis): a trampoline can never be ALLOWLISTED — an exact `allow` rule for `sh` still only asks', () => {
    // ADR-0024 item 3: trampolines "cannot be allowlisted"; the single escape hatch is an exact-argv rule under
    // `policy.dangerousCommands`, and "every use is `ask`". A `CommandRule` carries no marker separating such a
    // rule from an ordinary `policy.commands` allow, so the evaluator coerces the decision itself.
    const shAllow = rule({
      id: 'sh-allow',
      program: 'sh',
      positionals: { kind: 'exact', values: ['-c', 'echo hi'] },
      decision: 'allow',
    });
    const evaluator = engine();
    const result = evaluator.evaluate(commandRequest(['sh', '-c', 'echo hi']), commandPolicy([shAllow]), baseContext());
    expect(result.decision).toBe('ask');
    expect(result.decision).not.toBe('allow');
    expect(result.ruleId).toBe('sh-allow');
    expect(result.reason).toMatch(/trampoline/);

    // A rule that says `deny` keeps its deny: the coercion only ever tightens.
    const shDeny = rule({
      id: 'sh-deny',
      program: 'sh',
      positionals: { kind: 'exact', values: ['-c', 'echo hi'] },
      decision: 'deny',
    });
    const denied = evaluator.evaluate(commandRequest(['sh', '-c', 'echo hi']), commandPolicy([shDeny]), baseContext());
    expect(denied.decision).toBe('deny');
    expect(denied.ruleId).toBe('sh-deny');
  });

  test('EV-06 (ter): a project `checks:` entry cannot re-open the shell — `npx` never becomes an allow rule', () => {
    // `.cohorte/config.yaml` is project-controlled; minting `decision: 'allow'` from `checks.test: ['npx', …]`
    // would be exactly the V2 hole class ADR-0024 exists to close. Both layers refuse it: the rule data itself,
    // and the evaluator's trampoline step.
    const rules = checksToCommandRules({ test: ['npx', 'vitest'], timeoutMs: 1000 });
    expect(rules[0]?.decision).toBe('ask');

    const result = engine().evaluate(commandRequest(['npx', 'vitest']), commandPolicy(rules), baseContext());
    expect(result.decision).not.toBe('allow');
    expect(result.decision).toBe('ask');
  });

  test('EV-08/09 (bis): every re-targeting global is denied at parse time, whatever the policy data says', () => {
    const yarnInstall = rule({
      id: 'yarn-install',
      program: 'yarn',
      subcommand: ['install'],
      positionals: { kind: 'none' },
      decision: 'allow',
    });
    const composeUp = rule({
      id: 'compose-up',
      program: 'docker',
      subcommand: ['compose'],
      positionals: { kind: 'enum', values: ['up'], max: 1 },
      decision: 'allow',
    });
    // These two list the very option under test in `flags.allow`: the parse-time denial is DESIGN 2.6.4's primary
    // mechanism (EV-08/09 asserts the code, not a default-deny), so it must not depend on policy DATA at all.
    const gitLog = rule({
      id: 'git-log',
      program: 'git',
      subcommand: ['log'],
      flags: { allow: ['--config-env=core.pager=EVIL', '--attr-source=evil'] },
      positionals: { kind: 'none' },
      decision: 'allow',
    });
    const nodeAce = rule({
      id: 'node-ace',
      program: 'node',
      flags: { allow: ['--experimental-loader=./evil.mjs', '--env-file=.env'] },
      positionals: { kind: 'enum', values: ['ace'], max: 1 },
      decision: 'allow',
    });
    const evaluator = engine();
    const cases: readonly (readonly [string[], CommandRule])[] = [
      [['yarn', '--cwd=/elsewhere', 'install'], yarnInstall],
      [['yarn', '--cwd', '/elsewhere', 'install'], yarnInstall],
      [['docker', '--context=remote', 'compose', 'up'], composeUp],
      [['docker', '-H', 'tcp://evil:2375', 'compose', 'up'], composeUp],
      // The `=`-joined form does not consume a following token, so without this the subcommand and positionals
      // parse exactly as for the benign call and the plain allow rule matches the RE-TARGETED command.
      [['docker', '--config=/tmp/creds', 'compose', 'up'], composeUp],
      // Exact functional synonyms of options the DESIGN list does name: `--config-env` IS `-c` read from the
      // environment, `--experimental-loader` IS `--loader` under its documented alias. A synonym that parses as a
      // benign global leaves only the flags allowlist between the agent and the re-targeted command.
      [['git', '--config-env=core.pager=EVIL', 'log'], gitLog],
      [['git', '--super-prefix', 'x', 'log'], gitLog],
      [['git', '--attr-source=evil', 'log'], gitLog],
      [['node', '--experimental-loader=./evil.mjs', 'ace'], nodeAce],
      [['node', '--env-file=.env', 'ace'], nodeAce],
    ];
    for (const [argv, allowRule] of cases) {
      const result = evaluator.evaluate(commandRequest(argv), commandPolicy([allowRule]), baseContext());
      expect(result.decision, argv.join(' ')).toBe('deny');
      expect(result.code, argv.join(' ')).toBe('security/command-global-option');
      expect(result.ruleId).toBe('builtin/global-option');
      expect(result.command).toBeUndefined();
    }
  });

  test('EV-08/09 (ter): a re-targeting option AFTER the subcommand is caught too (pnpm accepts it anywhere)', () => {
    const pnpmInstall = rule({
      id: 'pnpm-install',
      program: 'pnpm',
      subcommand: ['install'],
      positionals: { kind: 'none' },
      decision: 'allow',
    });
    const result = engine().evaluate(
      commandRequest(['pnpm', 'install', '--dir=/elsewhere']),
      commandPolicy([pnpmInstall]),
      baseContext(),
    );
    expect(result.decision).toBe('deny');
    expect(result.code).toBe('security/command-global-option');
  });

  test('EV-10: docker-compose up alias-normalises to `docker compose up`', () => {
    const allowCompose = rule({
      id: 'compose-up',
      program: 'docker',
      subcommand: ['compose'],
      positionals: { kind: 'enum', values: ['up'], max: 1 },
      decision: 'allow',
    });
    const evaluator = engine();
    const viaAlias = evaluator.evaluate(
      commandRequest(['docker-compose', 'up']),
      commandPolicy([allowCompose]),
      baseContext(),
    );
    const viaCanonical = evaluator.evaluate(
      commandRequest(['docker', 'compose', 'up']),
      commandPolicy([allowCompose]),
      baseContext(),
    );
    // The SAME rule wins for both spellings (the alias normalises `compose` in for matching purposes) — but what
    // actually executes differs, correctly: `docker-compose` is a different binary from `docker`, invoked with
    // its own literal arguments, never with a synthetic `compose` prefix spliced in.
    expect(viaAlias.decision).toBe('allow');
    expect(viaAlias.ruleId).toBe('compose-up');
    expect(viaCanonical.ruleId).toBe('compose-up');
    expect(viaAlias.command?.args).toEqual(['up']);
    expect(viaCanonical.command?.args).toEqual(['compose', 'up']);
    expect(viaAlias.command?.file).not.toBe(viaCanonical.command?.file);
  });

  test('EV-11/12/13: no builtins, no subshells — the single `cwd` containment gate catches every attempt', () => {
    // `pushd <main> && ...`, `M=<main>; cd $M && ...` and `(cd <main>; ...)` all rely on a shell the product never
    // has. The residual, and only, guarantee is that `cwd` must canonicalise inside the agent's own worktree.
    // The third case is a lexical near-miss (not a real subdirectory): containment must check a `/` segment
    // boundary, never `startsWith` alone.
    for (const cwd of [MAIN_CHECKOUT, OTHER_WORKTREE, canonical(`${WORKTREE}-typo`)]) {
      const result = evaluate(['node', 'ace', 'serve'], STANDARD_RESOLVER, baseContext({ cwd }));
      expect(result.decision).toBe('deny');
      expect(result.ruleId).toBe('builtin/cwd-containment');
      expect(result.securityViolation).toBe(true);
    }
  });

  test('a denied verdict never carries a command to execute', () => {
    // Schema validity of every row above is asserted by `engine()` itself (`assertSchemaValid`); what the schema
    // cannot state is this cross-field property: `command` is "present unless denied".
    for (const result of [
      evaluate(['sh', '-c', 'x']),
      evaluate(['git', '-C', '.', 'commit']),
      evaluate(['node', 'ace', 'serve'], STANDARD_RESOLVER, baseContext({ cwd: MAIN_CHECKOUT })),
    ]) {
      expect(result.decision).toBe('deny');
      expect(result.command).toBeUndefined();
    }
  });
});
