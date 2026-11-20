import type { ProjectDetail } from '../../../../shared/api';
import { LIVE, useJobs } from '../../store/jobs';
import { useApp } from '../../store/app';
import { openSpec } from '../../store/specs';
import { Cards, Muted, Pill, SectionTitle, Stat, Table, Button } from '../../ui/primitives';
import { STATUS_TONE } from '../specs/Specs';
import { RemoteCard } from '../founding/Remote';

export function Overview({ d }: { d: ProjectDetail }) {
  const setTab = useApp((s) => s.setTab);
  const watch = useJobs((s) => s.watch);
  const s = d.doctor.summary;
  const counts: Record<string, number> = {};
  for (const sp of d.specs) counts[sp.status || 'unknown'] = (counts[sp.status || 'unknown'] ?? 0) + 1;
  const devs = d.worktrees.filter((w) => w.dev && LIVE.includes(w.dev.status));
  const runs = (d.runs ?? []).filter((r) => r.status === 'running');
  const todo = d.doctor.checks.filter((c) => c.status === 'bad' || c.status === 'warn');
  const specCounts = Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ');
  return (
    <div>
      <RemoteCard compact />
      <Cards>
        <Stat value={s.bad ? `${s.bad} failing` : s.warn ? `${s.warn} to review` : 'Healthy'} label="pipeline health" tone={s.bad ? 'bad' : s.warn ? 'warn' : 'ok'} onClick={() => setTab('health')} />
        <Stat value={d.specs.length} label={`specs${specCounts ? ` · ${specCounts}` : ''}`} onClick={() => setTab('specs')} />
        <Stat value={d.worktrees.length} label={`worktree${d.worktrees.length === 1 ? '' : 's'} · ${devs.length} dev server${devs.length === 1 ? '' : 's'} up`} onClick={() => setTab('worktrees')} />
        <Stat value={runs.length ? `${runs.length} running` : 'Idle'} label="cohorte commands" onClick={() => setTab('run')} />
        {d.docker ? <Stat value="Docker" label={d.docker.file} onClick={() => setTab('docker')} /> : null}
      </Cards>
      <SectionTitle>Needs attention</SectionTitle>
      {todo.length ? (
        <Table>{todo.map((c, i) => (
          <tr key={i}><td><Pill tone={c.status === 'bad' ? 'bad' : 'warn'}>{c.status}</Pill></td><td>{c.label}</td>
            <td>{c.detail}{c.fix ? <div className="fix">{`fix: ${c.fix}`}</div> : null}</td></tr>
        ))}</Table>
      ) : <Muted>Nothing — every check passes.</Muted>}
      {devs.length ? (
        <>
          <SectionTitle>Running now</SectionTitle>
          <Table>{devs.map((w) => (
            <tr key={w.path}><td className="mono">{w.branch || w.path}</td>
              <td><Pill tone={w.dev?.status === 'ready' ? 'ok' : ''}>{`dev · ${w.dev?.status}`}</Pill></td>
              <td><Button onClick={() => { if (w.dev) watch(w.dev); setTab('worktrees'); }}>Logs</Button></td></tr>
          ))}</Table>
        </>
      ) : null}
      {d.specs.length ? (
        <>
          <SectionTitle>Latest specs</SectionTitle>
          <Table>{d.specs.slice(0, 5).map((sp) => (
            <tr key={sp.id} className="click" tabIndex={0} onClick={() => { setTab('specs'); void openSpec(sp.id); }}
              onKeyDown={(e) => { if (e.key === 'Enter') { setTab('specs'); void openSpec(sp.id); } }}>
              <td className="mono">{sp.id}</td><td>{sp.title}</td><td><Pill tone={STATUS_TONE[sp.status] ?? ''}>{sp.status}</Pill></td>
            </tr>
          ))}</Table>
        </>
      ) : null}
    </div>
  );
}
