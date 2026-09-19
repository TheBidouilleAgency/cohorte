// apps/cli/src/commands/auth/index.ts — DESIGN §9 verb `auth` (PLAN §3 rule 3 "later units fill
// stub files that lie inside their owned paths; they never edit ... the registry"). Wave-0 stub: exits with the
// documented not-available error (spec 24 `configuration/phase-not-available`); filled by the Wave-4/5
// unit that owns `apps/cli/src/commands/auth/**`.
import { createInterface } from 'node:readline/promises';
import type { ProviderAuthStatus } from '@cohorte/runtime-contract';
import type { CommandModule } from '../../contract/index.ts';

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
      const text = event.message ?? event.instructions ?? event.url ?? event.verificationUri ?? event.userCode ?? '';
      if (text) ctx.stdio.stdout.write(`${text}\n`);
    },
    async ask(prompt: { kind: string; message: string }) {
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
