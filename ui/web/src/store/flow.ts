import { create } from 'zustand';
import type {
  FeatureDetail, FeatureView, InboxItem, LearningResponse, PendingItem, ProjectSettings, RunEvent, RunView, SettingsResponse, TicketsResponse,
} from '../../../shared/api';
import { ApiError, api } from '../api/client';
import { untrustedPrompt } from '../lib/gate';
import { onProjectChange, useApp } from './app';

/** A conversation (PO, lead) or a stage run followed in the company flow pages — separate from the Run tab's run. */
export type Chat = Omit<RunView, 'events' | 'cursor' | 'pending'> & { events: RunEvent[]; cursor: number; pending: PendingItem[] };
const asChat = (r: RunView): Chat => ({ ...r, events: r.events ?? [], cursor: r.cursor ?? 0, pending: r.pending ?? [] });

interface FlowState {
  tickets: TicketsResponse | null; features: FeatureView[] | null;
  ticketId: string | null; featureId: string | null; feature: FeatureDetail | null;
  chat: Chat | null; inbox: InboxItem[]; settings: SettingsResponse | null; learning: LearningResponse | null;
}
export const useFlow = create<FlowState>(() => ({
  tickets: null, features: null, ticketId: null, featureId: null, feature: null, chat: null, inbox: [], settings: null, learning: null,
}));
onProjectChange(() => useFlow.setState({ tickets: null, features: null, ticketId: null, featureId: null, feature: null, chat: null, settings: null, learning: null }));

const sel = (): string | null => useApp.getState().sel;
const guard = (fn: () => Promise<void>) => useApp.getState().guard(fn);

export async function loadTickets(): Promise<void> {
  const id = sel(); if (!id) return;
  try { const t = await api.tickets(id); if (sel() === id) useFlow.setState({ tickets: t }); } catch (e) { useApp.getState().setError(e instanceof Error ? e.message : String(e)); }
}
export async function loadFeatures(): Promise<void> {
  const id = sel(); if (!id) return;
  try { const r = await api.features(id); if (sel() === id) useFlow.setState({ features: r.features }); } catch { /* the list is a convenience */ }
}
export async function loadFeature(): Promise<void> {
  const id = sel(); const f = useFlow.getState().featureId;
  if (!id || !f) return;
  try { const d = await api.feature(id, f); if (sel() === id && useFlow.getState().featureId === f) useFlow.setState({ feature: d }); } catch (e) { useApp.getState().setError(e instanceof Error ? e.message : String(e)); }
}
export async function loadInbox(): Promise<void> { try { useFlow.setState({ inbox: (await api.inbox()).items }); } catch { /* best effort */ } }
export async function loadSettings(): Promise<void> {
  const id = sel(); if (!id) return;
  try { const [s, l] = await Promise.all([api.settings(id), api.learning(id)]); if (sel() === id) useFlow.setState({ settings: s, learning: l }); } catch (e) { useApp.getState().setError(e instanceof Error ? e.message : String(e)); }
}

export const selectTicket = (t: string | null): void => useFlow.setState({ ticketId: t });
export async function openFeature(f: string | null): Promise<void> {
  useFlow.setState({ featureId: f, feature: null });
  if (f) await loadFeature();
}

// ---- the followed conversation ----
export async function openChat(runId: string | null): Promise<void> {
  const id = sel();
  if (!id || !runId) { useFlow.setState({ chat: null }); return; }
  try { useFlow.setState({ chat: asChat(await api.run(id, runId, 0)) }); } catch { useFlow.setState({ chat: null }); }
}
export async function pollChat(): Promise<boolean> {
  const id = sel(); const cur = useFlow.getState().chat;
  if (!id || !cur) return false;
  const v = await api.run(id, cur.id, cur.cursor);
  if (useFlow.getState().chat?.id !== cur.id) return false;
  useFlow.setState({ chat: { ...asChat(v), events: cur.events.concat(v.events ?? []).slice(-2000), cursor: v.cursor ?? cur.cursor } });
  return v.status === 'running';
}
export const replyChat = (text: string) => guard(async () => {
  const id = sel(); const c = useFlow.getState().chat;
  if (!id || !c) return;
  await api.reply(id, c.id, text);
  await pollChat();
});
export async function respondChat(requestId: string, behavior: 'allow' | 'deny', answers?: Record<string, string[]>): Promise<void> {
  const id = sel(); const c = useFlow.getState().chat;
  if (!id || !c) return;
  try { await api.respond(id, c.id, { requestId, behavior, answers }); await pollChat(); } catch (e) { useApp.getState().setError(e instanceof Error ? e.message : String(e)); }
}

// ---- actions ----
const after = async (): Promise<void> => { await Promise.all([loadTickets(), loadFeatures(), loadFeature(), loadInbox()]); };

