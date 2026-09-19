import type { SealedText } from '@cohorte/base';
import { describe, expectTypeOf, test } from 'vitest';
import type {
  AgentExit,
  AgentRole,
  AgentRuntime,
  AgentRuntimeProvider,
  Continuation,
  DurableRuntimeEvent,
  EphemeralRuntimeEvent,
  RuntimeEvent,
  RuntimeEventOf,
  RuntimeHostBindings,
  RuntimeToolCall,
  RuntimeToolResult,
  SpawnRequest,
  ToolCallContext,
  ToolContent,
  ToolGrant,
  ToolHost,
  TranscriptRef,
} from '../src/index.ts';

describe('rule C1 in the types (S-60 seed)', () => {
  test('RuntimeHostBindings holds a ToolHost, a directory function, a clock, ids and a logger: nothing that executes', () => {
    expectTypeOf<keyof RuntimeHostBindings>().toEqualTypeOf<'toolHost' | 'stateDir' | 'clock' | 'ids' | 'log'>();
    expectTypeOf<keyof ToolHost>().toEqualTypeOf<'handleToolCall'>();
    expectTypeOf<RuntimeHostBindings['stateDir']>().returns.toEqualTypeOf<string>();
    expectTypeOf<RuntimeHostBindings['log']>().returns.toEqualTypeOf<void>();
    // The one door out of a runtime: a DESCRIPTION of the call goes to the host, a sealed result comes back.
    expectTypeOf<ToolHost['handleToolCall']>().parameters.toEqualTypeOf<[RuntimeToolCall, ToolCallContext]>();
    expectTypeOf<ToolHost['handleToolCall']>().returns.toEqualTypeOf<Promise<RuntimeToolResult>>();
    expectTypeOf<keyof ToolCallContext>().toEqualTypeOf<'signal' | 'progress'>();
  });

  test('a tool result text is sealed: a plain string does not typecheck', () => {
    type Text = Extract<ToolContent, { type: 'text' }>['text'];
    expectTypeOf<Text>().toEqualTypeOf<SealedText>();
    expectTypeOf<string>().not.toExtend<Text>();
  });
});

describe('spec 5.1, verbatim', () => {
  test('AgentRuntime has the eleven members of the spec and no other', () => {
    expectTypeOf<keyof AgentRuntime>().toEqualTypeOf<
      | 'id'
      | 'version'
      | 'capabilities'
      | 'spawn'
      | 'send'
      | 'cancel'
      | 'pause'
      | 'resume'
      | 'subscribe'
      | 'inspect'
      | 'close'
    >();
    expectTypeOf<AgentRuntime['send']>().parameter(0).toEqualTypeOf<string>();
    expectTypeOf<AgentRuntime['spawn']>().parameter(0).toEqualTypeOf<SpawnRequest>();
  });

  test('pinning, auth status and login live on the provider', () => {
    expectTypeOf<keyof AgentRuntimeProvider>().toEqualTypeOf<
      'id' | 'pin' | 'create' | 'authStatus' | 'login' | 'logout'
    >();
  });

  test('role, tool names and transcript formats are strings, never closed unions', () => {
    expectTypeOf<AgentRole>().toEqualTypeOf<string>();
    expectTypeOf<SpawnRequest['role']>().toEqualTypeOf<string>();
    expectTypeOf<ToolGrant['tool']>().toEqualTypeOf<string>();
    expectTypeOf<RuntimeToolCall['tool']>().toEqualTypeOf<string>();
    expectTypeOf<TranscriptRef['format']>().toEqualTypeOf<string>();
    expectTypeOf<AgentRuntime['id']>().toEqualTypeOf<string>();
  });

  test('every addition to SpawnRequest is required', () => {
    expectTypeOf<SpawnRequest['continuation']>().toEqualTypeOf<Continuation | null>();
    expectTypeOf<SpawnRequest['incarnation']>().toEqualTypeOf<number>();
  });
});

describe('durability is part of the type', () => {
  test('RuntimeEvent is discriminated on type, and each type has ONE durability', () => {
    expectTypeOf<RuntimeEventOf<'agent.exited'>['data']>().toEqualTypeOf<AgentExit>();
    expectTypeOf<RuntimeEventOf<'agent.exited'>['durability']>().toEqualTypeOf<'durable'>();
    expectTypeOf<RuntimeEventOf<'agent.message.delta'>['durability']>().toEqualTypeOf<'ephemeral'>();
    expectTypeOf<RuntimeEventOf<'agent.resumed'>['data']>().toEqualTypeOf<Record<string, never>>();
    expectTypeOf<EphemeralRuntimeEvent['type']>().toEqualTypeOf<
      'agent.turn.started' | 'agent.message.started' | 'agent.message.delta' | 'tool.call.progress'
    >();
    expectTypeOf<DurableRuntimeEvent | EphemeralRuntimeEvent>().toEqualTypeOf<RuntimeEvent>();
  });

  test('the stop of a model response is the closed five-value set', () => {
    expectTypeOf<RuntimeEventOf<'model.responded'>['data']['stop']>().toEqualTypeOf<
      'stop' | 'length' | 'tool-use' | 'error' | 'aborted'
    >();
  });
});
