// apps/cli/src/commands/auth/index.ts — DESIGN §9 verb `auth`; provider authentication is delegated to the
// selected runtime child so credentials never cross the CLI/runtime boundary.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import type { ProviderAuthStatus } from '@cohorte/runtime-contract';
import type { CommandModule } from '../../contract/index.ts';

type Spawn = typeof spawn;

/** Open an OAuth URL without involving a shell. The URL is always printed by the caller as a fallback. */
export function openBrowser(rawUrl: string, spawnProcess: Spawn = spawn): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;

  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd.exe' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url.toString()] : [url.toString()];
  try {
    const child = spawnProcess(command, args, { detached: true, stdio: 'ignore' });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

function document(ctx: Parameters<CommandModule['run']>[0], statuses: ProviderAuthStatus[]) {
  return {
    documentVersion: 1,
    generatedAt: ctx.clock.now(),
    runtime: (() => {
      const runtime = ctx.runtime.resolve();
      return { id: runtime.id, version: 'unknown' };
    })(),
    providers: statuses.map((status) => ({
      ...status,
      ...(status.accountLabel === undefined ? { accountLabelNote: 'account: not exposed by the engine' } : {}),
    })),
  };
}

function print(ctx: Parameters<CommandModule['run']>[0], value: ReturnType<typeof document>): void {
  if (ctx.stdio.stdout && value) ctx.stdio.stdout.write(`${JSON.stringify(value)}\n`);
}

async function loginUi(ctx: Parameters<CommandModule['run']>[0], signal: AbortSignal) {
  const readline = createInterface({ input: ctx.stdio.stdin, output: ctx.stdio.stdout, terminal: false });
  const abort = () => readline.close();
  signal.addEventListener('abort', abort, { once: true });
  return {
    show(event: {
      kind: string;
      url?: string;
      instructions?: string;
      message?: string;
      userCode?: string;
      verificationUri?: string;
    }) {
      if (event.kind === 'open-url') {
        const lines = [event.instructions, event.url ? `Open: ${event.url}` : undefined].filter(
          (value): value is string => Boolean(value),
        );
        if (lines.length) ctx.stdio.stdout.write(`${lines.join('\n')}\n`);
        if (event.url) openBrowser(event.url);
        return;
      }
      if (event.kind === 'device-code') {
        const lines = [
          event.verificationUri ? `Open: ${event.verificationUri}` : undefined,
          event.userCode ? `Code: ${event.userCode}` : undefined,
          event.instructions,
          event.message,
        ].filter((value): value is string => Boolean(value));
        if (lines.length) ctx.stdio.stdout.write(`${lines.join('\n')}\n`);
        return;
      }
      const text = event.message ?? event.instructions ?? event.url ?? event.verificationUri ?? event.userCode ?? '';
      if (text) ctx.stdio.stdout.write(`${text}\n`);
    },
    async ask(prompt: { kind: string; message: string; options?: { id: string; label: string }[] }) {
      if (prompt.kind === 'select' && prompt.options?.length) {
        ctx.stdio.stdout.write(`${prompt.message}\n`);
        prompt.options.forEach((option, index) => {
          ctx.stdio.stdout.write(`  ${index + 1}. ${option.label}\n`);
        });
        const answer = await readline.question('Choice: ');
        const index = Number.parseInt(answer, 10) - 1;
        return prompt.options[index]?.id ?? answer;
      }
      return readline.question(`${prompt.message} `);
    },
    close() {
      signal.removeEventListener('abort', abort);
      readline.close();
    },
  };
}

const auth: CommandModule = {
  verb: 'auth',
  async run(ctx, args) {
    const runtime = ctx.runtime.resolve();
    const provider = args.positionals[0];
    if (args.subVerb === 'status' || args.subVerb === undefined) {
      const statuses = await runtime.authStatus(provider ? [provider] : ['openai-codex', 'anthropic']);
      const value = document(ctx, statuses);
      if (args.json) print(ctx, value);
      else
        for (const status of value.providers)
          ctx.stdio.stdout.write(`${status.provider}: ${status.state} (${status.billing})\n`);
      return 0;
    }
    if (!provider) return 2;
    if (args.subVerb === 'logout') {
      await runtime.logout(provider);
      const value = document(ctx, await runtime.authStatus([provider]));
      if (args.json) print(ctx, value);
      else ctx.stdio.stdout.write(`${provider}: logged out\n`);
      return 0;
    }
    if (args.subVerb === 'login') {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10 * 60_000);
      const ui = await loginUi(ctx, controller.signal);
      try {
        const status = await runtime.login(provider, ui, controller.signal);
        const value = document(ctx, [status]);
        if (args.json) print(ctx, value);
        else ctx.stdio.stdout.write(`${status.provider}: ${status.state}\n`);
        return 0;
      } finally {
        clearTimeout(timeout);
        ui.close();
      }
    }
    return 10;
  },
};

export default auth;
