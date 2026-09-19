// apps/cli/test/registry/exit-codes.test.ts — PLAN U0.10 test list: "exit-code table is total over ErrorClass";
// "controller codes 0/2/3/4 documented in --help".
import { EXIT_CODE_BY_CLASS as BASE_EXIT_CODE_BY_CLASS, ERROR_CLASSES } from '@cohorte/base';
import { HALTED_STATES, SUSPENDED_STATES, TERMINAL_STATES } from '@cohorte/protocol';
import { describe, expect, test } from 'vitest';
import { runCli } from '../../src/cli.ts';
import {
  CANCELLED_EXIT_CODE,
  COMPLETED_EXIT_CODE,
  EXIT_CODE_BY_CLASS,
  SUSPENDED_EXIT_CODE,
  waitExitCode,
} from '../../src/contract/index.ts';
import { testDeps } from './helpers.ts';

describe('exit codes', () => {
  test('EXIT_CODE_BY_CLASS is total over ErrorClass and equals the base catalogue', () => {
    expect(Object.keys(EXIT_CODE_BY_CLASS).sort()).toEqual([...ERROR_CLASSES].sort());
    expect(EXIT_CODE_BY_CLASS).toEqual(BASE_EXIT_CODE_BY_CLASS);
    for (const errorClass of ERROR_CLASSES) {
      expect(typeof EXIT_CODE_BY_CLASS[errorClass]).toBe('number');
    }
  });

  test('waitExitCode: COMPLETED is 0, CANCELLED is 16, every suspended state is 4', () => {
    expect(waitExitCode('COMPLETED')).toBe(COMPLETED_EXIT_CODE);
    expect(waitExitCode('CANCELLED')).toBe(CANCELLED_EXIT_CODE);
    for (const state of SUSPENDED_STATES) expect(waitExitCode(state)).toBe(SUSPENDED_EXIT_CODE);
  });

  test('waitExitCode: a halted state returns the class code of lastError, and requires it', () => {
    for (const state of HALTED_STATES) {
      expect(waitExitCode(state, 'security')).toBe(EXIT_CODE_BY_CLASS.security);
      expect(() => waitExitCode(state)).toThrow();
    }
  });

  test('waitExitCode: an active or IDLE state is refused (never a final state for a waiter)', () => {
    expect(() => waitExitCode('BUILD')).toThrow();
    expect(() => waitExitCode('IDLE' as never)).toThrow();
  });

  test('TERMINAL_STATES are exactly COMPLETED and CANCELLED', () => {
    expect([...TERMINAL_STATES].sort()).toEqual(['CANCELLED', 'COMPLETED']);
  });

  test('--help documents the controller codes 0, 2, 3 and 4', async () => {
    const deps = testDeps();
    await runCli(['--help'], deps);
    const help = deps.out.text();
    expect(help).toMatch(/\b0\b.*completed/);
    expect(help).toMatch(/\b2\b.*usage/);
    expect(help).toMatch(/\b3\b.*rejected/);
    expect(help).toMatch(/\b4\b.*pending/);
  });
});
