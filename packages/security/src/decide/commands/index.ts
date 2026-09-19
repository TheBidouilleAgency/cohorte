// Command policy evaluation (DESIGN 2.6.4, ADR-0024, ADR-0007): a parsed-argv allowlist, never a shell-string
// matcher. `createCommandPolicy` implements the six evaluation steps verbatim:
//
//   1. `argv[0]` is a bare name, resolved to an absolute realpath through the PATH pinned at run start.
//   2. Trampolines (`sh`, `python*`, `pi`, `cohorte`, ...) are denied, `overridable: false`. The single escape hatch
//      is an exact-argv rule under `policy.dangerousCommands`, and ADR-0024 item 3 is categorical about it: a
//      trampoline "cannot be allowlisted" and "every use is `ask`". A `CommandRule` carries no marker telling a
//      `dangerousCommands` rule from a `policy.commands.allow` one (both are `origin: 'project-config'`), so this
//      evaluator RE-ASSERTS the coercion itself: a matching rule that says `deny` denies, anything else asks.
//   3. Agents have a built-in, non-overridable deny on `git commit|push|merge|...` (D9 / ADR-0007), independent of
//      any rule.
//   4. A program WITH a `ProgramProfile` is parsed structurally and matched by `(program, subcommand, flags,
//      positionals)`; a program without one can only be matched by an `exact`-argv rule (used by both
//      `dangerousCommands` and `config.checks`, via `checksToCommandRules`).
//   5. No rule matches => deny; among several matches, deny beats ask beats allow.
//   6. `cwd` must canonicalise inside the agent's own worktree; a rule's `when.branch: 'unprotected-only'` treats a
//      detached/unknown branch as protected (never matches).
//
// Deviation (recorded, does not affect any test in this unit's own scope): this evaluator checks `cwd` containment
// EARLY, as a precondition, rather than as literally the last of the six steps — nothing downstream can matter once
// `cwd` has escaped the agent's own worktree, and evaluating it early means `when.branch` matching always has a
// resolved branch to work with. The set of calls this denies is identical either way.
//
// Deviation: DESIGN's parenthetical for EV-01 says the node profile "canonicalises the script positional to a
// worktree-relative realpath". `CommandPolicyOptions` carries no `PathResolver` (only `programs` and `branches`),
// so this unit does not perform that canonicalisation itself: a positional that does not literally match a rule is
// denied by the plain "no rule matches" default (§5), which is the same security outcome. Full realpath
// canonicalisation of `run_command` POSITIONAL arguments, if ever wanted, needs a `PathResolver` threaded into
// this contract — filed as an FYI in docs/v3/requests/U1.03.md, not a blocker.
import type { CohorteConfig, CommandRule } from '@cohorte/config/schema';
import { type TSchema, Type } from 'typebox';
import type {
  BranchResolver,
  CanonicalPath,
  CommandPolicy,
  CommandRequest,
  NormalizedCall,
  ParsedCommand,
  ProgramProfile,
  ProgramResolver,
} from '../../contract/index.ts';
import { AGENT_GIT_DENIED_SUBCOMMANDS, isTrampoline } from '../../contract/index.ts';
import { BUILTIN_PROFILES, canonicalProgramName, findProfile } from './profiles.ts';

export { createProgramResolver, type ProgramResolverFs, type ProgramResolverOptions } from './resolver.ts';
export { BUILTIN_PROFILES, canonicalProgramName, findProfile };

export interface CommandContext {
  /** the agent's own worktree: `cwd` must canonicalise inside it */
  worktree: CanonicalPath;
  /** `CommandRequest.cwd`, already resolved by stage 3 */
  cwd: CanonicalPath;
  role: string;
  phase: string;
  /** under L0 a rule flagged `network` is denied */
  sandboxLevel: 'L0-process' | 'L1-os';
  defaultTimeoutMs: number;
}

/** Stage 4 for `run_command`: deny over ask over allow; no rule => deny. */
export interface CommandEvaluation {
  decision: 'allow' | 'ask' | 'deny';
  ruleId: string;
  /** the error code of a deny, e.g. 'security/command-trampoline' */
  code?: string;
  reason: string;
  overridable: boolean;
  securityViolation: boolean;
  evaluatedRules: string[];
  /** present unless denied: what will actually execute */
  command?: NonNullable<NormalizedCall['command']>;
}

