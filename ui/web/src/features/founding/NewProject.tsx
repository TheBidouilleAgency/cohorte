import { useEffect, useState, type FormEvent } from 'react';
import type { FoundingMode } from '../../../../shared/api';
import { closeNewProject, createProject, useFounding } from '../../store/founding';
import { useApp } from '../../store/app';
import { Button, Card, Muted, SectionTitle } from '../../ui/primitives';

const MODES: { v: FoundingMode; label: string; text: string }[] = [
  { v: 'idea', label: 'Start from an idea', text: 'The product owner talks it through with you (or with the person who has the idea): who it is for, what the first version must do. Then a developer chooses the stack with the lead.' },
  { v: 'stack', label: 'I know what to build', text: 'Straight to the lead: describe the project, choose the stack together, and the skeleton is generated.' },
  { v: 'existing', label: 'A repository I already have', text: 'A git repository that does not use cohorte yet: the pipeline is set up in it from here.' },
];

/** Where new projects usually go: next to the ones already registered. */
function defaultParent(roots: string[]): string {
  const parents = roots.map((r) => r.replace(/[\\/][^\\/]+$/, ''));
  const count = new Map<string, number>();
  for (const p of parents) count.set(p, (count.get(p) ?? 0) + 1);
  return [...count.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '~';
}

export function NewProject() {
  const form = useFounding((s) => s.form);
  const projects = useApp((s) => s.projects);
  const busy = useApp((s) => s.busy);
  const [mode, setMode] = useState<FoundingMode>(form?.mode ?? 'idea');
  const [name, setName] = useState('');
  const [parent, setParent] = useState(() => defaultParent(projects.map((p) => p.root)));
  const [path, setPath] = useState(form?.path ?? '');
  const [brief, setBrief] = useState('');
  const [requester, setRequester] = useState('');
  const [basedOn, setBasedOn] = useState('');
  useEffect(() => { if (form) { setMode(form.mode); if (form.path) setPath(form.path); } }, [form]);
  if (!form) return null;
  const others = projects.filter((p) => !p.founding && !p.missing);
  const ok = mode === 'existing' ? !!path.trim() : !!name.trim() && !!parent.trim() && (mode !== 'idea' || !!brief.trim());
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!ok) return;
    void createProject(mode === 'existing' ? { mode, path: path.trim() }
      : { mode, name: name.trim(), parent: parent.trim(), brief: brief.trim(), requester: requester.trim() || undefined, basedOn: basedOn || null });
  };
  return (
    <Card className="new-project">
      <form onSubmit={submit}>
        <div className="toolbar between"><SectionTitle plain>New project</SectionTitle><Button type="button" onClick={closeNewProject}>Cancel</Button></div>
        <div className="mode-pick" role="radiogroup" aria-label="How to start">
          {MODES.map((m) => (
            <label key={m.v} className={`mode${mode === m.v ? ' sel' : ''}`}>
              <input type="radio" name="mode" checked={mode === m.v} onChange={() => setMode(m.v)} />
              <strong>{m.label}</strong><span className="muted">{m.text}</span>
            </label>
          ))}
        </div>
        {mode === 'existing' ? (
          <div className="field"><label htmlFor="np-path">Repository folder</label>
            <input id="np-path" value={path} onChange={(e) => setPath(e.target.value)} placeholder="/absolute/path/to/the/repo" /></div>
        ) : (
          <>
            <div className="row-form wrap">
              <div className="field grow"><label htmlFor="np-name">Folder name</label>
                <input id="np-name" value={name} onChange={(e) => setName(e.target.value.replace(/\s+/g, '-'))} placeholder="my-product" /></div>
              <div className="field grow"><label htmlFor="np-parent">Created in</label>
                <input id="np-parent" value={parent} onChange={(e) => setParent(e.target.value)} placeholder="~/dev" /></div>
            </div>
            <div className="field"><label htmlFor="np-brief">{mode === 'idea' ? 'The idea, in your words' : 'What you want to build (optional — the lead asks)'}</label>
              <textarea id="np-brief" rows={4} value={brief} onChange={(e) => setBrief(e.target.value)}
                placeholder={mode === 'idea' ? 'Who has which problem, and what you imagine… No technical detail needed.' : 'A web app + API for…, the stack you have in mind, constraints…'} /></div>
            {mode === 'idea' ? (
              <div className="field"><label htmlFor="np-req">Who is asking (optional)</label>
                <input id="np-req" value={requester} onChange={(e) => setRequester(e.target.value)} placeholder="Their name or role — they validate the vision" /></div>
            ) : null}
            {others.length ? (
              <div className="field"><label htmlFor="np-from">Start from one of my projects (optional)</label>
                <select id="np-from" value={basedOn} onChange={(e) => setBasedOn(e.target.value)}>
                  <option value="">No — choose the stack from scratch</option>
                  {others.map((p) => <option key={p.id} value={p.id}>{p.title || p.name}</option>)}
                </select>
                <Muted>Same structure, tooling and conventions — none of its business code.</Muted></div>
            ) : null}
          </>
        )}
        <div className="actions"><Button type="submit" variant="primary" disabled={!ok || busy}>{mode === 'existing' ? 'Set up cohorte in it' : mode === 'idea' ? 'Talk to the product owner' : 'Talk to the lead'}</Button>
          <Muted>{mode === 'existing' ? 'Nothing is committed for you: you review the pipeline files and commit them.' : 'The folder is created with git. Nothing is pushed anywhere until you connect a code host.'}</Muted></div>
      </form>
    </Card>
  );
}
