import { useEffect, useState } from 'react';
import type { FoundingPhase, FoundingView } from '../../../../shared/api';
import { FoundationCard, ScaffoldCard, VisionCard } from './Cards';
import { ago, usd } from '../../lib/format';
import { usePoll } from '../../lib/usePoll';
import { useApp } from '../../store/app';
import { foundingCheckpoint, foundingReply, loadFounding, useFounding } from '../../store/founding';
import { openChat, pollChat, useFlow } from '../../store/flow';
import { isLive, useLive } from '../../store/live';
import { Button, Card, EmptyState, Muted, Pill, SectionTitle, Table, type PillTone } from '../../ui/primitives';
import { ChatView } from '../flow/Chat';

const PHASE: Record<FoundingPhase, [string, PillTone]> = {
  vision: ['shaping the vision', 'info'], 'cp-vision': ['vision to validate', 'warn'], foundation: ['choosing the stack', 'info'],
  'cp-foundation': ['foundations to approve', 'warn'], scaffold: ['generating the skeleton', 'info'], 'cp-scaffold': ['the skeleton needs you', 'warn'],
  setup: ['setting up the pipeline', 'info'], done: ['ready', 'ok'], abandoned: ['abandoned', 'idle'],
};
const STEPS: { label: string; phases: FoundingPhase[] }[] = [
  { label: 'Vision', phases: ['vision', 'cp-vision'] }, { label: 'Foundations', phases: ['foundation', 'cp-foundation'] },
  { label: 'Skeleton', phases: ['scaffold', 'cp-scaffold'] }, { label: 'Pipeline', phases: ['setup'] }, { label: 'Ready', phases: ['done'] },
];
const AGENT: Record<string, string> = { vision: 'Product owner', foundation: 'Lead', scaffold: 'Scaffold', setup: 'Pipeline set-up' };

function Steps({ f }: { f: FoundingView }) {
  const steps = f.mode === 'existing' ? STEPS.slice(3) : f.mode === 'stack' ? STEPS.slice(1) : STEPS;
  const cur = steps.findIndex((s) => s.phases.includes(f.phase));
  return (
    <ol className="stepper timeline" aria-label="New project steps">
      {steps.map((s, i) => {
        const state = i < cur ? 'done' : i === cur ? (f.phase.startsWith('cp-') ? 'current attn' : 'current') : 'todo';
        return <li key={s.label} className={`step step-${state}`}><span className="step-mark">{i < cur ? '✓' : i === cur ? '●' : '○'}</span>{s.label}</li>;
      })}
    </ol>
  );
}

function Checkpoint({ f }: { f: FoundingView }) {
  const [text, setText] = useState('');
  const act = (action: string, needsText = false) => { if (needsText && !text.trim()) return; void foundingCheckpoint(action, text.trim() || undefined); setText(''); };
  if (f.phase === 'cp-vision' && f.vision) {
    return (
      <Card tone="warn" className="checkpoint">
        <div className="plan-head"><Pill tone="warn">Vision · to validate</Pill><span>{`by ${f.requester || 'the person with the idea'}`}</span></div>
        <VisionCard v={f.vision} name={f.name} tickets={f.tickets} />
        <textarea rows={2} value={text} onChange={(e) => setText(e.target.value)} placeholder="What to change instead (sent to the product owner)" aria-label="Your note" />
        <div className="actions"><Button variant="primary" onClick={() => act('approve')}>Validate the vision</Button>
          <Button disabled={!text.trim()} onClick={() => act('reply', true)}>Ask for a change</Button></div>
        <Muted>Validating writes PRODUCT.md and hands over to a developer and the lead, who choose how to build it.</Muted>
      </Card>
    );
  }
  if (f.phase === 'cp-foundation' && f.foundation) {
    return (
      <Card tone="warn" className="checkpoint">
        <div className="plan-head"><Pill tone="warn">Foundations · to approve</Pill></div>
        <FoundationCard p={f.foundation} />
        <textarea rows={2} value={text} onChange={(e) => setText(e.target.value)} placeholder="Optional: a last instruction for the skeleton, or what the lead should change" aria-label="Your note" />
        <div className="actions"><Button variant="primary" onClick={() => act('approve')}>Approve — generate the skeleton</Button>
          <Button disabled={!text.trim()} onClick={() => act('reply', true)}>Ask the lead to change it</Button></div>
        <Muted>The skeleton is generated with each framework's own generator, its checks run and it is committed. The tools the plan names run without asking; anything else asks you here.</Muted>
      </Card>
    );
  }
  if (f.phase === 'cp-scaffold') {
    return (
      <Card tone="warn" className="checkpoint">
        <div className="plan-head"><Pill tone="warn">Skeleton · needs you</Pill><span>{f.error}</span></div>
        {f.scaffold ? <ScaffoldCard r={f.scaffold} /> : null}
        <textarea rows={2} value={text} onChange={(e) => setText(e.target.value)} placeholder="What to do differently (for Retry), or an answer to the agent" aria-label="Your note" />
        <div className="actions"><Button variant="primary" onClick={() => act('retry')}>Retry (one model up)</Button>
          <Button disabled={!text.trim()} onClick={() => act('reply', true)}>Answer the agent</Button>
          <Button onClick={() => { if (window.confirm('Set up the pipeline on the skeleton as it is now? Its failing checks stay failing.')) act('continue'); }}>Keep it as is</Button></div>
      </Card>
    );
  }
  return null;
}

