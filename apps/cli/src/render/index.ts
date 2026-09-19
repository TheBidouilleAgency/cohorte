// apps/cli/src/render/index.ts — AREA barrel: the `Renderer` port (document / NDJSON-line / `--panel` output,
// francois.md "10 s / 4 MiB" one-shot budget). Wave-0 stub: filled by `U4.04`, which owns `apps/cli/src/render/**`.
import type { Renderer } from '../contract/index.ts';
import { resolvePanel } from '../panels/index.ts';
import { sanitizeHuman } from './sanitize.ts';

export function createRenderer(): Renderer {
  return {
    json(value) {
      process.stdout.write(`${JSON.stringify(value)}\n`);
    },
    line(text) {
      process.stdout.write(`${sanitizeHuman(text)}\n`);
    },
    async panel(kind, ctx) {
      return resolvePanel(kind)(ctx);
    },
  };
}

export function writeHuman(ctx: { readonly stdio: { readonly stdout: NodeJS.WritableStream } }, text: string): void {
  ctx.stdio.stdout.write(`${sanitizeHuman(text)}\n`);
}
