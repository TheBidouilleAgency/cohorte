// apps/cli/test/registry/verbs.test.ts — PLAN U0.10 test list: verb registration, --help, --version, and the
// documented not-available error + exit code for every stub.
import { EXIT_CODE_BY_CLASS } from '@cohorte/base';
import { COMMAND_TYPES, CONTROLLER_EXIT_CODES } from '@cohorte/protocol';
import { describe, expect, test } from 'vitest';
import { COHORTE_VERSION, runCli } from '../../src/cli.ts';
import { COMMAND_TYPE_TO_VERB, VERB_NAMES, VERBS } from '../../src/contract/index.ts';
import { testDeps } from './helpers.ts';

/**
 * DESIGN §9's CLI row, transcribed BY HAND (PLAN U0.10 deliverable 1 spells the same list): "`init doctor discover
 * run status inspect resume pause cancel shutdown approve deny retry skip logs tail diff review fix ship auth
 * providers models config migrate reconcile spec obsidian policy gc update brainstorm run-tool send` + hidden `__host`".
 *
 * Deliberately NOT derived from `VERBS` — that is the whole point. The registry is frozen at G0 and every Wave-4/5
 * unit builds on it, so a coordinated deletion (the `VERBS` entry, its `COMMAND_MODULES` loader and its
 * `commands/<verb>/index.ts`) has to fail HERE, against the document, not against the code it is deleting.
 */
const DESIGN_9_VERBS = [
  'init',
  'doctor',
  'discover',
  'run',
  'status',
  'inspect',
  'resume',
  'pause',
  'cancel',
  'shutdown',
  'approve',
  'deny',
  'retry',
  'skip',
  'logs',
  'tail',
  'diff',
  'review',
  'fix',
  'ship',
  'auth',
  'providers',
  'models',
  'config',
  'migrate',
  'reconcile',
  'spec',
  'obsidian',
  'policy',
  'gc',
  'update',
  'brainstorm',
  'run-tool',
  'send',
  '__host',
] as const;

/** DESIGN §9 again: "`config` has the sub-verbs `get set validate trust`", `auth login/status/logout`,
 * `providers list/test`, `models list`, `spec validate/freeze`, `policy explain`. Every other verb has none —
 * `update --check` is a FLAG, not a sub-verb (request U0.10 R2). */
const DESIGN_9_SUB_VERBS: Readonly<Record<string, readonly string[]>> = {
  auth: ['login', 'status', 'logout'],
  providers: ['list', 'test'],
  models: ['list'],
  config: ['get', 'set', 'validate', 'trust'],
  spec: ['validate', 'freeze'],
  obsidian: ['create', 'connect', 'status', 'move'],
  policy: ['explain'],
};

const STILL_STUBBED = new Set<string>();

