// Providers contract (DESIGN 3.7, spec 10): routing, the auth-mode policy, the billing table's row, quota parsing.
// Cohorte stamps accounting ITSELF from this table: never from the engine's `isSubscription` flag, never from its
// always-computed catalogue cost.
import type {
  AuthMode,
  ErrorInfo,
  ModelCapability,
  ModelRef,
  MonetaryCost,
  QuotaInfo,
  Result,
  ThinkingLevel,
  TokenUsage,
} from '@cohorte/base';
import type { CohorteConfig } from '@cohorte/config/schema';

/** How a provider is reached. `pi-oauth` = a subscription login held by Pi; `api-key` = a metered key (opt-in). */
export type ProviderAccess = 'pi-oauth' | 'api-key';

export interface ModelRequest {
  role: string;
  /** absent = `routing.defaults[role]` */
  tier?: ModelCapability;
}

export interface ResolvedModel {
  ref: ModelRef;
  thinking: ThinkingLevel;
  tier: ModelCapability;
  /** the PINNED endpoint: the guard fetch refuses any other origin (DESIGN 3.7 layer 4-5) */
  baseUrl: string;
  access: ProviderAccess;
}

export type RoutingInput = Pick<CohorteConfig, 'routing' | 'authentication'>;

/** V3.0: static tier table, validated FAIL-CLOSED at run start; no automatic cross-provider fallback (ADR-0006). */
export type ResolveModel = (request: ModelRequest, config: RoutingInput) => Result<ResolvedModel, ErrorInfo>;

export interface AuthDecision {
  provider: string;
  access: ProviderAccess;
  /** what is RECORDED: Anthropic through Pi OAuth is `api` (billed per token), not `subscription` */
  authMode: AuthMode;
  /** true = appears in `RunPlan.meteredProviders` and opens an `api-billing` approval */
  metered: boolean;
}

/** Subscription by default; API keys opt-in; the Anthropic triple opt-in. `authMode` can never change inside a run. */
export interface AuthPolicy {
  readonly mode: AuthMode;
  readonly allowApiKeys: boolean;
  readonly allowedProviders: readonly string[];
  /** refused: `provider-terminal/auth-required` or `security/auth-mode-violation`, never a silent downgrade to a paid API */
  decide(provider: string): Result<AuthDecision, ErrorInfo>;
}

/** One row of the BILLING table (DESIGN 3.7 layer 6). */
export interface BillingRow {
  /** a provider id, or '*' for "any provider reached with an API key" */
  provider: string;
  access: ProviderAccess;
  authMode: AuthMode;
  billing: 'plan-limits' | 'metered';
  /** a metered leg is NEVER 'not_applicable' (I8) */
  monetaryCost: 'not_applicable' | 'estimate' | 'catalogue';
}

export interface BillingLeg {
  provider: string;
  model: string;
  access: ProviderAccess;
  usage: TokenUsage;
}

export interface BilledLeg {
  authMode: AuthMode;
  billing: BillingRow['billing'];
  monetaryCost: MonetaryCost;
}

export type CostOf = (leg: BillingLeg) => BilledLeg;

export interface ParsedQuota {
  quota: QuotaInfo;
  /** from `retry-after` */
  retryAfterMs?: number;
}

/** `x-ratelimit-*`, `retry-after`, `x-codex-*`. Pure; header names are matched case-insensitively. */
export type ParseQuotaHeaders = (
  provider: string,
  headers: Readonly<Record<string, string>>,
  observedAt: Date,
) => ParsedQuota;
