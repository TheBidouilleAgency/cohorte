import type { ReactNode } from 'react';
import { list, rec, surfaces, text, verifyChecks, type Rec } from '../../lib/reports';
import { Card, Muted, Pill, Pre, SectionTitle, type PillTone } from '../../ui/primitives';

const VERDICT_TONE: Record<string, PillTone> = { READY: 'ok', SHIP: 'ok', PASS: 'ok', REVISE: 'warn', SKIPPED: '', BLOCK: 'bad', FAIL: 'bad' };
const vt = (v: string): PillTone => VERDICT_TONE[v] ?? 'warn';

function Head({ title, r }: { title: string; r: Rec }) {
  return <div className="rc-head"><strong>{title}</strong>{text(r.ts) ? <span className="muted mono">{text(r.ts)}</span> : null}</div>;
}

function Readiness({ r }: { r: Rec }) {
  const gaps = list(r.gaps).map(text).filter(Boolean);
  return (
    <Card><Head title="Readiness" r={r} /><Pill tone={vt(text(r.verdict))}>{text(r.verdict) || '–'}</Pill>
      {surfaces(r).length ? <div className="rc-row">{surfaces(r).map((s) => <Pill key={s.name}>{s.name}</Pill>)}</div> : null}
      {gaps.length ? <ul className="rc-list">{gaps.map((g, i) => <li key={i}>{g}</li>)}</ul> : <Muted>No gaps.</Muted>}
    </Card>
  );
}
function Build({ r }: { r: Rec }) {
  const dead = list(r.dead).map(text).filter(Boolean);
  return (
    <Card><Head title="Build" r={r} />
      <div className="rc-row">{surfaces(r).map((s) => <Pill key={s.name} tone={s.state === 'ok' ? 'ok' : 'bad'}>{`${s.name}: ${s.state || '?'}`}</Pill>)}</div>
      {dead.length ? <Muted>Agents that died: {dead.join(', ')}</Muted> : null}
    </Card>
  );
}
function Review({ r }: { r: Rec }) {
  const n = (k: string): string => (typeof r[k] === 'number' ? String(r[k]) : '–');
  return (
    <Card><Head title="Review verdict" r={r} /><Pill tone={vt(text(r.verdict))}>{text(r.verdict) || '–'}</Pill>
      <div className="rc-row muted">{`${n('blocking')} blocking · ${n('findings')} findings · ${n('security')} security · ${n('deferred')} deferred`}</div>
      {text(r.aborted) ? <Muted>Aborted: {text(r.aborted)}</Muted> : null}
      {list(r.unreviewed).length ? <Muted>Unreviewed surfaces: {list(r.unreviewed).map(text).join(', ')}</Muted> : null}
    </Card>
  );
}
function Verify({ r }: { r: Rec }) {
  const checks = verifyChecks(r);
  return (
    <Card><Head title="Verify" r={r} /><Pill tone={vt(text(r.verdict))}>{text(r.verdict) || '–'}</Pill>
      {text(r.reason) ? <Muted>{text(r.reason)}</Muted> : null}
      {checks.length ? <ul className="rc-list">{checks.map((c, i) => (
        <li key={i}><Pill tone={c.status === 'PASS' ? 'ok' : c.status === 'FAIL' ? 'bad' : ''}>{c.status || '–'}</Pill> <span className="mono">{c.name}</span>{c.note ? <span className="muted"> — {c.note}</span> : null}</li>
      ))}</ul> : null}
    </Card>
  );
}
function Loop({ r }: { r: Rec }) {
  return <Card><Head title="Loop" r={r} /><Pill tone={text(r.outcome) ? 'bad' : 'warn'}>{text(r.outcome) || 'resumable'}</Pill>{text(r.reason) ? <Muted>{text(r.reason)}</Muted> : null}</Card>;
}

const CARDS: [string, (r: Rec) => ReactNode][] = [
  ['readiness', (r) => <Readiness r={r} />], ['build', (r) => <Build r={r} />], ['verdict', (r) => <Review r={r} />],
  ['verify', (r) => <Verify r={r} />], ['loop', (r) => <Loop r={r} />],
];

/** The machine reports as compact cards; the raw JSON stays one disclosure away. */
export function ReportCards({ reports }: { reports: Record<string, unknown> }) {
  const present = CARDS.map(([k, f]) => [k, rec(reports[k]), f] as const).filter((x): x is readonly [string, Rec, (r: Rec) => ReactNode] => !!x[1]);
  if (!present.length) return null;
  return (
    <div>
      <SectionTitle>Reports</SectionTitle>
      <div className="cards rc">{present.map(([k, r, f]) => <div key={k}>{f(r)}</div>)}</div>
      <details className="disclose"><summary>Raw JSON</summary>
        {present.map(([k, r]) => <div key={k}><SectionTitle>{k}</SectionTitle><Pre>{JSON.stringify(r, null, 2)}</Pre></div>)}
      </details>
    </div>
  );
}