export function Founding() {
  const sel = useApp((s) => s.sel);
  const f = useFounding((s) => s.view);
  const chat = useFlow((s) => s.chat);
  const live = isLive(useLive((s) => s.status));
  useEffect(() => { void loadFounding(); }, [sel]);
  usePoll(() => pollChat(), 1200, chat?.status === 'running' && !live, `${chat?.id}:${chat?.status}`);
  usePoll(async () => { await loadFounding(); return true; }, 5000, !live, sel);
  if (!f || f.projectId !== sel) return <EmptyState>Loading…</EmptyState>;
  const [phase, tone] = PHASE[f.phase];
  const role = chat?.meta?.role ?? '';
  const conversing = ['vision', 'foundation', 'setup', 'scaffold'].includes(f.phase) || f.phase.startsWith('cp-');
  const abandon = () => { if (window.confirm('Abandon this project? The folder stays on disk; it is only no longer being founded.')) void foundingCheckpoint('abandon'); };
  return (
    <div>
      <div className="spec-head"><h2>{`New project · ${f.name}`}</h2><Pill tone={tone}>{phase}</Pill><span className="muted">{usd(f.costUsd)}</span>
        <span className="muted push-right">{`started ${ago(f.createdAt)}`}</span>{f.phase !== 'done' && f.phase !== 'abandoned' ? <Button onClick={abandon}>Abandon</Button> : null}</div>
      <Steps f={f} />
      {f.error && f.phase !== 'cp-scaffold' ? <Card tone="bad" className="gate"><div className="error pre-wrap">{f.error}</div>
        {f.phase === 'setup' ? <div className="actions"><Button onClick={() => void foundingCheckpoint('retry')}>Restart the set-up</Button></div> : null}</Card> : null}
      {f.warning ? <Card tone="warn" className="gate"><div className="pre-wrap">{f.warning}</div></Card> : null}
      <Checkpoint f={f} />
      {f.phase !== 'cp-vision' && f.vision ? <details className="gap-top"><summary>The validated vision</summary><VisionCard v={f.vision} name={f.name} tickets={f.tickets} /></details> : null}
      {f.phase !== 'cp-foundation' && f.foundation && ['scaffold', 'cp-scaffold', 'setup', 'done'].includes(f.phase) ? <details className="gap-top"><summary>The approved foundations</summary><FoundationCard p={f.foundation} /></details> : null}
      {f.stages.length > 1 ? (
        <>
          <SectionTitle>Steps so far</SectionTitle>
          <Table head={['Step', 'Model', 'Status', 'Cost', 'When']}>
            {f.stages.map((s) => (
              <tr key={s.runId} className={`click${chat?.id === s.runId ? ' current' : ''}`} tabIndex={0} onClick={() => void openChat(s.runId)} onKeyDown={(e) => { if (e.key === 'Enter') void openChat(s.runId); }}>
                <td>{AGENT[s.stage] ?? s.stage}</td><td className="mono">{s.model}</td>
                <td><Pill tone={s.status === 'done' ? 'ok' : s.status === 'running' ? 'info' : 'bad'}>{s.status}</Pill></td>
                <td>{s.costUsd != null ? usd(s.costUsd) : ''}</td><td className="muted">{ago(s.startedAt)}</td>
              </tr>
            ))}
          </Table>
        </>
      ) : null}
      <SectionTitle>{chat ? `Conversation · ${AGENT[role] ?? 'Agent'}` : 'Conversation'}</SectionTitle>
      {chat ? (
        <ChatView chat={chat} agent={AGENT[role] ?? 'Agent'} quiet={role === 'vision'}
          onReply={conversing && chat.id === (f.currentRunId || f.stages[f.stages.length - 1]?.runId) ? (t) => void foundingReply(t) : undefined}
          replyHint={role === 'vision' ? 'Answer the product owner…' : role === 'foundation' ? 'Answer the lead, or tell it what you want…' : 'Answer the agent…'} />
      ) : <Muted>Starting…</Muted>}
    </div>
  );
}
