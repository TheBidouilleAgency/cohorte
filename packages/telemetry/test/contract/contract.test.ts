import type { SealedJson, SealedText } from '@cohorte/base';
import { FixedClock, sealedText } from '@cohorte/testkit';
import { describe, expect, expectTypeOf, test } from 'vitest';
import type { Logger, LoggerOptions, LogRecord, UsageLeg, UsageTotals } from '../../src/contract.ts';
import * as barrel from '../../src/index.ts';
import { Accounting, createLogger, LOG_LEVELS } from '../../src/index.ts';

const LEG: UsageLeg = {
  provider: 'openai-codex',
  model: 'gpt-5.5',
  authMode: 'subscription',
  billing: 'plan-limits',
  usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 },
  monetaryCost: 'not_applicable',
};

describe('the telemetry contract', () => {
  test('the logger accepts SealedText only: a plain string does not compile', () => {
    expectTypeOf<Parameters<Logger['info']>[0]>().toEqualTypeOf<SealedText>();
    expectTypeOf<Parameters<Logger['info']>[1]>().toEqualTypeOf<SealedJson | undefined>();
    expectTypeOf<Parameters<Logger['error']>[0]>().toEqualTypeOf<SealedText>();
    expectTypeOf<string>().not.toMatchTypeOf<Parameters<Logger['warn']>[0]>();
    expectTypeOf<LogRecord['message']>().toEqualTypeOf<SealedText>();
  });

  test('stdout is not a sink', () => {
    expectTypeOf<'stdout'>().not.toMatchTypeOf<LoggerOptions['sink']>();
    expectTypeOf<'stderr'>().toMatchTypeOf<LoggerOptions['sink']>();
    expect([...LOG_LEVELS]).toEqual(['debug', 'info', 'warn', 'error']);
  });

  test('the accounting reducers are pure: totals in, totals out', () => {
    expectTypeOf(Accounting.addLeg).toEqualTypeOf<(totals: UsageTotals, leg: UsageLeg) => UsageTotals>();
    expectTypeOf(Accounting.merge).returns.toEqualTypeOf<UsageTotals>();
  });
});

describe('the Wave-0 frozen barrel of @cohorte/telemetry', () => {
  test('the public API of DESIGN 1.1 exists', () => {
    expect(Object.keys(barrel).sort()).toEqual(['Accounting', 'LOG_LEVELS', 'createLogger']);
    expect(Object.isFrozen(Accounting)).toBe(true);
  });

  test('logger and accounting are executable', async () => {
    const lines: string[] = [];
    const logger = createLogger({
      sink: { write: (line) => lines.push(line) },
      level: 'info',
      clock: new FixedClock(),
    });
    logger.info(sealedText('ok'));
    logger.debug(sealedText('hidden'));
    await logger.flush();
    expect(lines).toHaveLength(1);
    expect(Accounting.addLeg(Accounting.empty(), LEG).modelRequests).toBe(1);
    expect(Accounting.addToolCall(Accounting.empty()).toolCalls).toBe(1);
    expect(Accounting.merge(Accounting.empty(), Accounting.empty()).toolCalls).toBe(0);
    expect(sealedText('ok')).toBe('ok');
  });
});
