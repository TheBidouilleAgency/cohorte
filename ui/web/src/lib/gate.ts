import type { ApiErrorBody } from '../../../shared/api';

export interface GateAsk { command: string; reason: string }

/** Prompt for the project gate's `ask` verdict, or null if the error is not one. */
export function gateAsk(body: Partial<ApiErrorBody> | undefined): GateAsk | null {
  if (!body || body.needsConfirmation !== true) return null;
  return { command: body.command ?? '', reason: body.reason ?? '' };
}

export const gatePrompt = (a: GateAsk): string => `The project's gate asks before running:\n\n${a.command}\n\n${a.reason}\n\nRun it?`;

export const untrustedPrompt = (message: string, fix?: string): string =>
  `${message}\n\nFix: ${fix || 'run claude once in this folder and accept the trust dialog'}\n\nRun anyway?`;

export const missingArgPrompt = (name: string, hint: string): string =>
  `${name} usually takes an argument ${hint}. Without one it may ask a free-text question this dashboard cannot answer.\n\nRun without?`;

export function needsArgument(argumentHint: string | undefined, args: string): boolean {
  return !!argumentHint && !args.trim();
}
