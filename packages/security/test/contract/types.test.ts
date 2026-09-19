import type { Sha256 } from '@cohorte/base';
import type { TrustStore } from '@cohorte/config/schema';
import { describe, expectTypeOf, test } from 'vitest';
import type {
  CommandAuthenticator,
  CommandRequest,
  ExecRequest,
  Executor,
  GlobMatcher,
  PathResolver,
  PolicyEngine,
  PolicyPorts,
  PolicyVerdict,
  ToolIntrospection,
} from '../../src/contract/index.ts';
import type { createTrustStore } from '../../src/index.ts';

type StringKeysOf<T> = { [K in keyof T]-?: string extends T[K] ? K : never }[keyof T];
type IsPromise<T> = T extends PromiseLike<unknown> ? true : false;

describe('type-level guarantees of the security contract', () => {
  test('I3: CommandRequest has no `script` and no command-line member: only `cwd` is a string', () => {
    expectTypeOf<CommandRequest>().not.toHaveProperty('script');
    expectTypeOf<CommandRequest>().not.toHaveProperty('command');
    expectTypeOf<CommandRequest>().not.toHaveProperty('shell');
    expectTypeOf<StringKeysOf<CommandRequest>>().toEqualTypeOf<'cwd'>();
    expectTypeOf<CommandRequest['argv']>().toEqualTypeOf<readonly string[]>();
  });

  test('Executor.run takes argv only', () => {
    expectTypeOf<Executor['run']>().parameters.toEqualTypeOf<[ExecRequest, AbortSignal]>();
    expectTypeOf<ExecRequest['args']>().toEqualTypeOf<readonly string[]>();
    expectTypeOf<ExecRequest>().not.toHaveProperty('shell');
    expectTypeOf<ExecRequest>().not.toHaveProperty('command');
    expectTypeOf<ExecRequest['stdin']>().toEqualTypeOf<'ignore'>();
    // a command line is not an ExecRequest
    expectTypeOf<string>().not.toMatchTypeOf<Parameters<Executor['run']>[0]>();
  });

  test('every PolicyPorts member is synchronous, and so is the engine', () => {
    expectTypeOf<IsPromise<ReturnType<PolicyPorts['paths']['resolve']>>>().toEqualTypeOf<false>();
    expectTypeOf<IsPromise<ReturnType<PolicyPorts['branches']['branchOf']>>>().toEqualTypeOf<false>();
    expectTypeOf<IsPromise<ReturnType<PolicyPorts['budgets']['remaining']>>>().toEqualTypeOf<false>();
    expectTypeOf<ReturnType<PolicyPorts['budgets']['callsInLastMinute']>>().toEqualTypeOf<number>();
    expectTypeOf<IsPromise<ReturnType<PolicyPorts['programs']['resolve']>>>().toEqualTypeOf<false>();
    expectTypeOf<IsPromise<ReturnType<PolicyPorts['clock']['now']>>>().toEqualTypeOf<false>();
    expectTypeOf<ReturnType<PolicyEngine['evaluate']>>().toEqualTypeOf<PolicyVerdict>();
    expectTypeOf<keyof PolicyPorts>().toEqualTypeOf<'paths' | 'branches' | 'budgets' | 'programs' | 'clock'>();
  });

  test('CommandAuthenticator signs a string of BYTES handed in by the caller: no protocol type', () => {
    expectTypeOf<CommandAuthenticator['sign']>().parameters.toEqualTypeOf<[string, Uint8Array]>();
    expectTypeOf<CommandAuthenticator['sign']>().returns.toEqualTypeOf<string>();
    expectTypeOf<CommandAuthenticator['verify']>().parameters.toEqualTypeOf<[string, string, Uint8Array]>();
    expectTypeOf<CommandAuthenticator['verify']>().returns.toEqualTypeOf<boolean>();
    expectTypeOf<CommandAuthenticator['scheme']>().toEqualTypeOf<'hmac-sha256'>();
  });

  test('PathResolver never throws: it returns a Result', () => {
    expectTypeOf<ReturnType<PathResolver['resolve']>>().toHaveProperty('ok');
  });

  test('GlobMatcher is the one glob semantics; ToolIntrospection keeps `tools` out of this package', () => {
    expectTypeOf<Parameters<GlobMatcher['toExcludeArgs']>[1]>().toEqualTypeOf<'rg-glob' | 'git-pathspec'>();
    expectTypeOf<Parameters<GlobMatcher['isDenied']>[2]>().toEqualTypeOf<'read' | 'write'>();
    expectTypeOf<keyof ToolIntrospection>().toEqualTypeOf<'schemaOf' | 'pathArgsOf'>();
  });

  test('createTrustStore implements the TrustStore port of @cohorte/config/schema', () => {
    expectTypeOf<ReturnType<typeof createTrustStore>>().toEqualTypeOf<TrustStore>();
    expectTypeOf<Parameters<TrustStore['lookup']>>().toEqualTypeOf<[string, Sha256]>();
  });
});
