import { useEffect, useState, type FormEvent } from 'react';
import type { AdoptableSpec, ProjectDetail, Ticket, TicketStatus } from '../../../../shared/api';
import { ago } from '../../lib/format';
import { usePoll } from '../../lib/usePoll';
import { isLive, useLive } from '../../store/live';
import {
  acceptance, adoptSpec, createTicket, decideTicket, loadTickets, openChat, openFeature, pollChat, replyChat, selectTicket, startPO, takeTicket, useFlow,
} from '../../store/flow';
import { useApp } from '../../store/app';
import { Button, Card, EmptyState, Muted, Pill, SectionTitle, type PillTone } from '../../ui/primitives';
import { ChatView } from '../flow/Chat';

const COLUMNS: { key: string; label: string; statuses: TicketStatus[]; hint: string }[] = [
  { key: 'validate', label: 'To validate', statuses: ['discussion', 'validate'], hint: 'proposed by the PO — the requester validates (CP0)' },
  { key: 'backlog', label: 'Backlog', statuses: ['backlog'], hint: 'validated — a developer takes one' },
  { key: 'framing', label: 'Framing', statuses: ['framing'], hint: 'a developer and the lead plan it (CP1)' },
  { key: 'building', label: 'In progress', statuses: ['building', 'checkpoint'], hint: 'the autopilot builds; the developer signs off (CP3)' },
  { key: 'pr', label: 'PR open', statuses: ['pr'], hint: 'waiting for the merge' },
  { key: 'acceptance', label: 'Acceptance', statuses: ['acceptance'], hint: 'delivered — the requester checks it (CP4)' },
  { key: 'done', label: 'Done', statuses: ['done'], hint: '' },
];
const TONE: Partial<Record<TicketStatus, PillTone>> = { validate: 'warn', acceptance: 'warn', checkpoint: 'warn', building: 'info', pr: 'info', done: 'ok', rejected: 'bad' };

function TicketDetail({ t }: { t: Ticket }) {
  const [note, setNote] = useState('');
  const feature = (useFlow((s) => s.features) ?? []).find((f) => f.id === t.id);
  const conv = t.conversation;
  const goFeature = () => { useApp.getState().setTab('features'); void openFeature(t.id); };
  return (
    <Card className="ticket-detail">
      <div className="plan-head">
        <Pill tone={TONE[t.status] ?? ''}>{t.status}</Pill><h3 className="ticket-title">{t.title}</h3>
        <span className="muted mono">{t.id}</span>
        <Button className="push-right" onClick={() => selectTicket(null)} aria-label="Close">Close</Button>
      </div>
      <div className="rc-row"><Pill>{t.type}</Pill><Pill>{`priority ${t.priority}`}</Pill><Pill>{`size ${t.size}`}</Pill>
        {t.requester ? <Pill>{`asked by ${t.requester}`}</Pill> : null}{t.parent ? <Pill>{`follows ${t.parent}`}</Pill> : null}{t.pr ? <Pill tone="info">{`PR ${t.pr}`}</Pill> : null}</div>
      {t.need ? <><div className="label">Need</div><p className="pre-wrap">{t.need}</p></> : null}
      {t.value ? <><div className="label">Value</div><p className="pre-wrap">{t.value}</p></> : null}
      {t.criteria.length ? <><div className="label">Acceptance criteria</div><ul className="rc-list">{t.criteria.map((c, i) => <li key={i}><span className="mono">{`C${i + 1}`}</span> {c}</li>)}</ul></> : null}
      {t.outOfScope.length ? <><div className="label">Out of scope</div><ul className="rc-list">{t.outOfScope.map((c, i) => <li key={i}>{c}</li>)}</ul></> : null}
      {t.acceptance ? (
        <>
          <div className="label">Acceptance note</div>
          <p className="pre-wrap">{t.acceptance.summary}</p>
          {t.acceptance.changes.length ? <><div className="label">What changed</div><ul className="rc-list">{t.acceptance.changes.map((c, i) => <li key={i}>{c}</li>)}</ul></> : null}
          {t.acceptance.howToTest.length ? <><div className="label">How to check it</div><ol className="rc-list">{t.acceptance.howToTest.map((c, i) => <li key={i}>{c}</li>)}</ol></> : null}
          {t.acceptance.outOfScope.length ? <><div className="label">Not in this delivery</div><ul className="rc-list">{t.acceptance.outOfScope.map((c, i) => <li key={i}>{c}</li>)}</ul></> : null}
        </>
      ) : null}
      {t.feedback.length ? <><div className="label">Feedback</div><ul className="rc-list">{t.feedback.map((c, i) => <li key={i}>{c}</li>)}</ul></> : null}

      <div className="checkpoint-actions">
        {t.status === 'validate' || t.status === 'discussion' ? (
          <>
            <Muted>CP0 — is this ticket what was asked? Validating sends it to the backlog, where a developer picks it up.</Muted>
            <div className="actions"><Button variant="primary" onClick={() => void decideTicket(t.id, 'validate')}>Validate</Button>
              <Button onClick={() => { if (window.confirm('Reject this ticket?')) void decideTicket(t.id, 'reject'); }}>Reject</Button>
              {conv ? <Button onClick={() => void openChat(conv)}>Discuss it with the PO</Button> : null}</div>
          </>
        ) : null}
        {t.status === 'backlog' && !feature ? (
          <>
            <Muted>For a developer: taking it creates its worktree and starts framing it with the lead.</Muted>
            <div className="actions"><Button variant="primary" onClick={() => void takeTicket(t.id)}>Take it</Button></div>
          </>
        ) : null}
        {feature && !['acceptance', 'done'].includes(t.status) ? <div className="actions"><Button onClick={goFeature}>{`Open the feature · ${feature.phase}`}</Button></div> : null}
        {t.status === 'acceptance' ? (
          <>
            <Muted>CP4 — check the delivery against the note above. Is it what you asked for?</Muted>
            <textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder="What is not quite right (opens a follow-up with the PO)…" aria-label="Acceptance feedback" />
            <div className="actions"><Button variant="primary" onClick={() => void acceptance(t.id, 'accept', note.trim() || undefined)}>It is what I asked for</Button>
              <Button disabled={!note.trim()} onClick={() => { void acceptance(t.id, 'not-quite', note.trim()); setNote(''); }}>Not quite</Button></div>
          </>
        ) : null}
      </div>
    </Card>
  );
}

