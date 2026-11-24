import { useEffect, useState } from 'react';
import type { DecisionRecord, FeatureDetail, FeaturePhase, FeatureView, ProjectDetail } from '../../../../shared/api';
import { ago, usd } from '../../lib/format';
import { usePoll } from '../../lib/usePoll';
import { useApp } from '../../store/app';
import { isLive, useLive } from '../../store/live';
import {
  checkpoint, contest, loadFeature, loadFeatures, merge, openChat, openFeature, pollChat, replyLead, useFlow,
} from '../../store/flow';
import { Button, Card, EmptyState, Muted, Pill, SectionTitle, Table, type PillTone } from '../../ui/primitives';
import { ChatView, PlanCard } from '../flow/Chat';

const PHASE: Record<FeaturePhase, [string, PillTone]> = {
  provisioning: ['creating the worktree', 'info'], framing: ['framing with the lead', 'info'], cp1: ['CP1 · plan to validate', 'warn'],
  freezing: ['freezing the spec', 'info'], autopilot: ['autopilot', 'info'], cp2: ['CP2 · course check', 'warn'], cp3: ['CP3 · ready to ship', 'warn'],
  shipping: ['opening the PR', 'info'], pr: ['PR open', 'info'], merging: ['merging', 'info'], closing: ['closing (journal, acceptance note)', 'info'],
  acceptance: ['waiting for acceptance', 'warn'], done: ['done', 'ok'], abandoned: ['abandoned', 'idle'], failed: ['failed', 'bad'],
};
export const phaseLabel = (p: FeaturePhase): string => PHASE[p]?.[0] ?? p;

/** The milestones of a feature, from the ticket to acceptance, with where it stands. */
function Timeline({ f }: { f: FeatureDetail }) {
  const order: FeaturePhase[] = ['framing', 'cp1', 'autopilot', 'cp3', 'pr', 'acceptance', 'done'];
  const at = (p: FeaturePhase): number => {
    const m: Partial<Record<FeaturePhase, number>> = { provisioning: 0, framing: 0, cp1: 1, freezing: 1, autopilot: 2, cp2: 2, cp3: 3, shipping: 3, pr: 4, merging: 4, closing: 4, acceptance: 5, done: 6 };
    return m[p] ?? -1;
  };
  const cur = at(f.phase);
  const labels = ['Framing', 'CP1 Plan', 'Autopilot', 'CP3 Sign-off', 'PR', 'CP4 Acceptance', 'Done'];
  return (
    <ol className="stepper timeline" aria-label="Feature milestones">
      {order.map((p, i) => {
        const state = f.phase === 'abandoned' || f.phase === 'failed' ? (i < cur ? 'done' : 'todo') : i < cur ? 'done' : i === cur ? (f.checkpoint ? 'blocked' : 'current') : 'todo';
        return <li key={p} className={`step step-${state === 'blocked' ? 'current attn' : state}`}><span className="step-mark">{state === 'done' ? '✓' : i === cur ? '●' : '○'}</span>{labels[i]}</li>;
      })}
    </ol>
  );
}

