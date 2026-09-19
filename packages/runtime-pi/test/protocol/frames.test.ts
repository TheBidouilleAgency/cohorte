import { describe, expect, test } from 'vitest';
import {
  ChildFrame,
  decodeFrame,
  encodeFrame,
  type FrameWire,
  HOST_PROTOCOL,
  MAX_FRAME_CHARS,
  ParentFrame,
} from '../../src/protocol.ts';
import { attestation, childFrames, parentFrames } from './samples.ts';

const WIRES: readonly FrameWire[] = ['ipc', 'lf'];
// What Node's 'ipc' channel does with serialization 'json'.
const overIpc = (message: unknown): unknown => JSON.parse(JSON.stringify(message));

describe('AgentHostProtocol v1 frames', () => {
  test('the samples cover every variant of both unions', () => {
    expect(HOST_PROTOCOL).toBe(1);
    const tagOf = (variant: unknown) => {
      const { properties } = variant as { properties: { t: { const: string }; mode?: { const: string } } };
      return properties.mode ? `${properties.t.const}:${properties.mode.const}` : properties.t.const;
    };
    const sampleTag = (frame: { t: string; mode?: string }) => (frame.mode ? `${frame.t}:${frame.mode}` : frame.t);
    expect(new Set(parentFrames.map(([, frame]) => sampleTag(frame)))).toEqual(new Set(ParentFrame.anyOf.map(tagOf)));
    expect(new Set(childFrames.map(([, frame]) => sampleTag(frame)))).toEqual(new Set(ChildFrame.anyOf.map(tagOf)));
  });

  describe.for(WIRES)('over %s', (wire) => {
    test.for(parentFrames)('parent frame %s round-trips', ([, frame]) => {
      const encoded = encodeFrame(frame, wire);
      const decoded = decodeFrame('parent', wire === 'ipc' ? overIpc(encoded) : encoded, wire);
      expect(decoded).toEqual({ ok: true, value: frame });
    });

    test.for(childFrames)('child frame %s round-trips', ([, frame]) => {
      const encoded = encodeFrame(frame, wire);
      const decoded = decodeFrame('child', wire === 'ipc' ? overIpc(encoded) : encoded, wire);
      expect(decoded).toEqual({ ok: true, value: frame });
    });

    test('a frame of the other direction is unknown', () => {
      const hello = encodeFrame({ t: 'hello', v: 1, pid: 1, nonce: 'n' }, wire);
      expect(decodeFrame('parent', hello, wire)).toMatchObject({ ok: false, error: { reason: 'unknown-frame' } });
      const shutdown = encodeFrame({ t: 'shutdown' }, wire);
      expect(decodeFrame('child', shutdown, wire)).toMatchObject({ ok: false, error: { reason: 'unknown-frame' } });
    });
  });

  test('on the lf wire one frame is exactly one line, whatever the text holds', () => {
    for (const [, frame] of [...parentFrames, ...childFrames]) {
      const line = encodeFrame(frame, 'lf');
      expect(line.endsWith('\n')).toBe(true);
      expect(line.slice(0, -1)).not.toMatch(/[\n\r]/);
    }
    const [, prompt] = parentFrames.find(([name]) => name === 'prompt') ?? [];
    expect(decodeFrame('parent', `${JSON.stringify(prompt)}`, 'lf')).toEqual({ ok: true, value: prompt });
  });
});

