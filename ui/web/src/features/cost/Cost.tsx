import { useEffect } from 'react';
import { num, usd } from '../../lib/format';
import { loadMetrics, useMetrics } from '../../store/specs';
import { Cards, EmptyState, ErrorText, SectionTitle, Stat, Table } from '../../ui/primitives';

export function Cost() {
  const m = useMetrics((s) => s.metrics);
  useEffect(() => { void loadMetrics(); }, []);
  if (!m) return <EmptyState>Loading…</EmptyState>;
  if ('error' in m && typeof m.error === 'string') return <ErrorText>{m.error}</ErrorText>;
  const metrics = m as Exclude<typeof m, { error: string }>;
  const t = metrics.totals ?? {};
  return (
    <div>
      <Cards>
        <Stat value={usd(t.cost)} label="Total" /><Stat value={num(t.runs)} label="Runs" />
        <Stat value={num(t.sessions)} label="Sessions" /><Stat value={num(t.agents)} label="Subagents" />
      </Cards>
      <SectionTitle>By command (last 30 days)</SectionTitle>
      <Table head={['Command', 'Runs', 'Cost']}>
        {(metrics.commands ?? []).map((c) => (
          <tr key={c.command}><td className="mono">{c.command}</td><td>{num(c.runs)}</td><td>{usd(typeof c.cost === 'object' ? c.cost.total : c.cost)}</td></tr>
        ))}
      </Table>
    </div>
  );
}
