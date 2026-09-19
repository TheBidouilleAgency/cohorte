import { sha256Hex } from '@cohorte/base';
import { compileSchema } from '@cohorte/protocol';
import { describe, expect, test } from 'vitest';
import {
  CommandRule,
  DEFAULT_NETWORK_POLICY,
  type FrozenSpec,
  frozenSpecProblems,
  literalPrefixOf,
  Manifest,
  NetworkPolicyConfig,
  type Ownership,
  ownershipProblems,
  patternsOverlap,
  SkillManifest,
  Spec,
  SymlinkPolicy,
  specContentSha256,
} from '../../src/schema/index.ts';
import { readSample } from './samples.ts';

const surface = (...paths: string[]) => ({ paths, owners: ['implementer'], reviewers: [] });

describe('Ownership: surfaces are disjoint, or explicitly `shared`', () => {
  test.for([
    ['apps/web/**', 'apps/web/src/ui/**', true],
    ['apps/api/**', 'apps/api-gateway/**', false],
    ['apps/api/**', 'apps/api', true],
    ['**/*.md', 'packages/db/**', true],
    ['packages/*/src/**', 'packages/db/**', true],
    ['docs/**', 'apps/**', false],
    ['./apps/web/**', 'apps/web/x.ts', true],
  ] as const)('%s vs %s overlap: %s', ([a, b, expected]) => {
    expect(patternsOverlap(a, b)).toBe(expected);
    expect(patternsOverlap(b, a)).toBe(expected);
  });

  test('the literal prefix stops at the first segment holding a glob metacharacter', () => {
    expect(literalPrefixOf('apps/web/src/**/*.ts')).toEqual(['apps', 'web', 'src']);
    expect(literalPrefixOf('apps/w*b/src')).toEqual(['apps']);
    expect(literalPrefixOf('**')).toEqual([]);
  });

  test('an overlap between two ordinary surfaces is a problem at the first offending path', () => {
    const ownership: Ownership = {
      surfaces: { web: surface('apps/web/**'), ui: surface('docs/**', 'apps/web/ui/**') },
    };
    const problems = ownershipProblems(ownership);
    expect(problems.map((problem) => problem.path)).toEqual(['/surfaces/web/paths/0']);
    expect(problems[0]?.message).toContain('"ui"');
  });

  test('the `shared` surface may overlap anything; paths of ONE surface may overlap each other', () => {
    const ownership: Ownership = {
      surfaces: {
        web: surface('apps/web/**', 'apps/web/src/**'),
        shared: surface('apps/**/*.config.ts', 'package.json'),
      },
    };
    expect(ownershipProblems(ownership)).toEqual([]);
  });
});

describe('Spec: feature | patch, draft | frozen', () => {
  const validate = compileSchema(Spec);
  const frozen = readSample('valid', 'spec.patch-frozen.yaml').document as FrozenSpec;

  test('a frozen spec carries the sha256 of its content; a draft carries none', () => {
    expect(frozen.status).toBe('frozen');
    expect(frozen.sha256).toBe(specContentSha256(frozen));
    const { sha256: _dropped, ...withoutHash } = frozen;
    expect(validate(withoutHash).ok).toBe(false);
    expect(validate({ ...withoutHash, status: 'draft' }).ok).toBe(true);
    expect(validate({ ...frozen, status: 'draft' }).ok, 'a draft with a sha256').toBe(false);
  });

  test('a frozen spec rejects edits', () => {
    expect(frozenSpecProblems(frozen)).toEqual([]);
    const edited: FrozenSpec = { ...frozen, acceptance: [...frozen.acceptance, 'and ship a discount engine'] };
    expect(validate(edited).ok, 'an edit is schema-valid: only the hash sees it').toBe(true);
    expect(frozenSpecProblems(edited).map((problem) => problem.path)).toEqual(['/sha256']);
  });

  test('the content hash ignores status and sha256, and nothing else', () => {
    const { sha256: _dropped, ...rest } = frozen;
    expect(specContentSha256({ ...rest, status: 'draft' })).toBe(frozen.sha256);
    expect(specContentSha256({ ...frozen, sha256: sha256Hex('other') })).toBe(frozen.sha256);
    expect(specContentSha256({ ...frozen, title: `${frozen.title}!` })).not.toBe(frozen.sha256);
  });

  test('kind is feature or patch', () => {
    expect(validate({ ...frozen, kind: 'epic' }).ok).toBe(false);
  });
});

