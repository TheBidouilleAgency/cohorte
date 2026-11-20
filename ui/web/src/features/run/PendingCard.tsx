import { useState } from 'react';
import type { PendingItem } from '../../../../shared/api';
import { respond } from '../../store/run';
import { Button, Card, Pill, Pre } from '../../ui/primitives';

export type Respond = (requestId: string, behavior: 'allow' | 'deny', answers?: Record<string, string[]>) => void | Promise<void>;

function QuestionCard({ p, onRespond }: { p: PendingItem; onRespond: Respond }) {
  const [picked, setPicked] = useState<Record<string, string[]>>(() => {
    // The decider's reading, when it handed the question over, is pre-selected: one click to agree.
    const q0 = p.questions?.[0];
    return p.advice?.choice && q0 ? { [q0.question]: [p.advice.choice] } : {};
  });
  const set = (q: string, v: string[]) => setPicked((cur) => ({ ...cur, [q]: v }));
  if (p.deciding) {
    return (
      <Card className="gate">
        <Pill tone="info">Decider</Pill> <span className="muted">is checking whether what you already decided answers this…</span>
        {(p.questions ?? []).map((q) => <div key={q.question} className="gap-top">{q.question}</div>)}
      </Card>
    );
  }
  return (
    <Card tone="warn" className="gate">
      <Pill tone="warn">Question</Pill>
      {p.advice ? (
        <div className="advice">
          <span className="muted">Decider: </span>
          {p.advice.choice ? <>would pick <strong>{p.advice.choice}</strong>{p.advice.rationale ? ` — ${p.advice.rationale}` : ''}. </> : null}
          <span className="muted">{`Handed to you: ${p.advice.escalated}.`}</span>
        </div>
      ) : null}
      {(p.questions ?? []).map((q) => {
        const cur = picked[q.question] ?? [];
        return (
          <fieldset key={q.question} className="q">
            <legend>{q.header ? `${q.header} — ` : ''}{q.question}</legend>
            {q.options.map((o) => (
              <label key={o.label} className="opt">
                <input type={q.multiSelect ? 'checkbox' : 'radio'} name={q.question} checked={cur.includes(o.label)}
                  onChange={(e) => set(q.question, q.multiSelect ? (e.target.checked ? cur.concat(o.label) : cur.filter((x) => x !== o.label)) : [o.label])} />
                {o.label}{o.description ? <span className="muted">{` — ${o.description}`}</span> : null}
              </label>
            ))}
            <input className="other" placeholder="Other…" aria-label="Other answer" onChange={(e) => set(q.question, e.target.value ? [e.target.value] : [])} />
          </fieldset>
        );
      })}
      <Button onClick={() => void onRespond(p.requestId, 'allow', picked)}>Answer</Button>{' '}
      <Button onClick={() => void onRespond(p.requestId, 'deny')}>Skip</Button>
    </Card>
  );
}

export function PendingCard({ p, onRespond = respond }: { p: PendingItem; onRespond?: Respond }) {
  if (p.kind === 'question') return <QuestionCard p={p} onRespond={onRespond} />;
  return (
    <Card tone="warn" className="gate">
      <Pill tone="warn">{`Permission · ${p.tool}${p.via ? ` · ${p.via}` : ''}`}</Pill>
      <Pre>{p.summary}</Pre>
      {p.reason ? <div className="fix">{p.reason}</div> : null}
      <Button onClick={() => void onRespond(p.requestId, 'allow')}>Allow</Button>{' '}
      <Button onClick={() => void onRespond(p.requestId, 'deny')}>Deny</Button>
    </Card>
  );
}
