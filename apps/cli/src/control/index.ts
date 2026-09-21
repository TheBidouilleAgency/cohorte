// apps/cli/src/control/index.ts — AREA barrel: the `Controller` port (DESIGN 2.3.4 inbox / start routes: sign,
// `INSERT ... ON CONFLICT(command_id) DO NOTHING`, touch `inbox.poke`, wait <= `--wait`). Wave-0 stub: filled by
// `U4.02`, which owns `apps/cli/src/control/**`.
import { type Clock, type IdSource, sha256Hex } from '@cohorte/base';
import { initialRunState } from '@cohorte/core/state';
import type { StateStore } from '@cohorte/persistence/contract';
import {
  type CommandPayloads,
  type CommandResultDocument,
  type CommandType,
  canonicalCommandBody,
} from '@cohorte/protocol';
import { createCommandAuthenticator, createKeyStore } from '@cohorte/security/auth';
import type { Controller } from '../contract/index.ts';

export function createController(options: {
  openStore: () => Promise<StateStore>;
  clock: Clock;
  ids: IdSource;
  cwd: string;
  home: string;
  pinnedInstallDir?: string;
}): Controller {
  const keys = createKeyStore({ directory: `${options.home}/.cohorte/keys` });
  const authenticator = createCommandAuthenticator();
  return {
    async send<T extends CommandType>(
      type: T,
      payload: CommandPayloads[T],
      sendOptions: { readonly runId?: string; readonly waitMs?: number } = {},
    ): Promise<CommandResultDocument> {
      const commandId = options.ids.next<'CommandId'>('cmd');
      const runId = sendOptions.runId as never;
      const createdRunId = type === 'start' ? options.ids.next<'RunId'>('run') : runId;
      const envelope = {
        protocolVersion: '1.0' as const,
        commandId,
        type,
        ...(createdRunId === undefined ? {} : { runId: createdRunId }),
        issuedAt: options.clock.now(),
        actor: { kind: 'human' as const, id: 'cli', transport: 'cli' as const },
        payload,
      };
      const keyId = sha256Hex(options.cwd).slice(0, 24);
      const key = await keys.projectKey(keyId, { create: true });
      const signed = {
        ...envelope,
        auth: { scheme: authenticator.scheme, value: authenticator.sign(canonicalCommandBody(envelope), key) },
      } as never;
      const store = await options.openStore();
      const result =
        type === 'start'
          ? await store.transact('project', null, (tx) => {
              const startPayload = payload as CommandPayloads['start'];
              const status = tx.enqueueCommand(signed);
              if (status === 'enqueued') {
                const specPath =
                  startPayload.spec && 'path' in startPayload.spec ? startPayload.spec.path : 'inline-spec';
                tx.putRun(
                  initialRunState({
                    runId: createdRunId,
                    profile: startPayload.profile,
                    tableVersion: 1,
                    specId: (startPayload.spec && 'id' in startPayload.spec
                      ? startPayload.spec.id
                      : `spec_${sha256Hex(specPath).slice(0, 24)}`) as never,
                    specSha256: sha256Hex(specPath),
                    title: `${startPayload.profile} run`,
                    pinnedInstallDir: options.pinnedInstallDir ?? options.cwd,
                    baseBranch: 'main',
                    cohorteVersion: '3.0.0-dev.4',
                    schemaVersion: 1,
                    startedAt: options.clock.now(),
                  }).run,
                );
              }
              return { status, record: undefined };
            })
          : await store.enqueueCommand(signed);
      let finalStatus: 'pending' | 'completed' | 'rejected' = result.status === 'enqueued' ? 'pending' : 'rejected';
      if (result.status === 'enqueued' && sendOptions.waitMs && sendOptions.waitMs > 0) {
        const deadline = Date.now() + Math.min(sendOptions.waitMs, 30_000);
        while (Date.now() < deadline) {
          const current = await store.getCommand(commandId);
          if (current?.status === 'completed' || current?.status === 'rejected') {
            finalStatus = current.status === 'completed' ? 'completed' : 'rejected';
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      }
      await store.close();
      return {
        documentVersion: 1,
        commandId,
        type,
        status: finalStatus,
        ...(type === 'start' && result.status === 'enqueued' ? { result: { runId: createdRunId } } : {}),
        ...(result.status === 'enqueued'
          ? {}
          : {
              error: {
                code: 'conflict/command-id-reuse',
                class: 'conflict',
                message: result.status,
                impact: 'command was not accepted',
                retryable: false,
                remediation: 'retry with a new command',
              } as never,
            }),
      };
    },
  };
}
