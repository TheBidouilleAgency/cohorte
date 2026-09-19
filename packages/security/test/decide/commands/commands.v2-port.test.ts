// Port of V2's 70 gate cases (groups A and B; `<SCRATCH>/understand/v2-security-isolation.md` §1.11), adapted to
// the V3 input shape `{ argv, cwd }` per DESIGN 7.4. Groups C, D, E, F, G are out of THIS unit's scope: C is
// `buildPolicySnapshot`'s job (config robustness), D/E/F are `TEST`-phase freshness (a different gate concept
// entirely), G (host dialects) is dropped by design. `createCommandPolicy` only ever sees an already-built
// `CommandPolicy` and one already-resolved `CommandContext.cwd` — it never reads project config or preflight state.
// A2 is out of scope for the same reason and has no case here: V2's A2 exercised a non-shell `Read` tool call
// falling through the gate untouched, and DESIGN 7.4 turns it into two PATH cases (in-grant read allowed,
// out-of-grant read denied). Path-typed tools go through stage 3 — `packages/security/src/decide/paths`, unit
// U1.02 — never through stage 4, and `CommandRequest` has no shape that could represent such a call.
import { describe, expect, test } from 'vitest';
import { createCommandPolicy } from '../../../src/decide/commands/index.ts';
import {
  assertSchemaValid,
  baseContext,
  canonical,
  commandPolicy,
  commandRequest,
  DETACHED,
  fakeBranches,
  MAIN_CHECKOUT,
  OTHER_WORKTREE,
  PROTECTED_BRANCH,
  rule,
  STANDARD_RESOLVER,
  UNPROTECTED_BRANCH,
  WORKTREE,
} from './fixtures.ts';

// ── Group A: command gating, ported onto `node ace <script>` (a program WITH a profile: `node`) ────────────────

const A_RULES = [
  rule({
    id: 'deny-migration-fresh',
    program: 'node',
    subcommand: ['ace'],
    positionals: { kind: 'exact', values: ['migration:fresh'] },
    decision: 'deny',
  }),
  rule({
    id: 'deny-db-wipe',
    program: 'node',
    subcommand: ['ace'],
    positionals: { kind: 'exact', values: ['db:wipe'] },
    decision: 'deny',
  }),
  rule({
    id: 'ask-migration-run',
    program: 'node',
    subcommand: ['ace'],
    positionals: { kind: 'exact', values: ['migration:run'] },
    decision: 'ask',
  }),
  // Overlaps `deny-db-wipe` on the SAME call: makes A11 ("deny wins over ask") non-vacuous, per the pack's note.
  rule({
    id: 'ask-db-tier',
    program: 'node',
    subcommand: ['ace'],
    positionals: { kind: 'enum', values: ['db:wipe', 'db:seed'], max: 1 },
    decision: 'ask',
  }),
];

/** Every row of the ported tables goes through `evalA`/`evalB`, and each asserts its verdict schema-valid: that is
 * plan.json's fourth `commands` test, which DESIGN 7.4 states over "every verdict of every table row" (it is what
 * replaced the dropped G1-G9 host-dialect group). */
function evalA(argv: string[], context = baseContext()) {
  const engine = createCommandPolicy({ programs: STANDARD_RESOLVER, branches: fakeBranches({}) });
  return assertSchemaValid(engine.evaluate(commandRequest(argv), commandPolicy(A_RULES), context));
}

