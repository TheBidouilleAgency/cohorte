// Runtime pinning (spec 16, DESIGN 3.9). The verifier and the diagnostics are reached through `./pin.ts` by the
// parent; this entry keeps the one name the Wave-0 barrel froze.
import type { RuntimePin } from '@cohorte/runtime-contract';
import { type PinOptions, pinWithDiagnostics } from './pin.ts';

export type { PinDiagnostics, PinOptions, PinVerifier } from './pin.ts';

/** The identity of the runtime code as installed NOW. */
export async function pin(options: PinOptions): Promise<RuntimePin> {
  const { pin: value } = await pinWithDiagnostics(options);
  return value;
}
