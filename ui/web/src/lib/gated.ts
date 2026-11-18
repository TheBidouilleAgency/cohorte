import { ApiError } from '../api/client';
import { gateAsk, gatePrompt } from './gate';

/** Runs `send`; when the project's gate answers `ask`, confirms with the human and runs it again with confirmed: true. */
export async function withGate<T>(send: (confirmed: boolean) => Promise<T>, ask: (message: string) => boolean = (m) => window.confirm(m)): Promise<T> {
  try { return await send(false); } catch (e) {
    const g = e instanceof ApiError ? gateAsk(e.body) : null;
    if (!g) throw e;
    if (!ask(gatePrompt(g))) throw new Error('cancelled');
    return send(true);
  }
}
