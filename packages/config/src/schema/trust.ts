// What the repository may decide, and what only the local user may decide (DESIGN 2.10.1, ADR-0026): the key-trust
// classification as frozen DATA, the trust record, and the TrustStore PORT that `security` implements and the
// loader consumes (`config` may not import `security`).
import { IsoInstant, type JsonValue, Sha256 } from '@cohorte/base';
import { type TUnsafe, Type } from 'typebox';

export const TRUST_CLASSES = ['tighten-only', 'loosen', 'neutral'] as const;
export type TrustClass = (typeof TRUST_CLASSES)[number];

export interface ConfigKeyTrustRule {
  /**
   * JSON pointer into `CohorteConfig`. A rule covers the key it names AND its whole subtree. Rules are prefix-disjoint:
   * no pointer is an ancestor of another one, so a key has exactly one class.
   */
  pointer: string;
  class: TrustClass;
  /**
   * Only on a `loosen` rule whose class depends on the VALUE (DESIGN 2.10.1: `sandbox.require: best-effort`,
   * `policy.symlinks` towards `allow`, ...): the values that loosen. Every other value of the key is `tighten-only`.
   */
  loosenOnly?: readonly JsonValue[];
}

const tighten = (pointer: string): ConfigKeyTrustRule => Object.freeze({ pointer, class: 'tighten-only' });
const neutral = (pointer: string): ConfigKeyTrustRule => Object.freeze({ pointer, class: 'neutral' });
const loosen = (pointer: string, ...loosenOnly: JsonValue[]): ConfigKeyTrustRule =>
  Object.freeze(
    loosenOnly.length === 0
      ? { pointer, class: 'loosen' }
      : { pointer, class: 'loosen', loosenOnly: Object.freeze(loosenOnly) },
  );

/** DESIGN 2.10.1, as data. TOTAL over `CohorteConfig` (a unit test enumerates the schema). */
export const CONFIG_KEY_TRUST: readonly ConfigKeyTrustRule[] = Object.freeze([
  neutral('/schemaVersion'),
  neutral('/project'),
  neutral('/runtime/id'),
  loosen('/runtime/pi'),
  neutral('/authentication/mode'),
  loosen('/authentication/allowApiKeys'),
  loosen('/authentication/anthropicSubscriptionViaPi'),
  loosen('/routing/allowedProviders'),
  neutral('/routing/defaults'),
  neutral('/routing/tiers'),
  neutral('/routing/escalation'),
  loosen('/routing/fallback'),
  tighten('/budgets'),
  tighten('/loop'),
  loosen('/checks'),
  loosen('/provision/argv'),
  loosen('/provision/network'),
  loosen('/provision/cacheDirs'),
  neutral('/provision/lockfiles'),
  loosen('/provision/env'),
  loosen('/provision/dependencyDirs'),
  loosen('/provision/writableCaches'),
  loosen('/policy/commands/allow'),
  tighten('/policy/commands/ask'),
  tighten('/policy/commands/deny'),
  loosen('/policy/dangerousCommands'),
  loosen('/policy/symlinks/mode', 'allow'),
  loosen('/policy/symlinks/hardlinksOnWrite', 'allow'),
  loosen('/policy/approvals/unattended', 'wait'),
  tighten('/policy/approvals/expiryMinutes'),
  tighten('/policy/approvals/parkAfterMinutes'),
  loosen('/policy/approvals/ship', 'auto'),
  neutral('/policy/approvals/notify'),
  loosen('/policy/approvals/autoResume'),
  loosen('/policy/inDoubt', 'continue'),
  loosen('/policy/skip'),
  loosen('/policy/steer'),
  loosen('/policy/admin'),
  neutral('/policy/quota'),
  neutral('/host'),
  loosen('/network/proxyEnv'),
  loosen('/sandbox/require', 'best-effort'),
  loosen('/sandbox/brain', 'process'),
  loosen('/git/worktreeRoot'),
  neutral('/git/branchPrefix'),
  neutral('/git/commitIdentity'),
  neutral('/git/keepWorktrees'),
  tighten('/retention'),
  neutral('/telemetry'),
]);

const covers = (rule: ConfigKeyTrustRule, pointer: string): boolean =>
  pointer === rule.pointer || pointer.startsWith(`${rule.pointer}/`);

/** Every rule that covers `pointer`. The data is total and prefix-disjoint, so this has exactly one member for a real key. */
export function trustRulesFor(pointer: string): ConfigKeyTrustRule[] {
  return CONFIG_KEY_TRUST.filter((rule) => covers(rule, pointer));
}

/**
 * The class of one key of the PROJECT file. `value` decides for the keys classed by value; without it such a key is
 * reported `loosen` (fail closed). An unknown key is `loosen` too: nothing unclassified is ever honoured silently.
 */
export function trustClassOf(pointer: string, value?: JsonValue): TrustClass {
  const [rule, ...others] = trustRulesFor(pointer);
  if (rule === undefined || others.length > 0) return 'loosen';
  if (rule.class !== 'loosen' || rule.loosenOnly === undefined || value === undefined) return rule.class;
  if (pointer !== rule.pointer) return 'loosen';
  return rule.loosenOnly.some((candidate) => candidate === value) ? 'loosen' : 'tighten-only';
}

/** One file per project: `~/.cohorte/trust/<projectKeyId>.json`, `0600` in a `0700` directory, a protected root. */
export interface TrustRecord {
  /** sha256(canonicalJson(the project file's values for every loosen-class key + ownership.yaml)) */
  policySha256: Sha256;
  /** JSON pointers of the loosening keys the user saw and accepted */
  loosenedKeys: string[];
  grantedAt: IsoInstant;
  /** a label for the audit trail (the OS user name); the MAC proves "a key holder", never which one (ADR-0022) */
  grantedBy: string;
  /** HMAC-SHA256 with the project key over the canonical JSON of the record minus `mac` */
  mac: string;
}

/**
 * [S]. The type is written by hand and the const annotated: a `Promise<Static<...>>` that Biome has to resolve for
 * nursery/noFloatingPromises overflows its stack, and a crashed Biome exits 0 (docs/v3/requests/U0.02.md R1).
 */
export const TrustRecord: TUnsafe<TrustRecord> = Type.Unsafe<TrustRecord>(
  Type.Object(
    {
      policySha256: Sha256,
      loosenedKeys: Type.Array(Type.String()),
      grantedAt: IsoInstant,
      grantedBy: Type.String({ minLength: 1 }),
      mac: Type.String({ minLength: 1 }),
    },
    { additionalProperties: false },
  ),
);

export interface TrustGrant {
  policySha256: Sha256;
  loosenedKeys: string[];
  grantedBy: string;
}

/**
 * PORT (file implementation: `@cohorte/security/auth`, `createTrustStore`). A record with a bad MAC or wrong file
 * modes is ABSENT: `lookup` fails closed.
 */
export interface TrustStore {
  /** The record, only if it is authentic AND was granted for exactly this policy hash. */
  lookup(projectKeyId: string, policySha256: Sha256): Promise<TrustRecord | undefined>;
  grant(projectKeyId: string, grant: TrustGrant): Promise<TrustRecord>;
  /** false = there was nothing to revoke */
  revoke(projectKeyId: string): Promise<boolean>;
}