export interface CommandPolicyEvaluator {
  evaluate(request: CommandRequest, policy: CommandPolicy, context: CommandContext): CommandEvaluation;
}

export interface CommandPolicyOptions {
  programs: ProgramResolver;
  branches: BranchResolver;
  /** default: the built-in profiles (git, pnpm, npm, yarn, node, docker) */
  profiles?: readonly ProgramProfile[];
}

type BranchInfo = ReturnType<BranchResolver['branchOf']>;

// ── structural helpers ────────────────────────────────────────────────────────────────────────

const tokensEqual = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((value, index) => value === b[index]);

/** `path` inside `root`, by path SEGMENTS (never `startsWith` alone: `/w/api` must not contain `/w/api-gateway`). */
const isContainedIn = (path: string, root: string): boolean => path === root || path.startsWith(`${root}/`);

/**
 * "Anything not allowed is denied" (DESIGN 2.6.4) is a rule about what may be PERMITTED, so the allowlist only ever
 * narrows an `allow` rule — where narrowing fails closed. Applied to a `deny` or an `ask` rule it narrows in the
 * other direction: the restrictive rule stops matching as soon as a flag it did not declare is present, while a
 * broader `allow` rule that DOES list that flag keeps matching, and `deny > ask > allow` (step 5) is defeated by one
 * token (`pnpm --silent run build`). A restrictive rule therefore matches on program + subcommand + positionals
 * alone. Recorded in docs/v3/requests/U1.03.md R4 item 3.
 */
function flagsMatch(flags: readonly string[], rule: CommandRule): boolean {
  if (flags.length === 0 || rule.decision !== 'allow') return true;
  const spec = rule.flags;
  if (spec === undefined) return false; // "anything not allowed is denied": no allowlist => no flag may be present
  return flags.every((flag) => !spec.deny?.includes(flag) && spec.allow.includes(flag));
}

/** Structural, not filesystem-aware: real containment/symlink checks of path-typed arguments are stage 3's job. */
const looksLikeWorktreeRelativePath = (value: string): boolean =>
  !value.startsWith('-') && !value.startsWith('/') && !value.startsWith('~') && !value.split(/[/\\]/).includes('..');

function positionalsMatch(positionals: readonly string[], spec: CommandRule['positionals']): boolean {
  if (spec === undefined) return positionals.length === 0;
  switch (spec.kind) {
    case 'none':
      return positionals.length === 0;
    case 'exact':
      return tokensEqual(positionals, spec.values);
    // Both value-bearing kinds have a LOWER bound too: `every()` over an empty array is vacuously true, so without
    // it a rule written for `pnpm run test` also matched the bare `pnpm run`, and one for `git add <paths>` the
    // argument-less `git add` — every such rule silently wider than its author wrote it.
    case 'enum':
      return (
        positionals.length > 0 &&
        positionals.length <= spec.max &&
        positionals.every((value) => spec.values.includes(value))
      );
    case 'paths-in-worktree':
      return (
        positionals.length > 0 && positionals.length <= spec.max && positionals.every(looksLikeWorktreeRelativePath)
      );
  }
}

/** A rule with no `subcommand`, no `flags` and `positionals.kind: 'exact'` matches the WHOLE rest of argv, whether
 * or not the program has a profile: this is how `dangerousCommands` and `checksToCommandRules` rules match. */
function matchesExactArgv(rule: CommandRule, rest: readonly string[]): boolean {
  if (rule.subcommand !== undefined || rule.flags !== undefined) return false;
  const positionals = rule.positionals;
  return positionals !== undefined && positionals.kind === 'exact' && tokensEqual(rest, positionals.values);
}