describe('Group A: command gating (argv, never a shell string)', () => {
  test('A1 inverted: an unprofiled, unlisted command is denied (V2 allowed `ls -la` by falling through)', () => {
    // V2's A1 returned "allow (null)" for anything no tier matched. I2 inverts it: the default branch is deny, and
    // a program without a profile can only ever be reached by an `exact` argv rule (DESIGN 2.6.4 step 4).
    const result = evalA(['ls', '-la']);
    expect(result.decision).toBe('deny');
    expect(result.ruleId).toBe('builtin/resolve'); // not even on the pinned PATH of this fixture
    const onPath = evalA(['echo', '-n']);
    expect(onPath.decision).toBe('deny');
    expect(onPath.ruleId).toBe('builtin/no-rule');
  });

  test('A3: node ace migration:fresh -> deny', () => {
    const result = evalA(['node', 'ace', 'migration:fresh']);
    expect(result.decision).toBe('deny');
    expect(result.ruleId).toBe('deny-migration-fresh');
  });

  test('A4: node ace migration:run -> ask', () => {
    const result = evalA(['node', 'ace', 'migration:run']);
    expect(result.decision).toBe('ask');
    expect(result.ruleId).toBe('ask-migration-run');
  });

  test('A5/A6/A7/A8/A9/A12/A13 adapted: a chain is not representable — it is always TWO gated tool calls', () => {
    // V2 chained with `;`/`&&`/`||`/`|`/`\n` inside one shell string: A5 `cd apps/api && node ace migration:run`,
    // A7 `cat x | psql`, A8 `false || node ace migration:fresh`, A6/A9/A12/A13 the rest. `argv` has no separator
    // token at all (I3): the model must issue each leg as a SEPARATE CommandRequest, and each is evaluated
    // independently against the same policy. The `cd` leg of A5 is not a command at all — `cwd` is a validated
    // field of the request (group B below); the `|` of A7 has no representation whatsoever.
    const first = evalA(['node', 'ace', 'migration:run']);
    const second = evalA(['node', 'ace', 'migration:fresh']);
    expect(first.decision).toBe('ask');
    expect(second.decision).toBe('deny');
    // A separator that survives as a LITERAL token is just an unmatched positional, never an operator.
    const asLiteral = evalA(['node', 'ace', 'migration:run', '&&', 'migration:fresh']);
    expect(asLiteral.decision).toBe('deny');
    expect(asLiteral.ruleId).toBe('builtin/no-rule');
  });

  test('A10 adapted: whitespace normalisation does not apply — argv tokens are already split', () => {
    // V2 collapsed `node   ace    migration:run` via a whitespace regex before matching. In V3 the tokens arrive
    // pre-split, so an extra-whitespace token is simply a DIFFERENT (unmatched) token, denied by default.
    const result = evalA(['node', 'ace', ' migration:run ']);
    expect(result.decision).toBe('deny');
    expect(result.ruleId).toBe('builtin/no-rule');
  });

  test('A11 (non-vacuous): deny wins over ask when both match the SAME call', () => {
    const result = evalA(['node', 'ace', 'db:wipe']);
    expect(result.decision).toBe('deny');
    expect(result.ruleId).toBe('deny-db-wipe');
    expect(result.evaluatedRules).toContain('ask-db-tier');
  });

  test('A14: an unrelated command is not denied', () => {
    const result = evalA(['node', 'ace', 'serve']);
    expect(result.decision).toBe('deny'); // default-deny (I2): unlisted is not "allowed", but not the migration rule
    expect(result.ruleId).toBe('builtin/no-rule');
  });

  test('A15: echo "node ace db:wipe" is evaluated as `echo`, never as the node rule (EV-02 mechanism)', () => {
    const result = evalA(['echo', 'node ace db:wipe']);
    expect(result.decision).toBe('deny');
    // The verdict comes from evaluating `echo` on its own terms (default-deny, no rule for it) — never from the
    // node/ace/db:wipe deny rule, which never even applies to a different program.
    expect(result.ruleId).toBe('builtin/no-rule');
    expect(result.evaluatedRules).not.toContain('deny-db-wipe');
  });

  test("A16: ['sh', '-c', ...] -> deny security/command-trampoline", () => {
    const result = evalA(['sh', '-c', 'node ace db:wipe']);
    expect(result.decision).toBe('deny');
    expect(result.code).toBe('security/command-trampoline');
    expect(result.overridable).toBe(false);
  });

  test("A17-A19 adapted: an unanswerable `ask` is this stage's OUTPUT, not its concern", () => {
    // V2 turned `ask` into `deny` itself when `permission_mode==='bypassPermissions'`. In V3, DESIGN 2.6.2 assigns
    // that escalation to stage 6 (the approval gate: `policy.approvals.unattended: 'deny'|'wait'`), a port
    // CommandContext carries no such field. This stage's contract is to return 'ask' faithfully; the approval-gate
    // unit is responsible for the unattended-run escalation and its own `/nobody to confirm/`-shaped reason.
    const result = evalA(['node', 'ace', 'migration:run']);
    expect(result.decision).toBe('ask');
  });
});

// ── Group B: branch-conditional, ported onto `docker compose up` (`git commit` is unconditionally denied by D9,
// so it cannot demonstrate branch-conditionality in V3 at all) ──────────────────────────────────────────────────

const COMPOSE_RULE = rule({
  id: 'compose-up-unprotected',
  program: 'docker',
  subcommand: ['compose'],
  positionals: { kind: 'enum', values: ['up'], max: 1 },
  decision: 'allow',
  when: { branch: 'unprotected-only' },
});

const NESTED_CWD = canonical(`${WORKTREE}/apps/web`);

