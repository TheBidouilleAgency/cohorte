// DESIGN 1.2 — the port table, re-declared here as the one place `core` names an L0-L3 implementer, plus the ports
// this plan adds (PLAN PC-4) so that no two core units of later waves ever import each other directly. Every port a
// unit needs is imported from HERE, never reconstructed locally.
import type { Clock, ErrorInfo, IdSource, Redactor, Result, Sha256 } from '@cohorte/base';
import type { GitPort } from '@cohorte/git/contract';
import type { EffectKind, EffectRecord, LeaseToken } from '@cohorte/persistence/contract';
import type { CostOf, ModelRequest, ResolvedModel, ResolveModel, RoutingInput } from '@cohorte/providers/contract';
import type { AgentRuntimeProvider } from '@cohorte/runtime-contract';
import type { CommandAuthenticator, Executor, KeyStore, PathResolver, PolicyEngine } from '@cohorte/security/contract';
import type { ToolRegistry } from '@cohorte/tools/registry';
import type { WorkspaceReader } from '@cohorte/tools/workspace';
import type { GuardId, TransitionEffectId } from './ids.ts';
import type { GlobalFacts, Guard } from './types.ts';

export type { BlobStore, EphemeralSpool, LeaseToken, RunFiles, StateStore } from '@cohorte/persistence/contract';
export type {
  AgentRuntimeProvider,
  Clock,
  CommandAuthenticator,
  Executor,
  GitPort,
  IdSource,
  KeyStore,
  PathResolver,
  PolicyEngine,
  Redactor,
  Result,
  ToolRegistry,
  WorkspaceReader,
};

// ── ports this plan adds (PLAN PC-4) so units never import each other ────────────────────────────────────────────

/** Resolves a role/tier request to a concrete model, fail-closed, at run start (DESIGN 3.7). */
export interface ModelResolver {
  resolve: ResolveModel;
}
export type { ModelRequest, ResolvedModel, RoutingInput };

/** Sweeps orphaned OS processes by `(pid, startToken)`, never by a bare pid (DESIGN 4.4 step "orphan sweep"). */
export interface ProcessSweeper {
  isAlive(pid: number, startToken: string): boolean;
  kill(pid: number, startToken: string, signal?: string): Promise<void>;
}

/** A kind-specific verifier per DESIGN 4.1's table, looked up by `Resumer` during effect reconciliation. */
export interface EffectVerifier {
  verify(record: EffectRecord, signal: AbortSignal): Promise<'done' | 'not-done' | 'in-doubt'>;
}
export interface EffectVerifierRegistry {
  get(kind: EffectKind): EffectVerifier | undefined;
}

/** Every guard of `GUARD_IDS`, registered once (DESIGN 2.5.1), looked up by id by the engine. */
export interface GuardRegistry {
  get(id: GuardId): Guard | undefined;
  ids(): readonly GuardId[];
}

/** Gathers the facts a row's guards need BEFORE evaluation, through ports (DESIGN 2.5.1 "collectFacts(ids)"). */
export interface FactCollector {
  collect(ids: readonly GuardId[]): Promise<GlobalFacts>;
}

/** Executes one declarative `TransitionEffectId` of a row (DESIGN 2.5.1's `effects` column), through the journal. */
export interface TransitionEffectRunner {
  run(
    id: TransitionEffectId,
    ctx: { runId: string; slot?: string; lease: LeaseToken },
    signal: AbortSignal,
  ): Promise<void>;
}

/** Cohorte's own accounting stamp, never the engine's (DESIGN 3.7 layer 6): a metered leg is never `not_applicable`. */
export interface BillingTable {
  costOf: CostOf;
}

/** Embedded prompts/skills/schemas/migrations + manifest verification (DESIGN 1.2, apps/cli). */
export interface AssetSource {
  prompt(id: string): Promise<{ path: string; sha256: Sha256; bytes: number }>;
  skill(id: string): Promise<{ path: string; sha256: Sha256; bytes: number }>;
  schema(id: string): Promise<{ path: string; sha256: Sha256; bytes: number }>;
  migration(id: string): Promise<{ path: string; sha256: Sha256; bytes: number }>;
  treeSha256(): Sha256;
  verify(): Promise<Result<true, ErrorInfo>>;
}

/** Bundle paths + hashes of the installation Cohorte is running from (DESIGN 1.2, apps/cli). */
export interface InstallInspector {
  installDir(): string;
  bundleManifest(): Promise<{ file: string; sha256: Sha256; bytes: number }[]>;
}