/**
 * Only reachable for a profiled program: `(subcommand, flags, positionals)`, per DESIGN 2.6.4 step 4.
 *
 * The profile's structural split is deliberately shallow — the FIRST non-flag token is `subcommand`, every later
 * non-flag token is a positional — so a rule's `subcommand` is matched as a PREFIX of the whole non-flag token
 * stream. That is what makes DESIGN 2.6.4's own example (`subcommand: ['run','test']`) and `['compose','up']`
 * reachable, and it keeps `docker-compose up` ≡ `docker compose up`. The tokens the prefix consumes are removed
 * before the positional check; an absent or empty `subcommand` is "no subcommand constraint", not "never matches".
 *
 * Deviation (recorded): a rule's `flags` allowlist is matched against `globals` TOO, not only against the flags
 * that follow the subcommand. DESIGN 2.6.4 says of `flags` "anything not allowed is denied"; leaving the leading
 * globals unchecked would let `pnpm --silent run test` satisfy a rule written for `pnpm run test`, which fails
 * OPEN. Benign globals are still parsed as globals (EV-08/09: `git --no-pager push` still has subcommand `push`);
 * a policy that wants to permit one lists it in `flags.allow`.
 */
function matchesStructurally(rule: CommandRule, parsed: ParsedCommand): boolean {
  const tokens = [...parsed.subcommand, ...parsed.positionals];
  const required = rule.subcommand ?? [];
  if (required.length > tokens.length) return false;
  if (!required.every((token, index) => token === tokens[index])) return false;
  return (
    flagsMatch([...parsed.globals, ...parsed.flags], rule) &&
    positionalsMatch(tokens.slice(required.length), rule.positionals)
  );
}

/**
 * The D9 subcommand of a `git` call, if it is one of the denied ones (ADR-0007 item 2).
 *
 * With a structural parse in hand the subcommand is exact, and the profile has already denied every value-taking
 * re-targeting global. Without one — a caller passed `profiles` without git — nothing can tell a subcommand from a
 * global option's VALUE (`git --super-prefix x commit`), so every token is held against the set: conservative in
 * the only safe direction for an invariant that must not be switchable off.
 */
function deniedGitSubcommand(parsed: ParsedCommand | undefined, rest: readonly string[]): string | undefined {
  const denied = AGENT_GIT_DENIED_SUBCOMMANDS as readonly string[];
  if (parsed === undefined) return rest.find((token) => denied.includes(token));
  const subcommand = parsed.subcommand[0];
  return subcommand !== undefined && denied.includes(subcommand) ? subcommand : undefined;
}

function branchAllows(rule: CommandRule, branch: BranchInfo): boolean {
  const required = rule.when?.branch ?? 'any';
  return required === 'any' || (branch.kind === 'branch' && !branch.protected);
}

function whenMatches(rule: CommandRule, context: CommandContext, branch: BranchInfo): boolean {
  if (!branchAllows(rule, branch)) return false;
  if (rule.when?.roles && !rule.when.roles.includes(context.role)) return false;
  if (rule.when?.phases && !rule.when.phases.includes(context.phase)) return false;
  return true;
}

const DECISION_RANK: Record<CommandRule['decision'], number> = { deny: 0, ask: 1, allow: 2 };

/** deny beats ask beats allow (DESIGN 2.6.4 step 5, 2.6.2 precedence). `matches` must be non-empty. */
function pickWinner(matches: readonly CommandRule[]): CommandRule {
  return matches.reduce((best, rule) => (DECISION_RANK[rule.decision] < DECISION_RANK[best.decision] ? rule : best));
}

/** Every rule of `program`, structurally or exactly matching, whose `when` is satisfied. Records every rule id it
 * looked at in `evaluatedRules`, matched or not (`PolicyVerdict.evaluatedRules`, "for `cohorte policy explain`"). */
function matchRules(
  rules: readonly CommandRule[],
  program: string,
  rest: readonly string[],
  parsed: ParsedCommand | undefined,
  context: CommandContext,
  branch: BranchInfo,
  evaluatedRules: string[],
): CommandRule[] {
  const matches: CommandRule[] = [];
  for (const rule of rules) {
    if (rule.program !== program) continue;
    evaluatedRules.push(rule.id);
    const structurallyOk = parsed !== undefined && matchesStructurally(rule, parsed);
    const exactlyOk = matchesExactArgv(rule, rest);
    if ((structurallyOk || exactlyOk) && whenMatches(rule, context, branch)) matches.push(rule);
  }
  return matches;
}