function Board({ tickets }: { tickets: Ticket[] }) {
  const sel = useFlow((s) => s.ticketId);
  return (
    <div className="board board-flow">
      {COLUMNS.map((c) => {
        const items = tickets.filter((t) => c.statuses.includes(t.status));
        return (
          <section key={c.key} className="col" aria-label={c.label} title={c.hint}>
            <div className="col-head"><span>{c.label}</span><span className="count">{items.length}</span></div>
            {items.map((t) => (
              <button key={t.id} type="button" className={`spec-card ticket-card${sel === t.id ? ' sel' : ''}`} onClick={() => selectTicket(t.id)}>
                <span className="ticket-card-title">{t.title}</span>
                <span className="spec-card-meta">
                  <Pill tone={t.type === 'bug' ? 'bad' : t.type === 'tech' ? 'idle' : ''}>{t.type}</Pill>
                  {t.priority === 'high' ? <Pill tone="warn">high</Pill> : null}
                  {t.status === 'checkpoint' ? <Pill tone="warn">to validate · dev</Pill> : null}
                </span>
              </button>
            ))}
          </section>
        );
      })}
    </div>
  );
}

function NewRequest() {
  const settings = useFlow((s) => s.settings);
  const [who, setWho] = useState(settings?.settings.requester ?? '');
  const [text, setText] = useState('');
  const submit = (e: FormEvent) => { e.preventDefault(); const t = text.trim(); if (t) { void startPO(t, who.trim()); setText(''); } };
  return (
    <form onSubmit={submit} className="new-request">
      <div className="row-form"><input value={who} onChange={(e) => setWho(e.target.value)} placeholder="Your name (optional)" aria-label="Your name" /></div>
      <textarea rows={4} value={text} onChange={(e) => setText(e.target.value)} aria-label="Your request"
        placeholder="Describe what you need, an idea, or a problem you hit — in your own words. The product owner will ask what it needs to know." />
      <Button type="submit" variant="primary" disabled={!text.trim()}>Talk to the product owner</Button>
    </form>
  );
}

/** Specs a plain Claude Code session wrote (/cohorte-spec, a branch) that the flow does not follow yet. */
function Adoptable({ specs }: { specs: AdoptableSpec[] }) {
  if (!specs.length) return null;
  return (
    <Card className="adoptable">
      <SectionTitle>Started in a Claude Code session</SectionTitle>
      <Muted>These specs have no feature here yet. Adopting one creates it at the step its files say — the autopilot or a checkpoint takes it from there.</Muted>
      <ul className="convo-list">
        {specs.map((s) => (
          <li key={s.id} className="act-row">
            <span className="act-label">{s.title}</span>
            <span className="muted mono">{`${s.id} · ${s.status ?? 'no status'}${s.worktree ? '' : ' · main checkout'}`}</span>
            {s.status && s.status !== 'draft' && s.worktree
              ? <Button onClick={() => void adoptSpec(s.id)}>Adopt</Button>
              : <Muted>{s.status && s.status !== 'draft' ? 'only in the main checkout — take its ticket to give it a worktree' : 'a draft — freeze it first'}</Muted>}
          </li>
        ))}
      </ul>
    </Card>
  );
}

