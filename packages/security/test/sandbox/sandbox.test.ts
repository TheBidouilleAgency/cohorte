import { describe, expect, test } from 'vitest';
import { createBubblewrapBackend, createSeatbeltBackend, wrapForPolicy } from '../../src/sandbox/index.ts';

describe('sandbox backends', () => {
  test('missing native binaries are reported conservatively', async () => {
    const backend = createBubblewrapBackend({ binary: '/definitely/missing/bwrap', cacheKey: 'test' });
    const capabilities = await backend.probe();
    expect(capabilities.level).toBe('L1-os');
    expect(capabilities.missing).toContain('/definitely/missing/bwrap');
  });

  test('backend wrappers keep command arguments explicit', () => {
    const backend = createSeatbeltBackend({ binary: '/usr/bin/sandbox-exec', cacheKey: 'test' });
    const wrapped = backend.wrap('/bin/echo' as never, ['hello'], {
      file: '/bin/echo',
      args: ['hello'],
      cwd: '/tmp',
      env: { allow: [], set: {} },
      fs: { readOnly: [], readWrite: [], denyRead: [] },
      network: { mode: 'none', allowHosts: [] },
      require: 'best-effort',
      limits: {},
    } as never);
    expect(wrapped.file).toBe('/usr/bin/sandbox-exec');
    expect(wrapped.args).toContain('/bin/echo');
  });

  test('process policy wrapper is explicit and pure', () => {
    expect(wrapForPolicy({ require: 'process' } as never, { file: '/bin/echo', args: ['ok'] })).toEqual({
      file: '/bin/echo',
      args: ['ok'],
    });
    expect(wrapForPolicy({ require: 'best-effort' } as never, { file: '/bin/echo', args: [] })).toBeNull();
  });
});