function Decisions({ f }: { f: FeatureDetail }) {
  const [open, setOpen] = useState<string | null>(null);
  const [note, setNote] = useState('');
  if (!f.decisions.length) return null;
  const row = (d: DecisionRecord) => (
    <tr key={d.id}>
      <td><Pill tone={d.by === 'human' ? '' : d.by === 'remote' ? 'warn' : 'info'}>{d.by === 'decider' ? 'decider' : d.by === 'remote' ? 'from elsewhere' : 'you'}</Pill></td>
      <td>{d.question}{d.header ? <span className="muted">{` · ${d.header}`}</span> : null}</td>
      <td><strong>{d.chosen}</strong>{d.source && d.source.kind !== 'none' ? <div className="muted">{`${d.source.kind}${d.source.ref ? ` · ${d.source.ref}` : ''}${d.source.quote ? ` — “${d.source.quote}”` : ''}`}</div> : null}</td>
      <td>
        {d.contested ? <Pill tone="bad">contested</Pill> : d.confirmed ? <Pill tone="ok">confirmed</Pill> : d.by === 'decider' ? (
          open === d.id ? (
            <div className="contest">
              <textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="What you would have chosen, and why" aria-label="Your note" />
              <div className="actions"><Button onClick={() => { void contest(d.id, note.trim()); setOpen(null); setNote(''); }}>Contest</Button><Button onClick={() => setOpen(null)}>Cancel</Button></div>
            </div>
          ) : <Button onClick={() => setOpen(d.id)}>I would not have done that</Button>
        ) : null}
      </td>
    </tr>
  );
  return (
    <>
      <SectionTitle>Decisions taken during the run</SectionTitle>
      <Muted>What the decider settled on your behalf (and why), and what you answered. Contesting teaches it; add a correction at CP3 to change the code.</Muted>
      <Table head={['By', 'Question', 'Answer', '']}>{f.decisions.map(row)}</Table>
    </>
  );
}

function CheckpointCard({ f }: { f: FeatureDetail }) {
  const [text, setText] = useState('');
  const cp = f.checkpoint;
  if (!cp) return null;
  const act = (action: string, needsText = false) => { if (needsText && !text.trim()) return; void checkpoint(action, text.trim() || undefined); setText(''); };
  const abandon = () => { if (window.confirm('Abandon this feature? The worktree is kept; the ticket goes back to the backlog.')) void checkpoint('abandon'); };
  return (
    <Card tone="warn" className="checkpoint">
      <div className="plan-head"><Pill tone="warn">{cp.kind === 'cp1' ? 'CP1 · Plan' : cp.kind === 'cp2' ? 'CP2 · Course check' : 'CP3 · Ship sign-off'}</Pill><span>{cp.reason}</span><span className="muted push-right">{ago(cp.openedAt)}</span></div>
      {cp.kind === 'cp1' ? (
        <>
          {f.plan ? <PlanCard plan={f.plan} /> : <Muted>The lead has not posted a plan yet.</Muted>}
          <textarea rows={2} value={text} onChange={(e) => setText(e.target.value)} placeholder="Optional: a last instruction with the approval, or what to change instead" aria-label="Your note" />
          <div className="actions"><Button variant="primary" onClick={() => act('approve')}>Approve the plan — build it</Button>
            <Button disabled={!text.trim()} onClick={() => act('reply', true)}>Ask the lead to change it</Button><Button onClick={abandon}>Abandon</Button></div>
          <Muted>After approval the lead freezes the spec and the autopilot builds, reviews, fixes and verifies. You are only asked again if something needs you.</Muted>
        </>
      ) : null}
      {cp.kind === 'cp2' ? (
        <>
          <textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} placeholder="What should change (for Correct or Re-frame)" aria-label="Your instruction" />
          <div className="actions"><Button variant="primary" onClick={() => act('continue')}>Continue</Button>
            <Button disabled={!text.trim()} onClick={() => act('correct', true)}>Correct the code</Button>
            <Button disabled={!text.trim()} onClick={() => act('reframe', true)}>Re-frame with the lead</Button><Button onClick={abandon}>Abandon</Button></div>
        </>
      ) : null}
      {cp.kind === 'cp3' ? <ShipSignoff f={f} text={text} setText={setText} act={act} abandon={abandon} /> : null}
    </Card>
  );
}

