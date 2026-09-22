import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WebSocket } from 'ws';
import { denyNativeExecutor } from '../src/native-boundary.ts';
import { cleanEnv } from '../src/process.ts';
import { Rpc } from '../src/rpc.ts';

test('native executor refuses reads, writes and commands and rejects unauthorized connections', async () => {
  const boundary = await denyNativeExecutor();
  try {
    const refused = new WebSocket(new URL('/', boundary.url));
    await new Promise<void>((resolve) => refused.once('error', () => resolve()));
    const peer = new WebSocket(boundary.url);
    await new Promise<void>((resolve) => peer.once('open', resolve));
    let id = 0;
    const request = (method: string, params: unknown) =>
      new Promise<Record<string, unknown>>((resolve) => {
        peer.once('message', (raw) => resolve(JSON.parse(raw.toString())));
        peer.send(JSON.stringify({ id: ++id, method, params }));
      });
    assert((await request('initialize', { clientName: 'test' })).result);
    for (const method of ['fs/readFile', 'fs/writeFile', 'process/start', 'process/spawn'])
      assert((await request(method, { path: 'file:///secret' })).error);
    assert.equal(boundary.denied.length, 4);
    peer.terminate();
  } finally {
    await boundary.close();
  }
});

test('RPC rejects malformed output and channel loss without hanging', async () => {
  for (const source of ['process.stdout.write("not json\\n")', 'process.exit(0)']) {
    const rpc = new Rpc(process.execPath, ['-e', source], cleanEnv(), process.cwd());
    await assert.rejects(rpc.request('initialize', {}, 1000));
    await rpc.close();
  }
});

test('RPC handles split UTF-8 JSONL and request correlation', async () => {
  const code = `process.stdin.once('data', d => { const m=JSON.parse(d); const b=Buffer.from(JSON.stringify({id:m.id,result:{text:'été'}})+'\\n'); process.stdout.write(b.subarray(0,b.length-5)); setTimeout(()=>process.stdout.write(b.subarray(b.length-5)),5); });`;
  const rpc = new Rpc(process.execPath, ['-e', code], cleanEnv(), process.cwd());
  try {
    assert.deepEqual(await rpc.request('test'), { text: 'été' });
  } finally {
    await rpc.close();
  }
});