export const startPO = (text: string, requester: string, parent?: string) => guard(async () => {
  const id = sel(); if (!id) return;
  const r = await api.startPO(id, { text, requester, parent });
  useFlow.setState({ chat: asChat(r.run) });
  await loadTickets();
});
export const decideTicket = (t: string, action: 'validate' | 'reject') => guard(async () => { const id = sel(); if (id) { await api.decideTicket(id, t, action); await after(); } });
export const createTicket = (body: { title: string; type: string; need: string; criteria: string[] }) => guard(async () => { const id = sel(); if (id) { await api.createTicket(id, body); await loadTickets(); } });
export const acceptance = (t: string, action: 'accept' | 'not-quite', text?: string) => guard(async () => {
  const id = sel(); if (!id) return;
  const r = await api.acceptance(id, t, { action, text });
  if (r.run) useFlow.setState({ chat: asChat(r.run) });
  await after();
});
/** Takes a ticket: the worktree is created (the project's gate and Docker asked first), then the lead starts framing. */
export const takeTicket = (t: string) => guard(async () => {
  const id = sel(); if (!id) return;
  let body: { confirmed?: boolean; skipDockerCheck?: boolean } = {};
  for (let i = 0; i < 3; i++) {
    try { await api.takeTicket(id, t, body); break; } catch (e) {
      if (!(e instanceof ApiError)) throw e;
      if (e.body.needsConfirmation) {
        if (!window.confirm(`The project's gate asks before running:\n\n${e.body.command}\n\n${e.body.reason ?? ''}\n\nRun it?`)) throw new Error('cancelled');
        body = { ...body, confirmed: true };
      } else if (e.body.dockerPreflight) {
        if (!window.confirm(`${e.message}\n\nCreate the worktree anyway?`)) throw new Error('cancelled');
        body = { ...body, skipDockerCheck: true };
      } else if (e.body.untrusted) {
        if (!window.confirm(untrustedPrompt(e.message, e.body.fix))) throw new Error('cancelled');
        body = { ...body, confirmed: true };
      } else throw e;
    }
  }
  await after();
  useFlow.setState({ featureId: t });
  useApp.getState().setTab('features');
  await loadFeature();
});
/** A spec written in a plain Claude Code session joins the flow: its feature record, at the phase its files say. */
export const adoptSpec = (spec: string) => guard(async () => {
  const id = sel(); if (!id) return;
  await api.adopt(id, spec);
  await after();
  useFlow.setState({ featureId: spec });
  useApp.getState().setTab('features');
  await loadFeature();
});
export const checkpoint = (action: string, text?: string) => guard(async () => {
  const id = sel(); const f = useFlow.getState().featureId;
  if (!id || !f) return;
  await api.checkpoint(id, f, { action, text });
  await after();
});
export const replyLead = (text: string) => guard(async () => {
  const id = sel(); const f = useFlow.getState().featureId;
  if (!id || !f) return;
  await api.replyLead(id, f, text);
  await Promise.all([loadFeature(), pollChat()]);
});
export const contest = (decision: string, note: string) => guard(async () => {
  const id = sel(); const f = useFlow.getState().featureId;
  if (id && f) { await api.contest(id, f, decision, note); await loadFeature(); }
});
export const merge = () => guard(async () => {
  const id = sel(); const f = useFlow.getState().featureId;
  if (id && f) { await api.merge(id, f); await after(); }
});
export const saveSettings = (patch: Partial<ProjectSettings>) => guard(async () => {
  const id = sel(); if (!id) return;
  useFlow.setState({ settings: await api.saveSettings(id, patch) });
});
/** `onMigrated` gets how many local tickets were moved into the vault. */
export const connectObsidian = (vault: string, board: string, onMigrated?: (n: number) => void) => guard(async () => {
  const id = sel(); if (!id) return;
  const r = await api.connectObsidian(id, { vault, board: board || undefined });
  onMigrated?.(r.migrated);
  await Promise.all([loadSettings(), loadTickets()]);
});
export const startProductMap = () => guard(async () => {
  const id = sel(); if (!id) return;
  const r = await api.productMap(id);
  useFlow.setState({ chat: asChat(r.run) });
});

/** A change notice from the server's flow: re-read what the open page shows. */
export function refreshFlow(): void {
  void loadInbox();
  const sum = useApp.getState().projects.find((p) => p.id === useApp.getState().sel);
  if (sum?.founding) { void import('./founding').then((m) => m.loadFounding()); return; }
  const tab = useApp.getState().tab;
  if (tab === 'tickets') void loadTickets();
  if (tab === 'features') { void loadFeatures(); void loadFeature(); }
  if (tab === 'settings') void loadSettings();
}
