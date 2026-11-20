import { useEffect, useState, type FormEvent } from 'react';
import type { Autonomy, ModelRole, ProjectSettings } from '../../../../shared/api';
import { ago, usd } from '../../lib/format';
import { connectObsidian, loadSettings, saveSettings, startProductMap, useFlow } from '../../store/flow';
import { useApp } from '../../store/app';
import { Button, Card, EmptyState, Muted, Pill, SectionTitle, Table } from '../../ui/primitives';
import { RemoteCard } from '../founding/Remote';

const AUTONOMY: { v: Autonomy; label: string; text: string }[] = [
  { v: 'prudent', label: 'Prudent', text: 'The decider only settles internal, reversible choices that a written decision (plan, spec, decisions, your past answers) answers word for word — unanimously.' },
  { v: 'balanced', label: 'Balanced', text: 'Also choices only you would notice (a library, a layout) when something you already decided answers them, unanimously. The default.' },
  { v: 'autonomous', label: 'Autonomous', text: 'Also accepts a precedent in the code and a 2-out-of-3 vote. Behaviour, contracts, security, cost and irreversible steps are always yours, whatever the level.' },
];
const ROLES: { r: ModelRole; label: string }[] = [
  { r: 'po', label: 'Product owner (business conversations)' }, { r: 'lead', label: 'Lead (framing with you)' },
  { r: 'build', label: 'Build stage' }, { r: 'implementer', label: 'Implementer agents' }, { r: 'review', label: 'Review stage' },
  { r: 'fix', label: 'Fix stage' }, { r: 'verify', label: 'Verify stage' }, { r: 'ship', label: 'Ship stage' }, { r: 'learn', label: 'Learning journal' },
  { r: 'acceptance', label: 'Acceptance note' }, { r: 'productMap', label: 'Product map' },
  { r: 'scaffold', label: 'New project — skeleton' }, { r: 'setup', label: 'New project — pipeline set-up' },
  { r: 'decider', label: 'Decider — first vote' }, { r: 'deciderEscalation', label: 'Decider — on a split vote' },
];

function Obsidian() {
  const s = useFlow((x) => x.settings);
  const [vault, setVault] = useState(''); const [board, setBoard] = useState('');
  if (!s) return null;
  const t = s.tracker;
  const submit = (e: FormEvent) => { e.preventDefault(); if (vault.trim()) void connectObsidian(vault.trim(), board.trim()); };
  return (
    <Card>
      {t.kind === 'obsidian'
        ? <><Pill tone="ok">Obsidian connected</Pill><div className="mono gap-top">{t.board}</div><Muted>{`Tickets are notes in ${t.dir}. The board is moved for you at every step.`}</Muted></>
        : <><Pill tone="warn">Local tickets</Pill><Muted>{t.reason}</Muted></>}
      <form onSubmit={submit} className="gap-top">
        <div className="row-form wrap">
          <input value={vault} onChange={(e) => setVault(e.target.value)} placeholder="Vault folder — the absolute path you open in Obsidian" aria-label="Obsidian vault path" />
          <input value={board} onChange={(e) => setBoard(e.target.value)} placeholder={`Board file in the vault (default ${t.projectName ?? '<project>'}/Tasks.md)`} aria-label="Board file" />
          <Button type="submit" disabled={!vault.trim()}>{t.kind === 'obsidian' ? 'Reconnect' : 'Connect Obsidian'}</Button>
        </div>
        <Muted>Creates the board (company layout) if it does not exist, and a Tickets folder next to it. Needs the Obsidian Kanban plugin to show the board.</Muted>
      </form>
    </Card>
  );
}

