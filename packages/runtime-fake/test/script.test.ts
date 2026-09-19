import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect } from 'vitest';
import {
  type FakeScript,
  type FakeStep,
  fakeScript,
  fakeScriptSha256,
  globToRegExp,
  loadFakeScriptFile,
  matchFakeRule,
  parseFakeScript,
  step,
  validateFakeScript,
} from '../src/script/index.ts';
import { test } from './bench.ts';

const YAML = `
version: 1
defaults:
  model: scripted-small
  usagePerTurn: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, total: 12 }
agents:
  - match: { role: implementer, agentId: "agt_implementer_*", incarnation: 1 }
    steps:
      - { do: think, text: hmm }
      - { do: say, text: writing, chunks: 2 }
      - do: tool
        tool: write_file
        input: { path: src/a.ts, content: "export {}" }
        expect: { isError: false }
        onDenied:
          - { do: say, text: denied }
          - { do: stop-without-result }
      - { do: usage, tokens: { input: 5 } }
      - { do: await-message, timeoutMs: 100 }
      - { do: hang, ms: forever }
      - { do: crash, at: during-tool }
      - { do: model-request, status: 429, authSource: oauth, baseUrl: "https://x.invalid", quota: { known: false } }
      - { do: fail, error: { class: provider-transient, code: provider-transient/rate-limited, retryable: true, retryAfterMs: 10 } }
  - match: { incarnation: any }
    steps:
      - { do: submit, output: { status: done } }
`;

describe('parseFakeScript', () => {
  test('reads every step kind of DESIGN 3.10 from YAML, and the same script from JSON', () => {
    const fromYaml = parseFakeScript(YAML, 'yaml');
    if (!fromYaml.ok) throw new Error(fromYaml.error.message);
    const kindsOf = (steps: FakeStep[]): string[] =>
      steps.flatMap((s) => [s.do, ...(s.do === 'tool' ? kindsOf(s.onDenied ?? []) : [])]);
    const kinds = fromYaml.value.agents.flatMap((rule) => kindsOf(rule.steps));
    expect([...new Set(kinds)].sort()).toEqual([
      'await-message',
      'crash',
      'fail',
      'hang',
      'model-request',
      'say',
      'stop-without-result',
      'submit',
      'think',
      'tool',
      'usage',
    ]);
    const fromJson = parseFakeScript(JSON.stringify(fromYaml.value), 'json');
    expect(fromJson).toEqual(fromYaml);
  });

  test.for([
    ['an unknown step kind', 'version: 1\nagents: [{ match: {}, steps: [{ do: dance }] }]'],
    ['a typo in a step field', 'version: 1\nagents: [{ match: {}, steps: [{ do: say, texte: hi }] }]'],
    [
      'a phase in match (the fake knows no phases, R10)',
      'version: 1\nagents: [{ match: { phase: BUILD }, steps: [] }]',
    ],
    ['another version', 'version: 2\nagents: []'],
    [
      'a nested invalid onDenied step',
      'version: 1\nagents: [{ match: {}, steps: [{ do: tool, tool: t, input: {}, onDenied: [{ do: hang }] }] }]',
    ],
    ['text that is not YAML', 'version: [1'],
  ] as const)('refuses %s', ([, text]) => {
    const parsed = parseFakeScript(text, 'yaml');
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toMatchObject({ class: 'configuration', retryable: false });
  });

  test('refuses text that is not JSON', () => {
    expect(parseFakeScript('{ version: 1 }', 'json').ok).toBe(false);
  });

  test('loadFakeScriptFile picks the format from the extension', ({ rig }) => {
    const script = fakeScript()
      .agent({}, [step.say('hi')])
      .build();
    writeFileSync(join(rig.dir, 's.json'), JSON.stringify(script));
    writeFileSync(join(rig.dir, 's.yaml'), 'version: 1\nagents:\n  - match: {}\n    steps: [{ do: say, text: hi }]\n');

    expect(loadFakeScriptFile(join(rig.dir, 's.json'))).toEqual({ ok: true, value: script });
    expect(loadFakeScriptFile(join(rig.dir, 's.yaml'))).toEqual({ ok: true, value: script });
    expect(loadFakeScriptFile(join(rig.dir, 'missing.yaml')).ok).toBe(false);
  });
});

