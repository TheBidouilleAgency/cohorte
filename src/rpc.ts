import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
export type Message = {
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: unknown;
};

/** Bounded JSONL transport; a lost channel fails every in-flight request. */
export class Rpc {
  private child: ChildProcessWithoutNullStreams;
  private next = 0;
  private pending = new Map<
    number,
    { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }
  >();
  private failure?: Error;
  private closed: Promise<void>;
  private listeners = new Set<(message: Message) => void>();
  constructor(binary: string, args: string[], env: NodeJS.ProcessEnv, cwd: string) {
    this.child = spawn(binary, args, { env, cwd, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    let buffer = Buffer.alloc(0);
    let total = 0;
    this.child.stdout.on('data', (chunk: Buffer) => {
      try {
        total += chunk.length;
        if (total > 32 * 1024 * 1024) throw new Error('RPC output limit');
        buffer = Buffer.concat([buffer, chunk]);
        while (buffer.includes(10)) {
          const end = buffer.indexOf(10);
          if (end > 1024 * 1024) throw new Error('RPC line limit');
          const line = buffer.subarray(0, end).toString();
          buffer = buffer.subarray(end + 1);
          if (!line) continue;
          const m = JSON.parse(line) as Message;
          if (!m || typeof m !== 'object' || Array.isArray(m)) throw new Error('Invalid RPC frame');
          if (!m.method && typeof m.id === 'number') {
            const p = this.pending.get(m.id);
            if (!p) continue;
            this.pending.delete(m.id);
            clearTimeout(p.timer);
            if (m.error) p.reject(new Error('Codex rejected RPC request'));
            else p.resolve(m.result);
          } else for (const listener of this.listeners) listener(m);
        }
        if (buffer.length > 1024 * 1024) throw new Error('RPC line limit');
      } catch {
        this.fail(new Error('Invalid or oversized Codex protocol output'));
      }
    });
    // Never persist raw stderr: native clients can include configuration or credentials.
    let stderrSize = 0;
    this.child.stderr.on('data', (chunk: Buffer) => {
      stderrSize += chunk.length;
      if (stderrSize > 1024 * 1024) this.fail(new Error('Codex diagnostic limit'));
    });
    this.child.on('error', () => this.fail(new Error('Cannot start Codex app-server')));
    this.child.stdin.on('error', () => this.fail(new Error('Codex input channel lost')));
    this.closed = new Promise((resolve) =>
      this.child.once('close', () => {
        this.fail(new Error(buffer.length ? 'Truncated Codex protocol frame' : 'Codex channel closed'));
        resolve();
      }),
    );
  }
  private fail(error: Error) {
    if (this.failure) return;
    this.failure = error;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(error);
    }
    this.pending.clear();
    for (const listener of this.listeners) listener({ method: 'cohorte/transportError' });
    this.child.kill('SIGKILL');
  }
  send(message: Message) {
    if (this.failure) throw this.failure;
    if (this.child.stdin.writableLength > 2 * 1024 * 1024) throw new Error('RPC input backpressure limit');
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }
  request<T = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {},
    timeout = 15_000,
  ): Promise<T> {
    if (this.failure) return Promise.reject(this.failure);
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex request timeout: ${method}`));
      }, timeout);
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject, timer });
      try {
        this.send({ id, method, params });
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e);
      }
    });
  }
  subscribe(fn: (message: Message) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  async initialize() {
    await this.request('initialize', {
      clientInfo: { name: 'cohorte_next', version: '0.1.0' },
      capabilities: { experimentalApi: true },
    });
    this.send({ method: 'initialized' });
  }
  async close() {
    this.child.kill('SIGKILL');
    await this.closed;
  }
}
