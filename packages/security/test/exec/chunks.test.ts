// I7 (DESIGN 0.2): "nothing unredacted is persisted, logged or sent to a model". The executor's streaming chunks
// are the one place where output leaves the process WHILE it runs, so they must go through the `Redactor` port —
// and the decoding that produces them must not corrupt the text on the way (a multi-byte character straddling a
// pipe-read boundary would otherwise reach the model as U+FFFD).
import type { Redactor } from '@cohorte/base';
import { systemClock } from '@cohorte/base';
import { fakeRedactor, sealedText, test } from '@cohorte/testkit';
import { describe, expect } from 'vitest';
import { createExecutor } from '../../src/exec/index.ts';
import { canonical, fakePidRegistry, nodeRequest } from './support.ts';

const SEAL_MARKER = '[SEALED]';

/** A `Redactor` that marks every text it seals, so a test can tell sealed text from raw text by looking at it. */
function markingRedactor(): Redactor {
  const base = fakeRedactor();
  return { ...base, sealText: (text) => ({ text: sealedText(SEAL_MARKER + text), redactions: [] }) };
}

interface SeenChunk {
  stream: 'stdout' | 'stderr';
  bytes: number;
  text: string;
}

describe('every chunk leaves the executor through the Redactor port (I7)', () => {
  test('onChunk fires for both streams, always sealed, and so is the tail', async ({ tempDir }) => {
    const seen: SeenChunk[] = [];
    const script = 'process.stdout.write("OUT-PAYLOAD"); process.stderr.write("ERR-PAYLOAD");';
    const req = nodeRequest(canonical(tempDir), script, {
      onChunk: (chunk) => {
        seen.push({ stream: chunk.stream, bytes: chunk.bytes, text: chunk.text });
      },
    });
    const executor = createExecutor({ redactor: markingRedactor(), pids: fakePidRegistry(), clock: systemClock });

    const result = await executor.run(req, new AbortController().signal);

    expect(result.outcome).toBe('ok');
    expect(new Set(seen.map((chunk) => chunk.stream))).toEqual(new Set(['stdout', 'stderr']));
    for (const chunk of seen) expect(chunk.text.startsWith(SEAL_MARKER)).toBe(true);
    expect(seen.reduce((total, chunk) => total + chunk.bytes, 0)).toBe(result.outputBytes);

    const streamed = seen.map((chunk) => chunk.text.slice(SEAL_MARKER.length)).join('');
    expect(streamed).toContain('OUT-PAYLOAD');
    expect(streamed).toContain('ERR-PAYLOAD');
    // The accumulated tail is sealed too, exactly once (it is sealed as a whole after the streams close).
    expect(result.tail.startsWith(SEAL_MARKER)).toBe(true);
    expect(result.tail).toContain('OUT-PAYLOAD');
  }, 10_000);
});

describe('a multi-byte character split across a pipe read is not destroyed', () => {
  test('a UTF-8 sequence straddling two reads still arrives whole, in the chunks and in the tail', async ({
    tempDir,
  }) => {
    const repeats = 40_000;
    // The split is deliberate and at an ODD offset: the first write ends one byte into the first `é`, so the read
    // boundary falls INSIDE a two-byte sequence. (A bulk write splits on the 64 KiB pipe buffer, an even offset,
    // which happens to align with this character and would hide the bug.)
    const script = [
      `const buf = Buffer.from("\\u00e9".repeat(${repeats}), "utf8");`,
      'process.stdout.write(buf.subarray(0, 1));',
      'setTimeout(() => process.stdout.write(buf.subarray(1)), 50);',
    ].join('\n');
    const seen: string[] = [];
    const req = nodeRequest(canonical(tempDir), script, {
      onChunk: (chunk) => {
        seen.push(chunk.text);
      },
    });
    const executor = createExecutor({ redactor: fakeRedactor(), pids: fakePidRegistry(), clock: systemClock });

    const result = await executor.run(req, new AbortController().signal);

    expect(result.outcome).toBe('ok');
    expect(result.outputBytes).toBe(repeats * 2);
    expect(seen.length).toBeGreaterThan(1);
    expect(seen.join('')).toBe('é'.repeat(repeats));
    expect(result.tail).not.toContain('�');
  }, 20_000);
});
