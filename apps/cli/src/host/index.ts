// apps/cli/src/host/index.ts — AREA barrel: the `HostSpawner` (DESIGN 4.7 "spawns <pinned node> <pinned
// install>/dist/cli.mjs __host --run <runId> with detached: true, stdio to runs/<id>/host.log, unref()"). Wave-0
// stub: filled by `U4.01`, which owns `apps/cli/src/host/**`.
import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { mkdir, open } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { CohorteError, errorOf, type RunId } from '@cohorte/base';
import type { RunEngine } from '@cohorte/core/contract';
import type { StateStore } from '@cohorte/persistence/contract';
import type { StopRecord } from '@cohorte/protocol';
import type { HostSpawner } from '../contract/index.ts';
import { verifyPinnedInstall } from '../pin/index.ts';

export interface RunHost {
  run(): Promise<StopRecord>;
}

export interface RunHostDeps {
  engine: RunEngine;
  runId: RunId;
  cohorteVersion: string;
  cwd?: string;
  targetRoot?: string;
  hostId?: string;
  signal?: AbortSignal;
  heartbeatMs?: number;
  heartbeat?: (host: { hostId: string; pid: number; startToken: string }) => Promise<void> | void;
}

function canonical(path: string): string {
  const absolute = isAbsolute(path) ? path : resolve(path);
  try {
    return realpathSync.native(absolute);
  } catch {
    return absolute;
  }
}

function assertHostTarget(cwd: string, targetRoot: string | undefined): void {
  if (typeof process.getuid === 'function' && process.getuid() === 0)
    throw new CohorteError(errorOf('security/root-refused', 'run hosts must not run as uid 0'));
  if (targetRoot === undefined) return;
  const current = canonical(cwd);
  const target = canonical(targetRoot);
  if (current === target || current.startsWith(`${target}/`))
    throw new CohorteError(errorOf('security/runtime-inside-target', `host cwd ${current} is inside target ${target}`));
}

export function createRunHost(deps: RunHostDeps): RunHost {
  const cwd = deps.cwd ?? process.cwd();
  const host = {
    hostId: deps.hostId ?? `host-${process.pid}`,
    pid: process.pid,
    startToken: `${process.pid}:${process.ppid}:${process.argv0}`,
  };
  return {
    async run() {
      assertHostTarget(cwd, deps.targetRoot);
      const local = new AbortController();
      const abort = () => local.abort(deps.signal?.reason);
      if (deps.signal?.aborted) abort();
      else deps.signal?.addEventListener('abort', abort, { once: true });
      const interval = deps.heartbeatMs ?? 15_000;
      const heartbeat = deps.heartbeat;
      let timer: NodeJS.Timeout | undefined;
      if (heartbeat) {
        await heartbeat(host);
        timer = setInterval(() => {
          void heartbeat(host);
        }, interval);
        timer.unref?.();
      }
      try {
        return await deps.engine.run(deps.runId, {
          ...host,
          cohorteVersion: deps.cohorteVersion,
          signal: local.signal,
        });
      } finally {
        if (timer) clearInterval(timer);
        deps.signal?.removeEventListener('abort', abort);
      }
    },
  };
}

export function createHostSpawner(
  options: {
    cwd?: string;
    openStore?: () => Promise<StateStore>;
    install?: Parameters<typeof verifyPinnedInstall>[0];
  } = {},
): HostSpawner {
  const cwd = options.cwd ?? process.cwd();
  return {
    async spawnDetached(runId: string) {
      if (typeof process.getuid === 'function' && process.getuid() === 0) {
        throw new CohorteError(errorOf('security/root-refused', 'run hosts must not run as uid 0'));
      }
      if (!options.openStore || !options.install) {
        throw new CohorteError(
          errorOf('configuration/unexpected', 'host spawner is missing its store and install bindings'),
        );
      }
      const store = await options.openStore();
      let pinnedInstallDir: string | undefined;
      try {
        const run = await store.getRun(runId as never);
        if (!run) throw new CohorteError(errorOf('validation/invalid-id', `run ${runId} does not exist`));
        pinnedInstallDir = run.pinnedInstallDir;
        const verified = await verifyPinnedInstall(options.install, pinnedInstallDir);
        if (!verified.ok) throw new CohorteError(verified.error);
      } finally {
        await store.close();
      }
      const runDir = join(cwd, '.cohorte', 'runs', runId);
      await mkdir(runDir, { recursive: true });
      const log = await open(join(runDir, 'host.log'), 'a');
      const entry = join(pinnedInstallDir as string, 'dist', 'cli.mjs');
      const child = spawn(process.execPath, [entry, '__host', '--run', runId], {
        detached: true,
        stdio: ['ignore', log.fd, log.fd],
        cwd,
      });
      child.unref();
      await log.close();
      if (child.pid === undefined) throw new Error('host process did not provide a pid');
      return { pid: child.pid };
    },
  };
}
