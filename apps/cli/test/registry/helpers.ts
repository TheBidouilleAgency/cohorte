// apps/cli/test/registry/helpers.ts — shared test utilities. Not collected by vitest itself (PLAN §3 rule 9:
// "Helpers and tables under test/ are never collected"): only files ending in .test.ts/.itest.ts/.e2e.ts are.
import { Writable } from 'node:stream';
import { FixedClock, SeqIds } from '@cohorte/testkit';
import type { RuntimeDeps } from '../../src/cli.ts';
import type { CliContext } from '../../src/contract/index.ts';

export function captureStream(): { stream: Writable; text(): string } {
  let buffer = '';
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      buffer += chunk.toString();
      callback();
    },
  });
  return { stream, text: () => buffer };
}

/** A `CliContext` whose every heavy port throws if actually called: Wave-0 stub command modules never touch it, so
 * a test that DOES reach a port call has found a real bug, not a missing fixture. */
export function fakeCliContext(overrides: Partial<CliContext> = {}): CliContext {
  const unreachable = (name: string) => (): never => {
    throw new Error(`fakeCliContext: ${name} should not be called by a Wave-0 stub command`);
  };
  return {
    clock: new FixedClock('2026-09-18T00:00:00.000Z'),
    ids: new SeqIds(),
    stdio: { stdout: captureStream().stream, stderr: captureStream().stream, stdin: process.stdin },
    cwd: '/tmp/cohorte-test',
    env: {},
    openStore: unreachable('openStore'),
    controller: { send: unreachable('controller.send') },
    observer: { follow: unreachable('observer.follow') },
    hostSpawner: { spawnDetached: unreachable('hostSpawner.spawnDetached') },
    renderer: {
      json: unreachable('renderer.json'),
      line: unreachable('renderer.line'),
      panel: unreachable('renderer.panel'),
    },
    runtime: { resolve: unreachable('runtime.resolve') },
    assets: {
      prompt: unreachable('assets.prompt'),
      skill: unreachable('assets.skill'),
      schema: unreachable('assets.schema'),
      migration: unreachable('assets.migration'),
      treeSha256: unreachable('assets.treeSha256'),
      verify: unreachable('assets.verify'),
    },
    install: { installDir: unreachable('install.installDir'), bundleManifest: unreachable('install.bundleManifest') },
    ...overrides,
  };
}

export function testDeps(): RuntimeDeps & { out: { text(): string }; err: { text(): string } } {
  const out = captureStream();
  const err = captureStream();
  return {
    stdout: out.stream,
    stderr: err.stream,
    context: async () => fakeCliContext(),
    out,
    err,
  };
}
