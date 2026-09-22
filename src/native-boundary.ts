import { randomUUID } from 'node:crypto';
import { WebSocketServer } from 'ws';

/**
 * Deliberately no native filesystem or process implementation. Codex's native
 * executor is replaced with a refusing endpoint; only our dynamic tools perform
 * repository I/O. This small subset is pinned to the native integration test.
 */
export async function denyNativeExecutor() {
  const capability = `/${randomUUID()}`;
  let used = false;
  const denied: string[] = [];
  const server = new WebSocketServer({
    host: '127.0.0.1',
    port: 0,
    maxPayload: 64 * 1024,
    verifyClient: ({ req, origin }: { req: { url?: string }; origin: string }) =>
      !used && !origin && req.url === capability,
  });
  const info = {
    shell: { name: 'sh', path: '/bin/sh' },
    executorVersion: '0.1.0',
    providerId: 'cohorte-no-native-effects',
    cwd: 'file:///workspace',
    userHomeDir: 'file:///tmp',
    platformOs: 'linux',
    temporaryDirectories: [],
    tempDir: 'file:///tmp',
    capabilities: {},
  };
  server.on('connection', (peer) => {
    if (used) {
      peer.terminate();
      return;
    }
    used = true;
    let initialized = false;
    let count = 0;
    peer.on('error', () => peer.terminate());
    peer.on('message', (raw) => {
      try {
        if (++count > 1000 || peer.bufferedAmount > 1024 * 1024) {
          peer.terminate();
          return;
        }
        const m = JSON.parse(raw.toString()) as {
          id?: string | number;
          method?: string;
          params?: Record<string, unknown>;
        };
        if (m.method === 'initialized') return;
        let result: unknown;
        if (m.method === 'initialize' && !initialized && !m.params?.resumeSessionId) {
          initialized = true;
          result = { sessionId: randomUUID(), environmentInfo: info };
        } else if (m.method === 'environment/info' && initialized) result = info;
        else {
          denied.push((m.method ?? 'unknown').slice(0, 100));
          peer.send(
            JSON.stringify({
              id: m.id,
              error: {
                code: -32601,
                message: 'Native effects disabled. Use cohorte_list, cohorte_read and cohorte_write.',
              },
            }),
          );
          return;
        }
        peer.send(JSON.stringify({ id: m.id, result }));
      } catch {
        peer.terminate();
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Executor endpoint unavailable');
  return {
    url: `ws://127.0.0.1:${address.port}${capability}`,
    denied,
    close: async () => {
      for (const peer of server.clients) peer.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
