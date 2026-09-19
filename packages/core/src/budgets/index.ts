import type { BudgetsDeps, BudgetTracker } from '../contract/factories.ts';
import { createBudgetTracker as createBudgetTrackerImpl } from '../contract/factories.ts';

export type { BudgetsDeps, BudgetTracker };
export function createBudgetTracker(deps: BudgetsDeps): BudgetTracker {
  return createBudgetTrackerImpl(deps);
}