export function Settings() {
  const data = useFlow((x) => x.settings);
  const learning = useFlow((x) => x.learning);
  const sel = useApp((x) => x.sel);
  const [draft, setDraft] = useState<ProjectSettings | null>(null);
  useEffect(() => { void loadSettings(); }, [sel]);
  useEffect(() => { if (data) setDraft(data.settings); }, [data]);
  if (!data || !draft) return <EmptyState>Loading settings…</EmptyState>;
  const set = (patch: Partial<ProjectSettings>) => setDraft({ ...draft, ...patch });
  const dirty = JSON.stringify(draft) !== JSON.stringify(data.settings);
  return (
    <div>
      <SectionTitle>Where the code is hosted</SectionTitle>
      <RemoteCard />

      <SectionTitle>Where tickets live</SectionTitle>
      <Obsidian />

      <SectionTitle>Product map</SectionTitle>
      <Card>
        {data.productMap.exists ? <><Pill tone="ok">PRODUCT.md</Pill> <span className="muted">{`updated ${ago(data.productMap.updated ?? '')}`}</span></> : <Pill tone="warn">No product map yet</Pill>}
        <Muted>What the product does, in business language, discovered from the code. The product owner reads it so it never proposes what already exists. Refresh it after a few merges.</Muted>
        <div className="actions gap-top"><Button onClick={() => void startProductMap()}>{data.productMap.exists ? 'Refresh the product map' : 'Generate the product map'}</Button></div>
      </Card>

      <SectionTitle>Autopilot</SectionTitle>
      <Card>
        <label className="opt"><input type="checkbox" checked={draft.autopilot} onChange={(e) => set({ autopilot: e.target.checked })} />Run the stages between checkpoints on its own (build → review → fix → verify)</label>
        <div className="row-form wrap">
          <label className="field">Fix rounds before asking you <input type="number" min={1} max={8} value={draft.maxRounds} onChange={(e) => set({ maxRounds: Number(e.target.value) })} /></label>
          <label className="field">Merge method <select value={draft.mergeMethod} onChange={(e) => set({ mergeMethod: e.target.value as ProjectSettings['mergeMethod'] })}>
            <option value="squash">squash</option><option value="merge">merge</option><option value="rebase">rebase</option></select></label>
          <label className="field">Default requester name <input value={draft.requester} onChange={(e) => set({ requester: e.target.value })} placeholder="who usually talks to the PO" /></label>
        </div>
      </Card>

      <SectionTitle>Decider</SectionTitle>
      <Card>
        <Muted>Questions an agent asks mid-run go to the decider first. It answers only what you already settled, cites its source, and hands you the rest with its reading. Everything it decided is listed at CP3.</Muted>
        {AUTONOMY.map((a) => (
          <label key={a.v} className="opt choice"><input type="radio" name="autonomy" checked={draft.autonomy === a.v} onChange={() => set({ autonomy: a.v })} />
            <strong>{a.label}</strong> <span className="muted">— {a.text}</span></label>
        ))}
        <div className="row-form"><label className="field">Votes per question <input type="number" min={1} max={7} value={draft.deciderVotes} onChange={(e) => set({ deciderVotes: Number(e.target.value) })} /></label></div>
      </Card>

      <SectionTitle>Models</SectionTitle>
      <Card>
        <Muted>Each role runs on its own model: the strongest where judgment is the product, a lighter one where a frozen spec already did the thinking. An alias (opus, sonnet, haiku, fable) or a full model id. A failed stage retries one model up.</Muted>
        <Table>
          {ROLES.map(({ r, label }) => (
            <tr key={r}><td>{label}</td><td><input className="mono" value={draft.models[r]} onChange={(e) => set({ models: { ...draft.models, [r]: e.target.value } })} aria-label={label} /></td>
              <td className="muted">{draft.models[r] !== data.defaults.models[r] ? `default ${data.defaults.models[r]}` : ''}</td></tr>
          ))}
        </Table>
      </Card>
      <div className="actions gap-top"><Button variant="primary" disabled={!dirty} onClick={() => void saveSettings(draft)}>Save</Button>
        <Button disabled={!dirty} onClick={() => setDraft(data.settings)}>Discard</Button></div>

      {learning ? (
        <>
          <SectionTitle>What it learned</SectionTitle>
          <div className="cards">
            <Card><div className="stat-v">{learning.decisions.byDecider}</div><div className="muted">decided for you</div></Card>
            <Card><div className="stat-v">{learning.decisions.confirmed}</div><div className="muted">confirmed at CP3</div></Card>
            <Card tone={learning.decisions.contested ? 'warn' : undefined}><div className="stat-v">{learning.decisions.contested}</div><div className="muted">contested</div></Card>
            <Card><div className="stat-v">{learning.preferences}</div><div className="muted">answers remembered</div></Card>
          </div>
          {learning.stages.length ? (
            <Table head={['Stage', 'Model', 'Runs', 'Finished', 'Cost']}>
              {learning.stages.map((s) => <tr key={`${s.stage}|${s.model}`}><td className="mono">{s.stage}</td><td className="mono">{s.model}</td><td>{s.runs}</td><td>{`${s.ok}/${s.runs}`}</td><td>{usd(s.costUsd)}</td></tr>)}
            </Table>
          ) : null}
          <Muted>Rules for the agents come from /cohorte-retro: it reads the journal every merged feature leaves, and you ratify each rule.</Muted>
        </>
      ) : null}
    </div>
  );
}