describe('fakeScript builder', () => {
  test('builds a schema-valid script, rules in the order they were added', () => {
    const built = fakeScript()
      .defaults({ model: 'scripted' })
      .agent({ role: 'implementer', incarnation: 1 }, [
        step.tool('write_file', { path: 'a' }),
        step.crash('before-next-step'),
      ])
      .agent({ role: 'implementer' }, [step.submit({ status: 'done' })])
      .build();

    expect(validateFakeScript(built)).toEqual({ ok: true, value: built });
    expect(built.agents.map((rule) => rule.match.incarnation)).toEqual([1, undefined]);
    expect(built.defaults).toEqual({ model: 'scripted' });
  });

  test('build() hands out a copy', () => {
    const builder = fakeScript().agent({}, [step.say('a')]);
    const first = builder.build();
    // bound to a name: an expression STATEMENT of a self-returning type overflows Biome 2.5.14 (requests/U1.06.md R2)
    const extended = builder.agent({}, [step.say('b')]);

    expect(first.agents).toHaveLength(1);
    expect(extended.build().agents).toHaveLength(2);
  });

  test('every step constructor yields its kind', () => {
    const steps = [
      step.say('a'),
      step.think('a'),
      step.tool('t', {}),
      step.submit(null),
      step.usage({}),
      step.awaitMessage(),
      step.fail({ class: 'timeout', code: 'timeout/model-request', retryable: true }),
      step.hang(1),
      step.crash('during-tool'),
      step.stopWithoutResult(),
      step.modelRequest(),
    ];
    expect(validateFakeScript({ version: 1, agents: [{ match: {}, steps }] }).ok).toBe(true);
    expect(new Set(steps.map((s) => s.do)).size).toBe(11);
  });
});

describe('matchFakeRule', () => {
  const script: FakeScript = {
    version: 1,
    agents: [
      { match: { role: 'implementer', agentId: 'agt_implementer_api*', incarnation: 1 }, steps: [step.say('api#1')] },
      { match: { role: 'implementer', attempt: 2 }, steps: [step.say('second attempt')] },
      { match: { role: 'implementer', incarnation: 'any' }, steps: [step.say('any implementer')] },
      { match: {}, steps: [step.say('anyone')] },
    ],
  };
  const said = (subject: Parameters<typeof matchFakeRule>[1]): unknown => matchFakeRule(script, subject)?.steps[0];

  test.for([
    [{ role: 'implementer', agentId: 'agt_implementer_api', incarnation: 1, attempt: 1 }, 'api#1'],
    [{ role: 'implementer', agentId: 'agt_implementer_api_2', incarnation: 1, attempt: 1 }, 'api#1'],
    [{ role: 'implementer', agentId: 'agt_implementer_api', incarnation: 2, attempt: 2 }, 'second attempt'],
    [{ role: 'implementer', agentId: 'agt_implementer_web', incarnation: 3, attempt: 1 }, 'any implementer'],
    [{ role: 'reviewer', agentId: 'agt_reviewer_main', incarnation: 1, attempt: 1 }, 'anyone'],
  ] as const)('%o -> %s', ([subject, text]) => {
    expect(said(subject)).toEqual(step.say(text));
  });

  test('no rule, no match', () => {
    const none = matchFakeRule(
      { version: 1, agents: [{ match: { role: 'a' }, steps: [] }] },
      {
        role: 'b',
        agentId: 'x',
        incarnation: 1,
        attempt: 1,
      },
    );
    expect(none).toBeUndefined();
  });

  test('a glob is anchored and its other characters are literal', () => {
    expect(globToRegExp('agt_?_main').test('agt_a_main')).toBe(true);
    expect(globToRegExp('agt_?_main').test('agt_ab_main')).toBe(false);
    expect(globToRegExp('a.b').test('axb')).toBe(false);
    expect(globToRegExp('main').test('agt_main')).toBe(false);
  });
});

describe('fakeScriptSha256', () => {
  test('depends on the content, not on key order or format', () => {
    const a = parseFakeScript('version: 1\nagents: [{ match: { role: r }, steps: [{ do: say, text: hi }] }]', 'yaml');
    const b = parseFakeScript(
      '{"agents":[{"steps":[{"text":"hi","do":"say"}],"match":{"role":"r"}}],"version":1}',
      'json',
    );
    if (!a.ok || !b.ok) throw new Error('both scripts are valid');

    expect(fakeScriptSha256(a.value)).toBe(fakeScriptSha256(b.value));
    expect(fakeScriptSha256(a.value)).not.toBe(fakeScriptSha256(fakeScript().agent({ role: 'r' }, []).build()));
  });
});
