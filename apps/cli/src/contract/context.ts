// apps/cli/src/contract/context.ts — DESIGN 1.2 (apps/cli composition root) + PLAN PC-4. `CliContext` is the ONE
// object every command module receives; it never depends on `process.env` for a read-only verb (spec 21 "aucune
// variable d'environnement requise pour un verbe de lecture"). Every heavy port is a Wave-0 SEAM: its concrete
// value is assembled by `compose/index.ts` (U4.01), which is itself a frozen NotImplemented stub until then, so a
// verb that never touches a port never pays for one (DESIGN 1.3 "read-only verbs never load core/runtime").
import type { Clock, IdSource, JsonValue } from '@cohorte/base';
import type { AssetSource, InstallInspector } from '@cohorte/core/contract';
import type { StateStore } from '@cohorte/persistence/contract';
import type { CommandPayloads, CommandResultDocument, CommandType, StopRecord } from '@cohorte/protocol';
import type { AgentRuntimeProvider } from '@cohorte/runtime-contract';

export type { AssetSource, InstallInspector } from '@cohorte/core/contract';

/** stdio the CLI writes to / reads from — never `process.stdout` directly, so a test can capture it. */
export interface CliStdio {
  readonly stdout: NodeJS.WritableStream;
  readonly stderr: NodeJS.WritableStream;
  readonly stdin: NodeJS.ReadableStream;
}

/** Opens the project's `StateStore`, walking up from `cwd` to find `.cohorte/` (DESIGN 4.7: no env var needed). */
export type OpenStore = () => Promise<StateStore>;
/** Opens the state store before the schema is current; only `migrate` may use this path. */
export type OpenMigrationStore = () => Promise<StateStore>;

/** The controller side of DESIGN 2.3.4's inbox / start routes: sign, enqueue, wait ≤ `--wait`. */
export interface Controller {
  send<T extends CommandType>(
    type: T,
    payload: CommandPayloads[T],
    options?: { readonly runId?: string; readonly waitMs?: number },
  ): Promise<CommandResultDocument>;
}

/** The observer side (DESIGN 4.7): a pure reader, no lock, no write, no temp file. */
export interface Observer {
  /** One durable event / a `snapshot` line / an ephemeral, merged by `(sequence, sub)` (DESIGN 4.7). */
  follow(options: {
    readonly runId: string;
    readonly sinceSequence?: number;
    readonly replay?: number;
    readonly ephemeral?: boolean;
    readonly signal?: AbortSignal;
  }): AsyncIterable<JsonValue>;
}

/** Spawns the detached run host (DESIGN 4.7: `<pinned node> <pinned install>/dist/cli.mjs __host --run <runId>`). */
export interface HostSpawner {
  spawnDetached(runId: string): Promise<{ readonly pid: number }>;
}

/** Runs a host in the current process. Production supplies this only to the hidden `__host` entry point. */
export interface HostRunner {
  run(runId: string): Promise<StopRecord>;
}

/** Renders a document / NDJSON line / an interactive panel (`--panel`, francois.md: 10 s / 4 MiB one-shot budget). */
export interface Renderer {
  json(value: JsonValue): void;
  line(text: string): void;
  panel(kind: string, ctx: CliContext): Promise<number>;
}

/** Runtime providers available to a `run` (DESIGN 9: PiRuntime + FakeRuntime; `runtime: string` selects one). */
export interface RuntimeProviders {
  resolve(name?: string): AgentRuntimeProvider;
  /** Optional capability snapshot for diagnostics; providers remain responsible for pin/auth. */
  capabilities?(): unknown;
}

export interface CliContext {
  readonly clock: Clock;
  readonly ids: IdSource;
  readonly stdio: CliStdio;
  readonly cwd: string;
  /** Read only by verbs that need it (mutating ones, `auth`, `providers`); a read-only verb never touches it. */
  readonly env: Readonly<NodeJS.ProcessEnv>;
  readonly openStore: OpenStore;
  readonly openMigrationStore?: OpenMigrationStore;
  readonly controller: Controller;
  readonly observer: Observer;
  readonly hostSpawner: HostSpawner;
  /** Present only in the detached host composition; ordinary CLI verbs must not depend on it. */
  readonly hostRunner?: HostRunner;
  readonly renderer: Renderer;
  readonly runtime: RuntimeProviders;
  readonly assets: AssetSource;
  readonly install: InstallInspector;
}
