// A throwaway run host for "parent SIGKILL => the brain exits": it spawns one fake brain that waits in a tool call
// forever, prints the brain's pid, and is then killed by the test. Started as a plain Node process, not collected.
import { Bench } from '../bench.ts';

const bench = new Bench();
bench.script = { turns: [{ toolCalls: [{ tool: 'probe_hold', input: { text: 'forever' } }] }] };
bench.handler = () => new Promise(() => {});
const runtime = await bench.runtime();
const handle = await runtime.spawn(bench.request('orphan'));
process.stdout.write(`${JSON.stringify({ brain: handle.process?.pid, root: bench.root })}\n`);
setInterval(() => {}, 1_000);