function ShipSignoff({ f, text, setText, act, abandon }: { f: FeatureDetail; text: string; setText: (s: string) => void; act: (a: string, t?: boolean) => void; abandon: () => void }) {
  const open = f.dod.filter((x) => !x.done);
  const byDecider = f.decisions.filter((d) => d.by !== 'human' && !d.contested);
  return (
    <>
      <div className="rc-row">
        {f.pipeline?.verdict ? <Pill tone={f.pipeline.verdict.verdict === 'SHIP' ? 'ok' : 'bad'}>{`review ${f.pipeline.verdict.verdict}`}</Pill> : null}
        {f.review ? <Pill>{`${f.review.findings.length} finding${f.review.findings.length === 1 ? '' : 's'} · ${f.review.deferred.length} deferred`}</Pill> : null}
        {f.diff ? <Pill>{`${f.diff.files} files · +${f.diff.insertions} −${f.diff.deletions}`}</Pill> : null}
        <Pill>{`${f.rounds} fix round${f.rounds === 1 ? '' : 's'}`}</Pill><Pill>{usd(f.costUsd)}</Pill>
      </div>
      {f.dod.length ? <><div className="label">{`Definition of done — ${f.dod.length - open.length}/${f.dod.length}`}</div>
        <ul className="rc-list dod">{f.dod.map((x, i) => <li key={i} className={x.done ? 'add' : 'muted'}>{`${x.done ? '✓' : '○'} ${x.text}`}</li>)}</ul></> : null}
      {f.assumptions.length ? <><div className="label">Assumed by the implementers — veto any</div><ul className="rc-list">{f.assumptions.map((a, i) => <li key={i}>{a}</li>)}</ul></> : null}
      {byDecider.length ? <Muted>{`${byDecider.length} decision${byDecider.length === 1 ? '' : 's'} taken on your behalf — by the decider, or answered from another process ("from elsewhere") — listed below. Shipping confirms them.`}</Muted> : null}
      <textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} placeholder="What to correct before shipping" aria-label="Correction" />
      <div className="actions"><Button variant="primary" onClick={() => act('approve')}>Ship it — open the PR</Button>
        <Button disabled={!text.trim()} onClick={() => act('correct', true)}>Correct first</Button><Button onClick={abandon}>Abandon</Button></div>
    </>
  );
}

function PRCard({ f }: { f: FeatureDetail }) {
  if (!f.pr || !['pr', 'merging'].includes(f.phase)) return null;
  return (
    <Card className="checkpoint">
      <div className="plan-head"><Pill tone="info">{`PR #${f.pr.number}`}</Pill>
        <a className="open-link" href={f.pr.url} target="_blank" rel="noreferrer noopener">{f.pr.url}</a>
        {f.pr.checks ? <Pill tone={f.pr.checks === 'success' ? 'ok' : f.pr.checks === 'failure' ? 'bad' : 'info'}>{`checks ${f.pr.checks}`}</Pill> : null}</div>
      <Muted>Merge it on the host when you are ready — cohorte notices — or let cohorte merge it now.</Muted>
      <div className="actions"><Button disabled={f.phase === 'merging' || f.pr.checks === 'failure'} onClick={() => { if (window.confirm(`Merge PR #${f.pr?.number}?`)) void merge(); }}>Merge it</Button></div>
    </Card>
  );
}

