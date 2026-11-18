import { useEffect, useState, type FormEvent } from 'react';
import type { ProjectDetail } from '../../../../shared/api';
import { api } from '../../api/client';
import { usePoll } from '../../lib/usePoll';
import { useApp } from '../../store/app';
import { ago, seconds, usd } from '../../lib/format';
import { loadCommands, openRun, sendReply, startRun, useRun, type RunForm } from '../../store/run';
import { isLive, useLive } from '../../store/live';
import { Button, Muted, Pill, SectionTitle, Table, type PillTone } from '../../ui/primitives';
import { Feed } from './Feed';
import { PendingCard } from './PendingCard';

const MODES: [string, string][] = [['default', 'ask for edits'], ['acceptEdits', 'accept edits'], ['plan', 'plan only']];

function ReplyBox({ command }: { command: string }) {
  const [text, setText] = useState('');
  const send = (e: FormEvent) => { e.preventDefault(); const t = text.trim(); if (t) { void sendReply(t); setText(''); } };
  return (
    <form className="reply-box" onSubmit={send}>
      <textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} placeholder={`Reply to ${command.split(' ')[0]} (same session)…`} aria-label="Reply to the command" />
      <Button type="submit">Send</Button>
      <Muted>Goes to this Cohorte command only — it is not a general chat.</Muted>
    </form>
  );
}

const RUN_TONE: Record<string, PillTone> = { done: 'ok', failed: 'bad', stopped: 'warn', running: 'info' };

/** Runs kept by the server (they survive a restart), newest first; click one to read its feed or reply to it. */
function History({ d, currentId }: { d: ProjectDetail; currentId: string | undefined }) {
  const runs = [...(d.runs ?? [])].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  if (!runs.length) return null;
  return (
    <>
      <SectionTitle>History</SectionTitle>
      <Table head={['Command', 'Status', 'Cost', 'Took', 'When']}>
        {runs.map((x) => (
          <tr key={x.id} className={`click${x.id === currentId ? ' current' : ''}`} tabIndex={0} aria-current={x.id === currentId ? 'true' : undefined}
            onClick={() => void openRun(x.id)} onKeyDown={(e) => { if (e.key === 'Enter') void openRun(x.id); }}>
            <td className="mono">{x.command}</td><td><Pill tone={RUN_TONE[x.status] ?? ''}>{x.status}</Pill></td>
            <td>{x.result?.costUsd != null ? usd(x.result.costUsd) : ''}</td><td>{seconds(x.result?.durationMs)}</td><td className="muted">{ago(x.startedAt)}</td>
          </tr>
        ))}
      </Table>
    </>
  );
}

export function Run({ d }: { d: ProjectDetail }) {
  const { commands, form, run } = useRun();
  const tab = useApp((s) => s.tab);
  const live = isLive(useLive((s) => s.status));
  useEffect(() => { void loadCommands(); }, []);
  // Coming back to a project (from Home, the palette, a notification) with a command still running: pick it up, gates and all.
  const running0 = (d.runs ?? []).find((r) => r.status === 'running');
  useEffect(() => { if (!run && running0) void openRun(running0.id); }, [run, running0?.id]);
  usePoll(() => useRun.getState().poll(), 1000, tab === 'run' && run?.status === 'running' && !live, `${run?.id}:${run?.status}`);

  const cmds = commands ?? [];
  const wts = d.worktrees.filter((w) => !w.bare);
  const cur: RunForm = {
    wt: form.wt ?? wts[0]?.path ?? '', cmd: form.cmd ?? cmds[0]?.name ?? '', args: form.args ?? '', mode: form.mode ?? 'default',
  };
  const hint = cmds.find((c) => c.name === cur.cmd);
  const set = useRun.getState().setForm;
  const submit = (e: FormEvent) => { e.preventDefault(); void startRun(cur); };
  const running = run?.status === 'running';
  const stop = () => { const sel = useApp.getState().sel; if (sel && run) void api.stopRun(sel, run.id).then(() => useRun.getState().poll()); };

  return (
    <div>
      {commands && !cmds.length ? <Muted>No /cohorte-* commands found in ~/.claude/commands — run `cohorte install`.</Muted> : null}
      <form className="row-form wrap" onSubmit={submit}>
        <select aria-label="Worktree" value={cur.wt} onChange={(e) => set({ wt: e.target.value })}>
          {wts.map((w) => <option key={w.path} value={w.path}>{`${w.main ? '(main) ' : ''}${w.branch || w.path}`}</option>)}
        </select>
        <select aria-label="Command" value={cur.cmd} onChange={(e) => set({ cmd: e.target.value })}>
          {cmds.map((c) => <option key={c.name} value={c.name} title={c.description}>{c.name}</option>)}
        </select>
        <input aria-label="Argument" value={cur.args} onChange={(e) => set({ args: e.target.value })} placeholder="argument (feature id, text…)" />
        <select aria-label="Permission mode" value={cur.mode} onChange={(e) => set({ mode: e.target.value })}>
          {MODES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
        <Button type="submit" variant="primary" disabled={running}>Run</Button>
      </form>
      <Muted>{hint ? `${hint.description}${hint.argumentHint ? `  [${hint.argumentHint}]` : ''}` : ''}</Muted>
      <Muted>Headless run (claude -p): gates and questions appear below. Talking to the agent stays in Claude Code or Francois.</Muted>
      {run ? (
        <>
          <SectionTitle plain>{`${run.command} · ${run.status}`}{running ? <> <Button onClick={stop}>Stop</Button></> : null}</SectionTitle>
          {run.pending.map((p) => <PendingCard key={p.requestId} p={p} />)}
          <Feed events={run.events} />
          {!running && run.sessionId ? <ReplyBox command={run.command} /> : null}
        </>
      ) : null}
      <History d={d} currentId={run?.id} />
    </div>
  );
}