function NewTechTicket({ onDone }: { onDone: () => void }) {
  const [title, setTitle] = useState(''); const [type, setType] = useState('tech'); const [need, setNeed] = useState(''); const [crit, setCrit] = useState('');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    void createTicket({ title: title.trim(), type, need: need.trim(), criteria: crit.split('\n').map((x) => x.trim()).filter(Boolean) }).then(onDone);
  };
  return (
    <form onSubmit={submit} className="card new-ticket">
      <Muted>A ticket with nothing for the business to discuss (tech debt, an upgrade, a bug you found) goes straight to the backlog.</Muted>
      <div className="row-form"><input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title" aria-label="Title" />
        <select value={type} onChange={(e) => setType(e.target.value)} aria-label="Type"><option value="tech">tech</option><option value="bug">bug</option><option value="feature">feature</option></select></div>
      <textarea rows={3} value={need} onChange={(e) => setNeed(e.target.value)} placeholder="Why, and what done looks like" aria-label="Description" />
      <textarea rows={3} value={crit} onChange={(e) => setCrit(e.target.value)} placeholder="Acceptance criteria, one per line (optional)" aria-label="Acceptance criteria" />
      <div className="actions"><Button type="submit" variant="primary" disabled={!title.trim()}>Add to the backlog</Button><Button onClick={onDone}>Cancel</Button></div>
    </form>
  );
}

function Conversations({ tickets }: { tickets: Ticket[] }) {
  const data = useFlow((s) => s.tickets);
  const chat = useFlow((s) => s.chat);
  const live = isLive(useLive((s) => s.status));
  const tab = useApp((s) => s.tab);
  usePoll(() => pollChat(), 1200, tab === 'tickets' && chat?.status === 'running' && !live, `${chat?.id}:${chat?.status}`);
  const convs = data?.conversations ?? [];
  const current = chat && chat.meta?.role === 'po' ? chat : null;
  const refs = current ? convs.find((c) => c.runId === current.id)?.tickets ?? {} : {};
  return (
    <div className="convo-grid">
      <div>
        <SectionTitle>New request</SectionTitle>
        <NewRequest />
        {convs.length ? <SectionTitle>Conversations</SectionTitle> : null}
        <ul className="convo-list">
          {convs.map((c) => (
            <li key={c.runId}>
              <button type="button" className={`act-row${current?.id === c.runId ? ' sel' : ''}`} onClick={() => void openChat(c.runId)}>
                <span className="act-label">{c.title}</span>
                {c.pending ? <Pill tone="warn">needs you</Pill> : c.status === 'running' ? <Pill tone="info">…</Pill> : null}
                <span className="muted">{`${Object.keys(c.tickets).length} ticket${Object.keys(c.tickets).length === 1 ? '' : 's'} · ${ago(c.startedAt)}`}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
      <div>
        {current
          ? <ChatView chat={current} agent="Product owner" quiet tickets={tickets} refs={refs} onReply={(t) => void replyChat(t)} replyHint="Answer the product owner…" />
          : <EmptyState>Start a request, or open a conversation.</EmptyState>}
      </div>
    </div>
  );
}

export function Tickets({ d }: { d: ProjectDetail }) {
  const data = useFlow((s) => s.tickets);
  const sel = useFlow((s) => s.ticketId);
  const [view, setView] = useState<'board' | 'talk'>('board');
  const [adding, setAdding] = useState(false);
  useEffect(() => { void loadTickets(); }, [d.id]);
  const chat = useFlow((s) => s.chat);
  useEffect(() => { if (chat?.meta?.role === 'po') setView('talk'); }, [chat?.id]);
  if (!data) return <EmptyState>Loading tickets…</EmptyState>;
  const tickets = data.tickets;
  const t = sel ? tickets.find((x) => x.id === sel) : null;
  return (
    <div>
      <div className="toolbar between">
        <div className="seg-group" role="tablist" aria-label="Tickets view">
          <button type="button" className={`seg${view === 'board' ? ' sel' : ''}`} onClick={() => setView('board')}>Board</button>
          <button type="button" className={`seg${view === 'talk' ? ' sel' : ''}`} onClick={() => setView('talk')}>Talk to the product owner</button>
        </div>
        <div className="actions"><Button onClick={() => setAdding((x) => !x)}>New tech ticket</Button></div>
      </div>
      <Muted>{data.tracker.kind === 'obsidian' ? `Tickets live in your Obsidian vault — ${data.tracker.dir}` : `Tickets live on this machine (${data.tracker.reason}).`}</Muted>
      {adding ? <NewTechTicket onDone={() => setAdding(false)} /> : null}
      {view === 'board' ? <Adoptable specs={data.adoptable ?? []} /> : null}
      {view === 'board' ? (
        <>
          {tickets.length ? <Board tickets={tickets.filter((x) => x.status !== 'rejected')} /> : <EmptyState>No ticket yet. Talk to the product owner to create the first ones.</EmptyState>}
          {t ? <TicketDetail t={t} /> : null}
        </>
      ) : <Conversations tickets={tickets} />}
    </div>
  );
}