describe('decodeFrame rejects, and never throws', () => {
  const SECRET = 'sk-live-THIS-MUST-NOT-BE-ECHOED';
  const hostile = new Proxy(
    {},
    {
      get: () => {
        throw new Error('trap');
      },
    },
  );

  test.for([
    ['an unknown t', 'child', { t: 'exec', command: 'rm -rf /' }, 'ipc', 'unknown-frame'],
    ['no t', 'child', { v: 1 }, 'ipc', 'unknown-frame'],
    ['a t that is not a string', 'child', { t: 7 }, 'ipc', 'unknown-frame'],
    ['a t inherited from Object.prototype', 'child', { t: 'constructor' }, 'ipc', 'unknown-frame'],
    ['another protocol version', 'child', { t: 'hello', v: 2, pid: 1, nonce: 'n' }, 'ipc', 'schema-violation'],
    ['a missing member', 'child', { t: 'heartbeat', rssMb: 1 }, 'ipc', 'schema-violation'],
    ['an extra member', 'parent', { t: 'pause', now: true }, 'ipc', 'schema-violation'],
    ['an unknown init mode', 'parent', { t: 'init', v: 1, nonce: 'n', mode: 'shell' }, 'ipc', 'schema-violation'],
    [
      'an event of no known type',
      'child',
      { t: 'event', seq: 1, event: { type: 'pi.raw', at: 'x', data: {} } },
      'ipc',
      'schema-violation',
    ],
    ['a secret in a wrong place', 'child', { t: 'heartbeat', rssMb: SECRET, state: 'x' }, 'ipc', 'schema-violation'],
    [
      'an ordinal of 0',
      'child',
      { t: 'tool.call', seq: 1, ordinal: 0, engineToolCallId: 'c', tool: 'x', input: {} },
      'ipc',
      'schema-violation',
    ],
    ['an array', 'child', [], 'ipc', 'not-a-frame'],
    ['null', 'child', null, 'ipc', 'not-a-frame'],
    ['a string on the ipc wire', 'child', '{"t":"parked","at":"model-boundary"}', 'ipc', 'not-a-frame'],
    ['a hostile object', 'child', hostile, 'ipc', 'not-a-frame'],
    ['an object on the lf wire', 'child', { t: 'parked', at: 'model-boundary' }, 'lf', 'not-a-frame'],
    ['broken JSON', 'child', `{"t":"heartbeat","rssMb":${SECRET}`, 'lf', 'not-json'],
    ['two lines', 'parent', '{"t":"pause"}\n{"t":"resume"}\n', 'lf', 'not-a-frame'],
    ['a JSON scalar', 'parent', '42\n', 'lf', 'not-a-frame'],
    ['a line over the cap', 'parent', 'x'.repeat(MAX_FRAME_CHARS + 1), 'lf', 'too-large'],
  ] as const)('%s', ([, sender, raw, wire, reason]) => {
    const decoded = decodeFrame(sender, raw, wire);
    expect(decoded).toMatchObject({ ok: false, error: { reason } });
    expect(JSON.stringify(decoded)).not.toContain(SECRET);
  });

  test('a settled exit may not carry its own error: the PARENT classifies', () => {
    const [, settled] = childFrames.find(([name]) => name === 'settled with a signal') ?? [];
    if (settled?.t !== 'settled') throw new Error('no settled sample');
    expect(decodeFrame('child', settled, 'ipc')).toMatchObject({ ok: true });
    // the ONLY difference with the frame above is `exit.error`
    const withError = { ...settled, exit: { ...settled.exit, error: { code: 'x/y' } } };
    expect(decodeFrame('child', withError, 'ipc')).toMatchObject({
      ok: false,
      error: { reason: 'schema-violation', detail: expect.stringMatching(/^settled: \/exit /) },
    });
  });

  const [, authLogin] = parentFrames.find(([name]) => name === 'init auth-login') ?? [];
  test.for([
    ['a wrong member of heartbeat', 'child', { t: 'heartbeat', rssMb: SECRET, state: 'x' }, /^heartbeat: \/rssMb /],
    ['a missing member of heartbeat', 'child', { t: 'heartbeat', rssMb: 1 }, /^heartbeat: \/ .*state/],
    ['an extra member of pause', 'parent', { t: 'pause', [SECRET]: 1 }, /^pause: \/ /],
    ['another protocol version', 'child', { t: 'hello', v: 2, pid: 1, nonce: 'n' }, /^hello: \/v /],
    ['a wrong member of the init of ONE mode', 'parent', { ...authLogin, provider: 7 }, /^init: \/provider /],
    ['an unknown init mode', 'parent', { t: 'init', v: 1, nonce: 'n', mode: SECRET }, /^init: \/mode /],
  ] as const)('the detail of a schema violation points into the frame that was sent: %s', ([, sender, raw, where]) => {
    const decoded = decodeFrame(sender, raw, 'ipc');
    expect(decoded).toMatchObject({
      ok: false,
      error: { reason: 'schema-violation', detail: expect.stringMatching(where) },
    });
    expect(JSON.stringify(decoded)).not.toContain(SECRET);
  });

  test('a ready frame carries a CLAIM: a wrong fixed member decodes, so that diffAttestation can name it', () => {
    const claim = { ...attestation, modelFallback: true, extensionsLoaded: 2 };
    expect(decodeFrame('child', { t: 'ready', attestation: claim }, 'ipc')).toMatchObject({ ok: true });
    const broken = { ...attestation, envKeys: 'PATH' };
    expect(decodeFrame('child', { t: 'ready', attestation: broken }, 'ipc')).toMatchObject({
      ok: false,
      error: { reason: 'schema-violation' },
    });
  });
});