// ── building the result ───────────────────────────────────────────────────────────────────────

interface DenyArgs {
  ruleId: string;
  code?: string;
  reason: string;
  overridable: boolean;
  securityViolation: boolean;
  evaluatedRules: string[];
}

function denyEval(args: DenyArgs): CommandEvaluation {
  const { ruleId, code, reason, overridable, securityViolation, evaluatedRules } = args;
  return {
    decision: 'deny',
    ruleId,
    reason,
    overridable,
    securityViolation,
    evaluatedRules,
    ...(code === undefined ? {} : { code }),
  };
}

function applyRule(
  rule: CommandRule,
  args: {
    resolvedFile: CanonicalPath;
    rest: readonly string[];
    context: CommandContext;
    timeoutMs: number | undefined;
    evaluatedRules: string[];
  },
): CommandEvaluation {
  const { resolvedFile, rest, context, timeoutMs, evaluatedRules } = args;
  // An explicit deny is reported as its own verdict, BEFORE the network guard: a `deny` rule that also carries
  // `network: true` is denied by policy, and saying `permission/network-denied` would misattribute it in the audit
  // event and in `cohorte policy explain`. Only an `allow`/`ask` rule can become a network denial.
  const overridable = rule.origin !== 'builtin';
  if (rule.decision === 'deny') {
    return denyEval({
      ruleId: rule.id,
      code: 'permission/command-not-allowed',
      reason: `denied by rule ${rule.id}`,
      overridable,
      securityViolation: false,
      evaluatedRules,
    });
  }
  // "network: true => denied under L0 (nothing enforces the deny); under L1 it fails closed in the sandbox."
  if (rule.network && context.sandboxLevel === 'L0-process') {
    return denyEval({
      ruleId: rule.id,
      code: 'permission/network-denied',
      reason: `rule ${rule.id} needs network access, which the L0 process sandbox cannot enforce a deny for`,
      overridable: false,
      securityViolation: false,
      evaluatedRules,
    });
  }
  const command: NonNullable<NormalizedCall['command']> = {
    file: resolvedFile,
    args: [...rest],
    cwd: context.cwd,
    ruleId: rule.id,
    replay: rule.replay,
    network: rule.network,
    timeoutMs: timeoutMs ?? context.defaultTimeoutMs,
  };
  return {
    decision: rule.decision === 'ask' ? 'ask' : 'allow',
    ruleId: rule.id,
    reason: rule.decision === 'ask' ? `rule ${rule.id} requires confirmation` : `allowed by rule ${rule.id}`,
    overridable: true,
    securityViolation: false,
    evaluatedRules,
    command,
  };
}

// ── the evaluator ─────────────────────────────────────────────────────────────────────────────