function Detail({ f }: { f: FeatureDetail }) {
  const chat = useFlow((s) => s.chat);
  const live = isLive(useLive((s) => s.status));
  const tab = useApp((s) => s.tab);
  const conversing = ['framing', 'cp1', 'cp2', 'freezing', 'provisioning'].includes(f.phase);
  const followed = conversing ? f.leadRunId : f.currentRunId || f.leadRunId;
  useEffect(() => { void openChat(followed); }, [followed]);
  usePoll(() => pollChat(), 1200, tab === 'features' && chat?.status === 'running' && !live, `${chat?.id}:${chat?.status}`);
  usePoll(async () => { await loadFeature(); return true; }, 5000, tab === 'features' && !live, f.id);
  const isLead = chat?.meta?.role === 'lead';
  const [phase, tone] = PHASE[f.phase] ?? [f.phase, ''];
  return (
    <div>
      <div className="spec-head">
        <Button onClick={() => void openFeature(null)}>← All features</Button>
        <h2>{f.title}</h2><Pill tone={tone}>{phase}</Pill>
        <span className="muted mono">{f.branch ?? ''}</span><span className="muted">{usd(f.costUsd)}</span>
      </div>
      <Timeline f={f} />
      {f.integrity ? <Card tone="bad" className="gate"><div className="error pre-wrap">{`${f.integrity.reason}. Nothing automatic runs on it until you act: answer its checkpoint, or clear it with cohorte take-over ${f.id}.`}</div></Card> : null}
      {f.driver?.by === 'cli' ? <Card className="gate"><Muted>{`Driven from a terminal (pid ${f.driver.pid}) — its questions show up here and in the inbox; to follow it there: cohorte autopilot ${f.id} --follow`}</Muted></Card> : null}
      {f.error ? <Card tone="bad" className="gate"><div className="error pre-wrap">{f.error}</div></Card> : null}
      {f.warning ? <Card tone="warn" className="gate"><div className="pre-wrap">{f.warning}</div></Card> : null}
      <CheckpointCard f={f} />
      <PRCard f={f} />
      {f.stages.length ? (
        <>
          <SectionTitle>Stages</SectionTitle>
          <Table head={['Stage', 'Model', 'Status', 'Cost', 'When', '']}>
            {f.stages.map((s) => (
              <tr key={s.runId} className={`click${chat?.id === s.runId ? ' current' : ''}`} onClick={() => void openChat(s.runId)} tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter') void openChat(s.runId); }}>
                <td className="mono">{s.stage}</td><td className="mono">{s.model}</td>
                <td><Pill tone={s.status === 'done' ? 'ok' : s.status === 'running' ? 'info' : 'bad'}>{s.status}</Pill></td>
                <td>{s.costUsd != null ? usd(s.costUsd) : ''}</td><td className="muted">{ago(s.startedAt)}</td><td className="muted">{s.note ?? ''}</td>
              </tr>
            ))}
          </Table>
        </>
      ) : null}
      <Decisions f={f} />
      <div className="toolbar between">
        <SectionTitle>{isLead ? 'Conversation with the lead' : chat ? `Run · ${chat.command}` : 'Conversation'}</SectionTitle>
        {f.leadRunId && !isLead ? <Button onClick={() => void openChat(f.leadRunId)}>Open the lead conversation</Button> : null}
      </div>
      {chat ? (
        <ChatView chat={chat} agent={isLead ? 'Lead' : 'Agent'} quiet={false}
          onReply={isLead && ['framing', 'cp1', 'cp2'].includes(f.phase) ? (t) => void replyLead(t) : undefined}
          replyHint="Answer the lead, or tell it what you want…" empty={f.phase === 'provisioning' ? 'Creating the worktree…' : undefined} />
      ) : <Muted>No conversation yet.</Muted>}
    </div>
  );
}

function List({ features }: { features: FeatureView[] }) {
  if (!features.length) return <EmptyState>No feature in progress. Take a ticket from the backlog (Tickets tab) to start one.</EmptyState>;
  return (
    <Table head={['Feature', 'Where', 'Rounds', 'Cost', 'Updated']}>
      {features.map((f) => {
        const [label, tone] = PHASE[f.phase] ?? [f.phase, ''];
        return (
          <tr key={f.id} className="click" tabIndex={0} onClick={() => void openFeature(f.id)} onKeyDown={(e) => { if (e.key === 'Enter') void openFeature(f.id); }}>
            <td><div>{f.title}</div><div className="muted mono">{f.id}</div></td>
            <td><Pill tone={tone}>{label}</Pill>{f.checkpoint ? <div className="muted">{f.checkpoint.reason}</div> : null}</td>
            <td>{f.rounds}</td><td>{usd(f.costUsd)}</td><td className="muted">{ago(f.updatedAt)}</td>
          </tr>
        );
      })}
    </Table>
  );
}

export function Features({ d }: { d: ProjectDetail }) {
  const features = useFlow((s) => s.features);
  const featureId = useFlow((s) => s.featureId);
  const feature = useFlow((s) => s.feature);
  useEffect(() => { void loadFeatures(); if (featureId) void loadFeature(); }, [d.id]);
  if (featureId) return feature ? <Detail f={feature} /> : <EmptyState>Loading the feature…</EmptyState>;
  return features ? <List features={features} /> : <EmptyState>Loading features…</EmptyState>;
}
