import { useState, type FormEvent, type ReactNode } from 'react';
import type { Plan, RunEvent, Ticket, TicketProposal } from '../../../../shared/api';
import { blocksOf, stripBlocks, toAcceptance, toFoundation, toPlan, toProposal, toScaffold, toVision } from '../../../../shared/blocks';
import { FoundationCard, ScaffoldCard, VisionCard } from '../founding/Cards';
import { usd } from '../../lib/format';
import type { Chat as ChatRun } from '../../store/flow';
import { respondChat } from '../../store/flow';
import { Button, Card, Muted, Pill } from '../../ui/primitives';
import { PendingCard } from '../run/PendingCard';

export function PlanCard({ plan }: { plan: Plan }) {
  return (
    <Card className="plan">
      <div className="plan-head"><Pill tone="info">Plan</Pill><span className="muted">{`size ${plan.size}`}</span></div>
      <p className="pre-wrap">{plan.summary}</p>
      {plan.criteria.length ? <><div className="label">Acceptance criteria</div><ul className="rc-list">{plan.criteria.map((c) => <li key={c.id}><span className="mono">{c.id}</span> {c.text}</li>)}</ul></> : null}
      {plan.contract && plan.contract !== 'none' ? <><div className="label">Contract</div><p className="pre-wrap">{plan.contract}</p></> : null}
      {plan.surfaces.length ? <><div className="label">Work by surface</div>{plan.surfaces.map((s) => (
        <div key={s.key}><span className="mono">{s.key}</span><ul className="rc-list">{s.tasks.map((t, i) => <li key={i}>{t}</li>)}</ul></div>
      ))}</> : null}
      {plan.risks.length ? <><div className="label">Risks</div><ul className="rc-list">{plan.risks.map((r, i) => <li key={i}>{r}</li>)}</ul></> : null}
      {plan.assumptions.length ? <><div className="label">Assumed without asking — veto any</div><ul className="rc-list">{plan.assumptions.map((r, i) => <li key={i}>{r}</li>)}</ul></> : null}
      {plan.questions.length ? <><div className="label">Still open</div><ul className="rc-list">{plan.questions.map((r, i) => <li key={i}>{r}</li>)}</ul></> : null}
    </Card>
  );
}

function ProposalCard({ p, ticket }: { p: TicketProposal; ticket: Ticket | null }) {
  const state = !ticket ? 'proposed' : ticket.status === 'validate' ? 'waiting for validation' : ticket.status === 'rejected' ? 'rejected' : `validated · ${ticket.status}`;
  return (
    <Card className="proposal">
      <div className="plan-head"><Pill tone={ticket && ticket.status !== 'validate' && ticket.status !== 'rejected' ? 'ok' : 'warn'}>{p.type === 'bug' ? 'Bug' : 'Ticket'}</Pill><strong>{p.title}</strong><span className="muted">{state}</span></div>
      {p.need ? <p className="pre-wrap">{p.need}</p> : null}
      {p.criteria.length ? <ul className="rc-list">{p.criteria.map((c, i) => <li key={i}>{c}</li>)}</ul> : null}
      <div className="rc-row"><Pill>{`priority ${p.priority}`}</Pill><Pill>{`size ${p.size}`}</Pill></div>
    </Card>
  );
}

function Blocks({ text, tickets, refs }: { text: string; tickets: Ticket[]; refs: Record<string, string> }) {
  const out: ReactNode[] = [];
  blocksOf(text, 'cohorte-ticket').forEach((b, i) => {
    const p = toProposal(b);
    if (p) out.push(<ProposalCard key={`t${i}`} p={p} ticket={tickets.find((t) => t.id === refs[p.ref]) ?? null} />);
  });
  blocksOf(text, 'cohorte-plan').forEach((b, i) => { const p = toPlan(b); if (p) out.push(<PlanCard key={`p${i}`} plan={p} />); });
  blocksOf(text, 'cohorte-vision').forEach((b, i) => { const v = toVision(b); if (v) out.push(<VisionCard key={`v${i}`} v={v} />); });
  blocksOf(text, 'cohorte-foundation').forEach((b, i) => { const p = toFoundation(b); if (p) out.push(<FoundationCard key={`f${i}`} p={p} />); });
  blocksOf(text, 'cohorte-scaffold').forEach((b, i) => { const r = toScaffold(b); if (r) out.push(<ScaffoldCard key={`s${i}`} r={r} />); });
  blocksOf(text, 'cohorte-acceptance').forEach((b, i) => {
    const a = toAcceptance(b);
    if (a) out.push(<Card key={`a${i}`} className="proposal"><Pill tone="info">Acceptance note</Pill><p className="pre-wrap">{a.summary}</p></Card>);
  });
  return <>{out}</>;
}

function Row({ e, quiet, tickets, refs, agent }: { e: RunEvent; quiet: boolean; tickets: Ticket[]; refs: Record<string, string>; agent: string }) {
  switch (e.kind) {
    case 'text': {
      const t = stripBlocks(e.text);
      return <>{t ? <div className="bubble bubble-agent"><div className="bubble-who">{agent}</div><div className="pre-wrap">{t}</div></div> : null}<Blocks text={e.text} tickets={tickets} refs={refs} /></>;
    }
    case 'reply': return <div className="bubble bubble-you"><div className="bubble-who">you</div><div className="pre-wrap">{e.text}</div></div>;
    case 'tool': return quiet ? null : <div className="ev muted mono">{`▸ ${e.name}  ${e.summary}`}</div>;
    case 'tool_result': return !quiet && e.error ? <div className="ev error mono">{`✗ ${e.text}`}</div> : null;
    case 'result': return e.ok ? (quiet ? null : <div className="ev muted">{`turn done${e.costUsd != null ? ` · ${usd(e.costUsd)}` : ''}`}</div>) : <div className="ev error">{`The agent stopped: ${e.text}`}</div>;
    case 'stderr': case 'system': return quiet ? null : <div className="ev error mono">{e.text}</div>;
    default: return null;
  }
}

/** A conversation with an agent: its messages as bubbles, the blocks it proposed as cards, what it waits on, a reply box. */
export function ChatView({ chat, agent, quiet = false, tickets = [], refs = {}, onReply, replyHint, empty }: {
  chat: ChatRun; agent: string; quiet?: boolean; tickets?: Ticket[]; refs?: Record<string, string>;
  onReply?: (text: string) => void; replyHint?: string; empty?: string;
}) {
  const [text, setText] = useState('');
  const running = chat.status === 'running';
  const send = (e: FormEvent) => { e.preventDefault(); const t = text.trim(); if (t && onReply) { onReply(t); setText(''); } };
  return (
    <div className="chat">
      <div className="chat-feed" aria-live="polite">
        {chat.events.length ? chat.events.map((e, i) => <Row key={i} e={e} quiet={quiet} tickets={tickets} refs={refs} agent={agent} />) : <Muted>{empty ?? 'Starting…'}</Muted>}
        {running && !chat.pending.length ? <div className="typing muted">{`${agent} is working…`}</div> : null}
      </div>
      {chat.pending.map((p) => <PendingCard key={p.requestId} p={p} onRespond={respondChat} />)}
      {onReply ? (
        <form className="reply-box" onSubmit={send}>
          <textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} placeholder={replyHint ?? 'Your answer…'} aria-label="Your message"
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send(e as unknown as FormEvent); }} />
          <div className="actions"><Button type="submit" variant="primary" disabled={running || !text.trim()}>Send</Button>
            <Muted>{running ? 'Wait for the answer to finish…' : '⌘/Ctrl-Enter to send'}</Muted></div>
        </form>
      ) : null}
    </div>
  );
}