function evalB(argv: string[], context = baseContext()) {
  const branches = fakeBranches({
    [WORKTREE]: PROTECTED_BRANCH,
    [NESTED_CWD]: UNPROTECTED_BRANCH,
  });
  const engine = createCommandPolicy({ programs: STANDARD_RESOLVER, branches });
  return assertSchemaValid(engine.evaluate(commandRequest(argv), commandPolicy([COMPOSE_RULE]), context));
}

describe('Group B: branch-conditional (docker compose up, since D9 makes git commit unconditional)', () => {
  test('B1: on the agent worktree, protected branch -> deny (no rule survives `when`)', () => {
    const result = evalB(['docker', 'compose', 'up']);
    expect(result.decision).toBe('deny');
    expect(result.ruleId).toBe('builtin/no-rule');
  });

  test('B2/B3: on an unprotected branch -> allow', () => {
    const context = baseContext({ cwd: NESTED_CWD });
    const result = evalB(['docker', 'compose', 'up'], context);
    expect(result.decision).toBe('allow');
    expect(result.ruleId).toBe('compose-up-unprotected');
    expect(result.command?.args).toEqual(['compose', 'up']);
  });

  test('B4: branch resolves at `cwd` itself (a subdirectory), not at the worktree root', () => {
    // The worktree ROOT reports protected; the nested `cwd` reports unprotected. Allow proves `branchOf` was
    // called with `context.cwd`, not `context.worktree`.
    const context = baseContext({ cwd: NESTED_CWD });
    expect(evalB(['docker', 'compose', 'up'], context).decision).toBe('allow');
    expect(evalB(['docker', 'compose', 'up'], baseContext()).decision).toBe('deny');
  });

  test('B5: an unknown/unreadable branch (detached HEAD, git cannot answer) is PROTECTED, not gated-open', () => {
    // The V2 hole DESIGN 7.4 calls out by name: detached HEAD must not read as "not the default branch".
    const branches = fakeBranches({ [WORKTREE]: DETACHED });
    const engine = createCommandPolicy({ programs: STANDARD_RESOLVER, branches });
    const result = assertSchemaValid(
      engine.evaluate(commandRequest(['docker', 'compose', 'up']), commandPolicy([COMPOSE_RULE]), baseContext()),
    );
    expect(result.decision).toBe('deny');
  });

  test.for([
    ['the main checkout', MAIN_CHECKOUT],
    ["another agent's worktree", OTHER_WORKTREE],
    // A lexical near-miss, not a real subdirectory: `isContainedIn` must check a `/` SEGMENT boundary, never
    // `startsWith` alone (DESIGN 2.6.3 step 4's caution: `apps/api` must not contain `apps/api-gateway`).
    ['a sibling whose name merely starts the same way', canonical('/w/run_1/frontend-typo')],
  ] as const)(
    "B6-B13 consolidated: cwd outside the agent's own worktree (%s) -> deny, whatever argv says",
    ([_label, cwd]) => {
      // V2 tracked a shell `cd` across many syntactic forms (quotes, `cd -`, `$(mktemp -d)`, subshells: EV-11..13
      // cover those). `run_command` has one explicit `cwd` field and no shell, so every one of those forms
      // collapses to this single containment property.
      const context = baseContext({ cwd });
      const result = evalB(['docker', 'compose', 'up'], context);
      expect(result.decision).toBe('deny');
      expect(result.ruleId).toBe('builtin/cwd-containment');
      expect(result.securityViolation).toBe(true);
    },
  );

  test('B14/B15: an unconditional (no `when.branch`) tier applies on EITHER branch', () => {
    // V2 proved "unconditional tiers ignore `cd`" (B14 deny, B15 ask) by moving cwd to the feature worktree. In
    // V3 the agent's own worktree is fixed (CommandContext.worktree); the equivalent property is that a rule with
    // no `when.branch` matches regardless of which branch that SAME cwd happens to report.
    const unconditionalDeny = rule({
      id: 'deny-db-wipe-unconditional',
      program: 'node',
      subcommand: ['ace'],
      positionals: { kind: 'exact', values: ['db:wipe'] },
      decision: 'deny',
    });
    for (const branch of [PROTECTED_BRANCH, UNPROTECTED_BRANCH, DETACHED]) {
      const branches = fakeBranches({ [WORKTREE]: branch });
      const engine = createCommandPolicy({ programs: STANDARD_RESOLVER, branches });
      const result = assertSchemaValid(
        engine.evaluate(commandRequest(['node', 'ace', 'db:wipe']), commandPolicy([unconditionalDeny]), baseContext()),
      );
      expect(result.decision).toBe('deny');
      expect(result.ruleId).toBe('deny-db-wipe-unconditional');
    }
  });
});
