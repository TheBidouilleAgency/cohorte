import { describe, expect, it } from 'vitest';
import { gateAsk, gatePrompt, needsArgument } from './gate';
import { usd, num } from './format';

describe('gate', () => {
  it('recognises a needsConfirmation error only', () => {
    expect(gateAsk({ error: 'x' })).toBeNull();
    expect(gateAsk(undefined)).toBeNull();
    const a = gateAsk({ error: 'x', needsConfirmation: true, command: 'pnpm dev', reason: 'ask' });
    expect(a).toEqual({ command: 'pnpm dev', reason: 'ask' });
    expect(gatePrompt(a!)).toContain('pnpm dev');
  });
  it('asks for an argument only when the command declares one and none is given', () => {
    expect(needsArgument('<id>', '  ')).toBe(true);
    expect(needsArgument('<id>', 'f1')).toBe(false);
    expect(needsArgument('', '')).toBe(false);
  });
  it('formats money and numbers', () => {
    expect(usd(1.234)).toBe('$1.23');
    expect(usd(undefined)).toBe('–');
    expect(num('x')).toBe('–');
  });
});
