import type { Accounting as AccountingReducers, UsageBucket, UsageLeg, UsageTotals } from '../contract.ts';

const emptyUsage = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 });
const emptyBucket = (): UsageBucket => ({
  modelRequests: 0,
  usage: emptyUsage(),
  meteredAmount: 0,
  hasEstimate: false,
});

function addUsage(a: UsageTotals['usage'], b: UsageTotals['usage']): UsageTotals['usage'] {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    total: a.total + b.total,
  };
}

function addBucket(a: UsageBucket, b: UsageBucket): UsageBucket {
  return {
    modelRequests: a.modelRequests + b.modelRequests,
    usage: addUsage(a.usage, b.usage),
    meteredAmount: a.meteredAmount + b.meteredAmount,
    hasEstimate: a.hasEstimate || b.hasEstimate,
  };
}

function bucketFor(leg: UsageLeg): UsageBucket {
  return {
    modelRequests: 1,
    usage: leg.usage,
    meteredAmount: leg.monetaryCost === 'not_applicable' ? 0 : leg.monetaryCost.amount,
    hasEstimate: leg.monetaryCost !== 'not_applicable' && leg.monetaryCost.basis === 'estimate',
  };
}

export const Accounting: AccountingReducers = Object.freeze({
  empty: (): UsageTotals => ({ ...emptyBucket(), toolCalls: 0, byProvider: {} }),
  addLeg: (totals: UsageTotals, leg: UsageLeg): UsageTotals => {
    const provider = totals.byProvider[leg.provider] ?? emptyBucket();
    const added = bucketFor(leg);
    return {
      ...addBucket(totals, added),
      toolCalls: totals.toolCalls,
      byProvider: { ...totals.byProvider, [leg.provider]: addBucket(provider, added) },
    };
  },
  addToolCall: (totals: UsageTotals): UsageTotals => ({ ...totals, toolCalls: totals.toolCalls + 1 }),
  merge: (a: UsageTotals, b: UsageTotals): UsageTotals => {
    const providers = new Set([...Object.keys(a.byProvider), ...Object.keys(b.byProvider)]);
    return {
      ...addBucket(a, b),
      toolCalls: a.toolCalls + b.toolCalls,
      byProvider: Object.fromEntries(
        [...providers].map((provider) => [
          provider,
          addBucket(a.byProvider[provider] ?? emptyBucket(), b.byProvider[provider] ?? emptyBucket()),
        ]),
      ),
    };
  },
});
