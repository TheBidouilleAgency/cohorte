import { useEffect, useMemo, useRef, useState } from 'react';
import { buildItems, filterItems, type PaletteItem } from '../../lib/palette';
import { nextPrefill } from '../../lib/stage';
import { goHome, selectProject, useApp } from '../../store/app';
import { goTabId, prefillRun } from '../../store/nav';
import { useUi } from '../../store/ui';

function run(item: PaletteItem): void {
  const a = item.action;
  const app = useApp.getState();
  if (a.kind === 'home') goHome();
  else if (a.kind === 'project') void selectProject(a.id);
  else if (a.kind === 'tab') goTabId(a.tab);
  else {
    const spec = app.detail?.specs.find((s) => s.id === a.specId);
    const p = spec && app.detail ? nextPrefill(spec, app.detail.worktrees) : null;
    if (p) prefillRun(p);
  }
}

/** Ctrl/⌘ K. Choosing a "Run …" entry only prefills the Run form. */
export function Palette() {
  const open = useUi((s) => s.paletteOpen);
  const setOpen = useUi((s) => s.setPalette);
  const { projects, sel, detail } = useApp();
  const [q, setQ] = useState('');
  const [i, setI] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const all = useMemo(() => buildItems(projects, sel, detail), [projects, sel, detail]);
  const items = useMemo(() => filterItems(all, q), [all, q]);
  useEffect(() => { if (open) { setQ(''); setI(0); setTimeout(() => input.current?.focus(), 0); } }, [open]);
  useEffect(() => { setI(0); }, [q]);
  if (!open) return null;
  const choose = (it: PaletteItem | undefined) => { if (it) { setOpen(false); run(it); } };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); setOpen(false); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setI((n) => Math.min(items.length - 1, n + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setI((n) => Math.max(0, n - 1)); }
    else if (e.key === 'Enter') { e.preventDefault(); choose(items[i]); }
  };
  let last = '';
  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) setOpen(false); }}>
      <div className="dialog palette" role="dialog" aria-modal="true" aria-label="Command palette" onKeyDown={onKey}>
        <input ref={input} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Jump to a project, a tab, or run a next step…" aria-label="Search commands" role="combobox" aria-expanded="true" aria-controls="palette-list" aria-activedescendant={items[i] ? `pal-${items[i].id}` : undefined} />
        <ul id="palette-list" role="listbox" className="palette-list">
          {items.length ? items.map((it, n) => {
            const head = it.group !== last ? <li key={`g-${it.group}`} className="palette-group" role="presentation">{it.group}</li> : null;
            last = it.group;
            return [head, (
              <li key={it.id} id={`pal-${it.id}`} role="option" aria-selected={n === i} className={`palette-item${n === i ? ' sel' : ''}`} onMouseMove={() => setI(n)} onClick={() => choose(it)}>
                <span>{it.label}</span><span className="muted mono palette-hint">{it.hint}</span>
              </li>)];
          }) : <li className="palette-empty" role="presentation">No match</li>}
        </ul>
      </div>
    </div>
  );
}
