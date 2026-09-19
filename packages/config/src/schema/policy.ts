// Policy DATA shapes (DESIGN 2.6.3, 2.6.4): declared here, evaluated by @cohorte/security. `config` never imports `security`.
import { type Static, type TUnsafe, Type } from 'typebox';

const closed = { additionalProperties: false } as const;
const tokens = () => Type.Array(Type.String({ minLength: 1 }));

export const COMMAND_RULE_ORIGINS = ['builtin', 'project-config', 'project-checks'] as const;

/** DESIGN 2.6.4, verbatim. */
export interface CommandRule {
  id: string;
  program: string;
  /** exact tokens, e.g. ['run','test'] */
  subcommand?: readonly string[];
  /** anything not allowed is denied */
  flags?: { allow: readonly string[]; deny?: readonly string[] };
  positionals?:
    | { kind: 'none' }
    | { kind: 'paths-in-worktree'; max: number }
    | { kind: 'enum'; values: readonly string[]; max: number }
    | { kind: 'exact'; values: readonly string[] };
  decision: 'allow' | 'ask' | 'deny';
  when?: { branch?: 'any' | 'unprotected-only'; roles?: readonly string[]; phases?: readonly string[] };
  /** drives recovery (DESIGN 4.1) */
  replay: 'idempotent' | 'at-most-once';
  /** true => denied under L0; under L1 it fails closed in the sandbox */
  network: boolean;
  origin: (typeof COMMAND_RULE_ORIGINS)[number];
}

const max = () => Type.Integer({ minimum: 0 });

const CommandRuleSchema = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    // A bare program name: a path separator can never name a program (DESIGN 2.6.4 step 1).
    program: Type.String({ pattern: '^[^/\\\\\\s]+$' }),
    subcommand: Type.Optional(tokens()),
    flags: Type.Optional(Type.Object({ allow: tokens(), deny: Type.Optional(tokens()) }, closed)),
    positionals: Type.Optional(
      Type.Union([
        Type.Object({ kind: Type.Literal('none') }, closed),
        Type.Object({ kind: Type.Literal('paths-in-worktree'), max: max() }, closed),
        Type.Object({ kind: Type.Literal('enum'), values: tokens(), max: max() }, closed),
        Type.Object({ kind: Type.Literal('exact'), values: Type.Array(Type.String()) }, closed),
      ]),
    ),
    decision: Type.Union([Type.Literal('allow'), Type.Literal('ask'), Type.Literal('deny')]),
    when: Type.Optional(
      Type.Object(
        {
          branch: Type.Optional(Type.Union([Type.Literal('any'), Type.Literal('unprotected-only')])),
          roles: Type.Optional(tokens()),
          phases: Type.Optional(tokens()),
        },
        closed,
      ),
    ),
    replay: Type.Union([Type.Literal('idempotent'), Type.Literal('at-most-once')]),
    network: Type.Boolean(),
    origin: Type.Union([Type.Literal('builtin'), Type.Literal('project-config'), Type.Literal('project-checks')]),
  },
  closed,
);

/** [S]. The explicit annotation keeps Biome's type inference out of the union (docs/v3/requests/U0.02.md R1). */
export const CommandRule: TUnsafe<CommandRule> = Type.Unsafe<CommandRule>(CommandRuleSchema);

/** [S] DESIGN 2.6.3. Default: deny-outgoing + deny. */
export const SymlinkPolicy = Type.Object(
  {
    mode: Type.Union([Type.Literal('deny-outgoing'), Type.Literal('deny-all'), Type.Literal('allow')]),
    hardlinksOnWrite: Type.Union([Type.Literal('deny'), Type.Literal('allow')]),
  },
  closed,
);
export type SymlinkPolicy = Static<typeof SymlinkPolicy>;

/**
 * [S] What stage 4 evaluates for `network_request`. V3.0 has exactly one value: the tool is registered and always
 * denied (DESIGN 2.6.2, §9 "proxy-based host allowlisting" is out). The shape exists so a later version can add
 * an allowlist without moving the type.
 */
export const NetworkPolicyConfig = Type.Object({ default: Type.Literal('deny') }, closed);
export type NetworkPolicyConfig = Static<typeof NetworkPolicyConfig>;

export const DEFAULT_SYMLINK_POLICY: SymlinkPolicy = Object.freeze({ mode: 'deny-outgoing', hardlinksOnWrite: 'deny' });
export const DEFAULT_NETWORK_POLICY: NetworkPolicyConfig = Object.freeze({ default: 'deny' });
