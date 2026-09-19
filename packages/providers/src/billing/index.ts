// The V3.0 billing table (PLAN U3.10).
import type { BilledLeg, BillingLeg } from '../contract.ts';

export function costOf(leg: BillingLeg): BilledLeg {
  if (leg.provider === 'openai-codex' && leg.access === 'pi-oauth')
    return { authMode: 'subscription', billing: 'plan-limits', monetaryCost: 'not_applicable' };
  if (leg.provider === 'anthropic' && leg.access === 'pi-oauth')
    return {
      authMode: 'api',
      billing: 'metered',
      monetaryCost: {
        currency: 'USD',
        amount: leg.usage.total * 0.00001,
        basis: 'estimate',
        priceCatalogVersion: '2026-09-01',
      },
    };
  return {
    authMode: 'api',
    billing: 'metered',
    monetaryCost: {
      currency: 'USD',
      amount: leg.usage.total * 0.00001,
      basis: 'catalogue',
      priceCatalogVersion: '2026-09-01',
    },
  };
}