describe('registry', () => {
  test('every verb name is unique', () => {
    const names = VERBS.map((verb) => verb.name);
    expect(new Set(names).size).toBe(names.length);
  });

  test('the registry is exactly DESIGN §9, each verb exactly once', () => {
    expect([...VERB_NAMES].sort()).toEqual([...DESIGN_9_VERBS].sort());
    expect(VERB_NAMES.length).toBe(DESIGN_9_VERBS.length);
  });

  test('the sub-verb sets are exactly DESIGN §9', () => {
    const registered = Object.fromEntries(
      VERBS.filter((verb) => verb.subVerbs).map((verb) => [verb.name, [...(verb.subVerbs ?? [])]]),
    );
    expect(registered).toEqual(DESIGN_9_SUB_VERBS);
  });

  test('`__host` is the one hidden verb (DESIGN 4.7: an internal entry point, not a user-facing one)', () => {
    expect(VERBS.filter((verb) => verb.hidden).map((verb) => verb.name)).toEqual(['__host']);
  });

  test('every visible verb appears in --help', async () => {
    const deps = testDeps();
    const code = await runCli(['--help'], deps);
    expect(code).toBe(CONTROLLER_EXIT_CODES.completed);
    const help = deps.out.text();
    for (const verb of VERBS) {
      if (verb.hidden) continue;
      expect(help).toContain(verb.name);
    }
  });

  test('the hidden __host verb is registered but not printed in --help', async () => {
    const deps = testDeps();
    await runCli(['--help'], deps);
    expect(deps.out.text()).not.toContain('__host');
    // still reachable: a missing `--run` is a usage error.
    const runDeps = testDeps();
    const code = await runCli(['__host'], runDeps);
    expect(code).toBe(CONTROLLER_EXIT_CODES.usage);
  });

  test('--version prints the Cohorte version and exits 0', async () => {
    const deps = testDeps();
    const code = await runCli(['--version'], deps);
    expect(code).toBe(CONTROLLER_EXIT_CODES.completed);
    // The literal lives in ONE place (`version.test.ts` binds it to apps/cli/package.json); here the point is only
    // that commander answers `--version` itself, without ever building a `CliContext`.
    expect(deps.out.text().trim()).toBe(COHORTE_VERSION);
  });

  test.for(VERBS.filter((verb) => !verb.subVerbs && STILL_STUBBED.has(verb.name)))(
    '$name stub exits with configuration/phase-not-available',
    async (verb) => {
      const deps = testDeps();
      const code = await runCli([verb.name], deps);
      expect(code).toBe(EXIT_CODE_BY_CLASS.configuration);
      expect(deps.err.text()).toContain('configuration/phase-not-available');
      expect(deps.err.text()).toContain(verb.name);
    },
  );

  test.for(VERBS.filter((verb) => verb.subVerbs && STILL_STUBBED.has(verb.name)))(
    '$name sub-verbs each reach the same stub',
    async (verb) => {
      for (const subVerb of verb.subVerbs ?? []) {
        const deps = testDeps();
        const code = await runCli([verb.name, subVerb], deps);
        expect(code).toBe(EXIT_CODE_BY_CLASS.configuration);
        expect(deps.err.text()).toContain('configuration/phase-not-available');
      }
    },
  );

  test('an unknown verb is a usage error (exit 2)', async () => {
    const deps = testDeps();
    const code = await runCli(['not-a-real-verb'], deps);
    expect(code).toBe(CONTROLLER_EXIT_CODES.usage);
  });

  // `help [command]` is advertised in `cohorte --help`, so it is a user-facing route and not an error: it printed
  // exactly what was asked. Commander raises `commander.help` for it AND for the bare `cohorte`, and only its own
  // `exitCode` separates the two — which is why `cli.ts` keys off that rather than off the code name.
  test('`help` and `help <verb>` print the help and exit 0, like --help', async () => {
    for (const argv of [['--help'], ['help'], ['help', 'status']]) {
      const deps = testDeps();
      const code = await runCli(argv, deps);
      expect(code, `\`cohorte ${argv.join(' ')}\` should exit 0`).toBe(CONTROLLER_EXIT_CODES.completed);
      expect(deps.out.text()).toContain('Usage: cohorte');
    }
  });

  test('`cohorte` with no verb at all is a usage error (exit 2)', async () => {
    const deps = testDeps();
    const code = await runCli([], deps);
    expect(code).toBe(CONTROLLER_EXIT_CODES.usage);
  });

  test('an UNEXPECTED throw from a verb surfaces as configuration/unexpected, not phase-not-available', async () => {
    // DESIGN 2.8: "Unknown throwables -> `<nearest class>/unexpected`". `phase-not-available` is what a stub MEANS
    // (it throws a classified CohorteError); it must never be the landing place of a TypeError, a failed store
    // open, or a module that will not load — that mislabelling is what hides real defects behind a stub's message.
    const deps = testDeps();
    const failing = { ...deps, context: (): Promise<never> => Promise.reject(new TypeError('boom')) };
    const code = await runCli(['status'], failing);
    expect(code).toBe(EXIT_CODE_BY_CLASS.configuration);
    expect(deps.err.text()).toContain('configuration/unexpected');
    expect(deps.err.text()).not.toContain('phase-not-available');
    expect(deps.err.text()).toContain('boom');
  });

  test('--json is registered exactly on the verbs that publish a document', async () => {
    for (const verb of VERBS) {
      const deps = testDeps();
      await runCli([verb.name, '--help'], deps);
      const help = deps.out.text();
      expect(help.includes('--json'), `${verb.name} --help ${verb.json ? 'should' : 'should not'} offer --json`).toBe(
        Boolean(verb.json),
      );
    }
  });

  test('every @cohorte/protocol CommandType has exactly one driving verb, registered', () => {
    for (const type of COMMAND_TYPES) {
      const verb = COMMAND_TYPE_TO_VERB[type];
      expect(verb, `CommandType ${type} has no driving verb`).toBeDefined();
      expect(VERBS.some((candidate) => candidate.name === verb)).toBe(true);
    }
  });
});