export function createCommandPolicy(options: CommandPolicyOptions): CommandPolicyEvaluator {
  const profiles = options.profiles ?? BUILTIN_PROFILES;
  return {
    evaluate(request: CommandRequest, policy: CommandPolicy, context: CommandContext): CommandEvaluation {
      const evaluatedRules: string[] = [];
      const argv = request.argv;
      const bareName = argv[0];

      if (bareName === undefined || bareName === '') {
        return denyEval({
          ruleId: 'builtin/argv-empty',
          code: 'permission/command-not-allowed',
          reason: 'argv is empty: there is no program to run',
          overridable: false,
          securityViolation: true,
          evaluatedRules,
        });
      }
      if (bareName.includes('/') || bareName.includes('\\')) {
        return denyEval({
          ruleId: 'builtin/bare-name',
          code: 'permission/command-not-allowed',
          reason: `argv[0] "${bareName}" is not a bare program name (DESIGN 2.6.4 step 1)`,
          overridable: false,
          securityViolation: true,
          evaluatedRules,
        });
      }

      evaluatedRules.push('builtin/resolve');
      const resolvedFile = options.programs.resolve(bareName);
      if (resolvedFile === undefined) {
        return denyEval({
          ruleId: 'builtin/resolve',
          code: 'permission/command-not-allowed',
          reason: `"${bareName}" does not resolve to a program on the PATH pinned at run start`,
          overridable: true,
          securityViolation: false,
          evaluatedRules,
        });
      }

      evaluatedRules.push('builtin/cwd-containment');
      if (!isContainedIn(context.cwd, context.worktree)) {
        return denyEval({
          ruleId: 'builtin/cwd-containment',
          code: 'permission/command-not-allowed',
          reason: `cwd "${context.cwd}" is outside the agent's own worktree "${context.worktree}"`,
          overridable: false,
          securityViolation: true,
          evaluatedRules,
        });
      }

      const branch = options.branches.branchOf(context.cwd);
      const match = findProfile(bareName, profiles);
      const canonicalName = match?.profile.program ?? bareName;
      const rest = argv.slice(1);

      // Step 2: trampolines. A trampoline is NEVER allowlisted (ADR-0024 item 3): the only escape hatch is an
      // exact-argv `dangerousCommands` rule, and "every use is `ask`". Since a `CommandRule` carries no marker
      // distinguishing such a rule from an ordinary `policy.commands` allow (both are `origin: 'project-config'`,
      // and `checksToCommandRules` mints rules from `.cohorte/config.yaml` too), the coercion the `PolicySnapshot`
      // contract promises is re-asserted here rather than trusted to the rule list: deny stays deny, everything
      // else becomes `ask`.
      evaluatedRules.push('builtin/trampolines');
      if (isTrampoline(bareName) || isTrampoline(canonicalName)) {
        const matches = matchRules(policy.rules, canonicalName, rest, undefined, context, branch, evaluatedRules);
        const winner = matches.length > 0 ? pickWinner(matches) : undefined;
        if (winner !== undefined) {
          const coerced: CommandRule = winner.decision === 'deny' ? winner : { ...winner, decision: 'ask' };
          const evaluation = applyRule(coerced, {
            resolvedFile,
            rest,
            context,
            timeoutMs: request.timeoutMs,
            evaluatedRules,
          });
          if (evaluation.decision !== 'ask') return evaluation;
          return {
            ...evaluation,
            reason: `"${bareName}" launches another program on behalf of the agent: rule ${winner.id} matches, but every use of a trampoline is \`ask\` (ADR-0024)`,
          };
        }
        return denyEval({
          ruleId: 'builtin/trampolines',
          code: 'security/command-trampoline',
          reason: `"${bareName}" would launch another program on behalf of the agent`,
          overridable: false,
          securityViolation: true,
          evaluatedRules,
        });
      }

      // Step 4: structural parse for a profiled program (denies a re-targeting global option on sight).
      let parsed: ParsedCommand | undefined;
      if (match !== undefined) {
        evaluatedRules.push('builtin/profile-parse');
        const outcome = match.profile.parse([...match.prefix, ...rest]);
        if (outcome.kind === 'denied') {
          return denyEval({
            ruleId: 'builtin/global-option',
            code: outcome.code,
            reason: outcome.reason,
            overridable: false,
            securityViolation: true,
            evaluatedRules,
          });
        }
        parsed = outcome;
      }

      // Step 3: agents have no commit capability (D9 / ADR-0007 item 2), unconditionally — including when the
      // caller's `profiles` list carries no git profile at all. `profiles` is a public option of this API, so
      // nesting this inside "a git profile was found" would let a caller switch a NON-OVERRIDABLE invariant off.
      if (canonicalName === 'git') {
        const subcommand = deniedGitSubcommand(parsed, rest);
        if (subcommand !== undefined) {
          evaluatedRules.push('builtin/agent-git-deny');
          return denyEval({
            ruleId: 'builtin/agent-git-deny',
            code: 'permission/command-not-allowed',
            reason: `agents may not run \`git ${subcommand}\`: Cohorte creates every commit (ADR-0007)`,
            overridable: false,
            securityViolation: true,
            evaluatedRules,
          });
        }
      }

      // Steps 4-5: structural (profiled) or exact-argv (unprofiled, or a profiled program's exact rule) matching.
      const matches = matchRules(policy.rules, canonicalName, rest, parsed, context, branch, evaluatedRules);
      if (matches.length === 0) {
        return denyEval({
          ruleId: 'builtin/no-rule',
          code: 'permission/command-not-allowed',
          reason: `no command rule matches "${[bareName, ...rest].join(' ')}"; the default is deny`,
          overridable: true,
          securityViolation: false,
          evaluatedRules,
        });
      }
      return applyRule(pickWinner(matches), {
        resolvedFile,
        rest,
        context,
        timeoutMs: request.timeoutMs,
        evaluatedRules,
      });
    },
  };
}

