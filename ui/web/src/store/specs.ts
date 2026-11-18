import { create } from 'zustand';
import type { MetricsResponse, SpecDetail } from '../../../shared/api';
import { api, errorMessage } from '../api/client';
import { onProjectChange, useApp } from './app';

export const useSpecs = create<{ spec: SpecDetail | null }>(() => ({ spec: null }));
export const useMetrics = create<{ metrics: MetricsResponse | { error: string } | null }>(() => ({ metrics: null }));
onProjectChange(() => { useSpecs.setState({ spec: null }); useMetrics.setState({ metrics: null }); });

export const openSpec = (id: string) => useApp.getState().guard(async () => {
  const sel = useApp.getState().sel;
  if (sel) useSpecs.setState({ spec: await api.spec(sel, id) });
});
export const closeSpec = () => useSpecs.setState({ spec: null });

export async function loadMetrics(): Promise<void> {
  const sel = useApp.getState().sel;
  if (!sel || useMetrics.getState().metrics) return;
  try { useMetrics.setState({ metrics: await api.metrics(sel) }); } catch (e) { useMetrics.setState({ metrics: { error: errorMessage(e) } }); }
}