describe('Manifest', () => {
  test('generated[] carries renderedSha256: the previous-hash guard of spec 14', () => {
    const validate = compileSchema(Manifest);
    const manifest = readSample('valid', 'manifest.yaml').document as Manifest;
    expect(validate(manifest).ok).toBe(true);
    expect(manifest.generated[0]?.renderedSha256).toMatch(/^[0-9a-f]{64}$/);
    const broken = { ...manifest, generated: [{ ...manifest.generated[0], renderedSha256: 'not-a-hash' }] };
    const checked = validate(broken);
    expect(checked.ok ? [] : checked.error.map((issue) => issue.path)).toContain('/generated/0/renderedSha256');
  });
});

describe('SkillManifest', () => {
  const validate = compileSchema(SkillManifest);
  const skill = { id: 'vitest', version: '1.0.0', appliesWhen: {}, prompt: 'SKILL.md' };

  test('checks are argv arrays', () => {
    expect(validate({ ...skill, checks: [{ argv: ['pnpm', 'test'] }] }).ok).toBe(true);
    expect(validate({ ...skill, checks: [{ name: 'tests', argv: ['pnpm', 'test'] }] }).ok).toBe(true);
  });

  test("spec 8's shell-string `command` fails at the check that holds it", () => {
    const checked = validate({ ...skill, checks: [{ command: 'pnpm test' }] });
    expect(checked.ok ? [] : checked.error.map((issue) => issue.path)).toContain('/checks/0');
    const both = validate({ ...skill, checks: [{ argv: ['pnpm', 'test'], command: 'pnpm test' }] });
    expect(both.ok).toBe(false);
  });

  test('signature and source are reserved, optional strings (ADR-0011)', () => {
    expect(validate({ ...skill, signature: 'sigstore:...', source: 'https://skills.example/vitest' }).ok).toBe(true);
    expect(validate({ ...skill, permissions: ['run_command'] }).ok, 'a skill cannot grant a permission').toBe(false);
  });
});

describe('policy data shapes', () => {
  const rule = {
    id: 'pnpm-test',
    program: 'pnpm',
    subcommand: ['run'],
    positionals: { kind: 'enum', values: ['test'], max: 1 },
    decision: 'allow',
    replay: 'idempotent',
    network: false,
    origin: 'project-config',
  };

  test('CommandRule: structural, never a command line', () => {
    const validate = compileSchema(CommandRule);
    expect(validate(rule).ok).toBe(true);
    expect(validate({ ...rule, positionals: { kind: 'exact', values: ['--filter', 'web', 'test'] } }).ok).toBe(true);
    expect(validate({ ...rule, command: 'pnpm run test' }).ok).toBe(false);
    expect(validate({ ...rule, program: '/usr/bin/pnpm' }).ok).toBe(false);
    expect(validate({ ...rule, decision: 'allow-once' }).ok).toBe(false);
    const { replay: _dropped, ...noReplay } = rule;
    expect(validate(noReplay).ok, 'replay drives recovery: it is declared, never guessed').toBe(false);
  });

  test('SymlinkPolicy and NetworkPolicyConfig', () => {
    expect(compileSchema(SymlinkPolicy)({ mode: 'deny-all', hardlinksOnWrite: 'allow' }).ok).toBe(true);
    expect(compileSchema(SymlinkPolicy)({ mode: 'follow', hardlinksOnWrite: 'deny' }).ok).toBe(false);
    expect(compileSchema(NetworkPolicyConfig)(DEFAULT_NETWORK_POLICY).ok).toBe(true);
    expect(compileSchema(NetworkPolicyConfig)({ default: 'allow' }).ok, 'V3.0: always deny').toBe(false);
  });
});
