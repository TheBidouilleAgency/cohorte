import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';

export type ModelItem = Record<string, unknown>;
export const call = (name: string, args: unknown): ModelItem => ({
  type: 'function_call',
  name,
  arguments: JSON.stringify(args),
});
export const answer = (value: unknown): ModelItem => ({
  type: 'message',
  role: 'assistant',
  content: [{ type: 'output_text', text: JSON.stringify(value), annotations: [] }],
});
export async function synthetic(root: string, handler: (body: Record<string, unknown>, n: number) => ModelItem) {
  let count = 0;
  const requests: Record<string, unknown>[] = [];
  const server = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const raw of req) {
        const chunk = Buffer.from(raw);
        size += chunk.length;
        if (size > 2 * 1024 * 1024) throw new Error('fixture input limit');
        chunks.push(chunk);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString());
      requests.push(body);
      const n = ++count;
      const item = { id: `item_${n}`, call_id: `call_${n}`, ...handler(body, n) };
      res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'close' });
      const send = (type: string, fields: object) =>
        res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`);
      const id = `resp_${n}`;
      send('response.created', { response: { id, status: 'in_progress', output: [] } });
      send('response.output_item.added', { output_index: 0, item });
      send('response.output_item.done', { output_index: 0, item });
      send('response.completed', {
        response: {
          id,
          status: 'completed',
          output: [item],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        },
      });
      res.end();
    } catch {
      res.writeHead(400).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fixture listen');
  const home = join(root, 'home');
  const codexHome = join(root, 'codex');
  await mkdir(home, { recursive: true });
  await mkdir(codexHome, { recursive: true });
  await writeFile(join(codexHome, 'synthetic-private'), 'SECRET_SHOULD_NEVER_REACH_MODEL');
  await writeFile(
    join(codexHome, 'config.toml'),
    `model="synthetic"\nmodel_provider="fixture"\n[model_providers.fixture]\nname="Local test"\nbase_url="http://127.0.0.1:${address.port}/v1"\nwire_api="responses"\nrequires_openai_auth=false\n`,
  );
  return {
    options: { home, codexHome, provider: 'fixture', model: 'synthetic' },
    requests,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
