import { useState, type FormEvent } from 'react';
import type { ProjectSummary } from '../../../../shared/api';
import { byProject, useActivity } from '../../store/activity';
import { addProject, goHome, selectProject, useApp } from '../../store/app';
import { openNewProject } from '../../store/founding';
import { Button, Dot, SectionTitle } from '../../ui/primitives';

const tone = (p: ProjectSummary): 'ok' | 'warn' | 'bad' => (p.error || p.missing || !p.summary ? 'bad' : p.summary.bad ? 'bad' : p.summary.warn ? 'warn' : 'ok');

export function Sidebar() {
  const { projects, suggestions, sel, version } = useApp();
  const [path, setPath] = useState('');
  const per = byProject(useActivity((s) => s.items));
  const submit = (e: FormEvent) => { e.preventDefault(); const p = path.trim(); if (p) { void addProject(p); setPath(''); } };
  return (
    <aside className="sidebar">
      <h1><button type="button" className="brand" onClick={goHome} title="Home" aria-label="Cohorte home">Cohorte</button> <span className="muted mono">{version ? `v${version}` : ''}</span></h1>
      <Button variant="primary" className="new-project-btn" onClick={() => openNewProject('idea')}>+ New project</Button>
      <form className="row-form" onSubmit={submit}>
        <input value={path} onChange={(e) => setPath(e.target.value)} placeholder="/path/to/project" aria-label="Project path" />
        <Button type="submit">Add</Button>
      </form>
      <nav aria-label="Projects">
        {projects.map((p) => (
          <button key={p.id} type="button" className={`proj${p.id === sel ? ' sel' : ''}`} aria-current={p.id === sel ? 'true' : undefined} onClick={() => void selectProject(p.id)}>
            <span className="proj-name"><Dot tone={tone(p)} />{p.title || p.name}
              {per[p.id]?.pending ? <span className="badge-attn" title="Waiting for you">{per[p.id].pending}</span> : per[p.id]?.running ? <span className="badge-run" title="Something is running">{per[p.id].running}</span> : null}
            </span>
            <span className="muted mono">{p.founding ? 'new project' : p.missing ? 'folder missing' : `${p.specTotal ?? 0} spec${p.specTotal === 1 ? '' : 's'}`}</span>
          </button>
        ))}
      </nav>
      {suggestions.length ? <SectionTitle>Found on this machine</SectionTitle> : null}
      {suggestions.map((s) => (
        <div key={s.root} className="sug">
          <span><div>{s.name}</div><div className="muted mono">{s.root}</div></span>
          <Button onClick={() => void addProject(s.root)}>Add</Button>
        </div>
      ))}
    </aside>
  );
}
