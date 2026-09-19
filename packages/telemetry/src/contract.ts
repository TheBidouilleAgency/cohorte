// Telemetry contract (spec 19): a logger that accepts SEALED text only, and pure usage-accounting reducers.
import type { AuthMode, Clock, IsoInstant, MonetaryCost, SealedJson, SealedText, TokenUsage } from '@cohorte/base';

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/** One NDJSON line. */
export interface LogRecord {
  at: IsoInstant;
  level: LogLevel;
  scope: string;
  message: SealedText;
  fields?: SealedJson;
}

/** A plain `string` does not compile here: redaction is a TYPE, not a convention (DESIGN 2.6.5). */
export interface Logger {
  debug(message: SealedText, fields?: SealedJson): void;
  info(message: SealedText, fields?: SealedJson): void;
  warn(message: SealedText, fields?: SealedJson): void;
  error(message: SealedText, fields?: SealedJson): void;
  child(scope: string): Logger;
  flush(): Promise<void>;
}

export interface LogSink {
  write(line: string): void;
  flush?(): Promise<void>;
}

export interface LoggerOptions {
  /** stderr, a file, or an injected sink. NEVER stdout: stdout belongs to `--json` and the NDJSON stream. */
  sink: 'stderr' | { file: string } | LogSink;
  level: LogLevel;
  clock: Clock;
  scope?: string;
}

/** One model leg, already stamped by Cohorte's own BILLING table (DESIGN 3.7 layer 6). */
export interface UsageLeg {
  provider: string;
  model: string;
  authMode: AuthMode;
  billing: 'plan-limits' | 'metered';
  usage: TokenUsage;
  monetaryCost: MonetaryCost;
}

export interface UsageBucket {
  modelRequests: number;
  usage: TokenUsage;
  /** USD, metered legs only */
  meteredAmount: number;
  /** true as soon as one metered leg was priced by `estimate` */
  hasEstimate: boolean;
}

export interface UsageTotals extends UsageBucket {
  toolCalls: number;
  byProvider: Record<string, UsageBucket>;
}

/** Pure reducers: the same legs in the same order give the same totals, so a resumed run re-derives them from events. */
export interface Accounting {
  empty(): UsageTotals;
  addLeg(totals: UsageTotals, leg: UsageLeg): UsageTotals;
  addToolCall(totals: UsageTotals): UsageTotals;
  merge(a: UsageTotals, b: UsageTotals): UsageTotals;
}