// ── `config.checks` -> CommandRule (DESIGN 2.6.4: "package.json scripts are reachable only as `pnpm run <name>`
// with `<name>` in an `enum`"; a check's own argv array becomes one `exact` rule instead) ──────────────────────

/** `config.checks.{typecheck,lint,test}` (argv arrays) become `exact`, `idempotent`, allowed rules: they are the
 * project's own, human-authored commands (`.cohorte/config.yaml` `checks:`), not something an approval gates.
 *
 * The one exception is a check whose `argv[0]` is a TRAMPOLINE (`checks.test: ['npx', 'vitest']`,
 * `['sh', '-c', …]`): `.cohorte/config.yaml` is project-controlled, so minting `decision: 'allow'` from it would
 * re-open the shell that ADR-0024 item 3 closes. Such a check becomes an `ask` rule — the same verdict the
 * evaluator's trampoline step would coerce it to, said honestly in the rule DATA so `cohorte policy explain`
 * shows it. */
export function checksToCommandRules(checks: CohorteConfig['checks']): CommandRule[] {
  const named: readonly (readonly [string, readonly string[] | undefined])[] = [
    ['typecheck', checks.typecheck],
    ['lint', checks.lint],
    ['test', checks.test],
  ];
  const rules: CommandRule[] = [];
  for (const [name, argv] of named) {
    if (argv === undefined || argv.length === 0) continue;
    const declared = argv[0];
    if (declared === undefined) continue;
    // `evaluate()` matches rules against the ALIAS-NORMALISED program name (EV-10), so a check declared with an
    // alias (`checks.test: ['docker-compose', 'up']`) must mint the canonical one or the rule is dead on arrival
    // and the project's own check command is denied. `exact` positionals stay `argv.slice(1)`: that is what is
    // compared against the literal `argv[1..]` of the request.
    const program = canonicalProgramName(declared, BUILTIN_PROFILES);
    rules.push({
      id: `checks/${name}`,
      program,
      positionals: { kind: 'exact', values: argv.slice(1) },
      decision: isTrampoline(declared) || isTrampoline(program) ? 'ask' : 'allow',
      replay: 'idempotent',
      network: false,
      origin: 'project-checks',
    });
  }
  return rules;
}

// ── schema, for "every returned verdict fragment is schema-valid" ────────────────────────────────────────────

const closed = { additionalProperties: false } as const;

/** [S] Mirrors `CommandEvaluation`; `command` mirrors `NormalizedCall['command']` of ../../contract/decisions.ts. */
export const CommandEvaluationSchema: TSchema = Type.Object(
  {
    decision: Type.Union([Type.Literal('allow'), Type.Literal('ask'), Type.Literal('deny')]),
    ruleId: Type.String({ minLength: 1 }),
    code: Type.Optional(Type.String({ minLength: 1 })),
    reason: Type.String(),
    overridable: Type.Boolean(),
    securityViolation: Type.Boolean(),
    evaluatedRules: Type.Array(Type.String()),
    command: Type.Optional(
      Type.Object(
        {
          file: Type.String({ minLength: 1 }),
          args: Type.Array(Type.String()),
          cwd: Type.String({ minLength: 1 }),
          ruleId: Type.String({ minLength: 1 }),
          replay: Type.Union([Type.Literal('idempotent'), Type.Literal('at-most-once')]),
          network: Type.Boolean(),
          timeoutMs: Type.Integer({ minimum: 0 }),
        },
        closed,
      ),
    ),
  },
  closed,
);
