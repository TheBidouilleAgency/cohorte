import { useEffect } from 'react';
import { buildRoute, parseRoute } from '../../lib/route';
import { goHome, isTab, selectProject, TABS, useApp } from '../../store/app';
import { loadCommands } from '../../store/run';
import { loadMetrics } from '../../store/specs';
import { loadForTab } from '../../store/nav';

const TAB_IDS = TABS.map(([id]) => id);

/** Keeps the address bar (`#/p/<id>/<tab>`) and the store in step, both ways. Back/forward and pasted links work. */
export function Router() {
  const sel = useApp((s) => s.sel);
  const tab = useApp((s) => s.tab);

  // store → address bar
  useEffect(() => {
    const want = buildRoute(sel, tab);
    if (location.hash !== want) history.pushState(null, '', `${location.pathname}${want}`);
  }, [sel, tab]);

  // address bar → store
  useEffect(() => {
    const onHash = () => {
      const r = parseRoute(location.hash, TAB_IDS);
      const cur = useApp.getState();
      if (!r.projectId) { goHome(); return; }
      if (!cur.projects.some((p) => p.id === r.projectId)) return;
      const t = isTab(r.tab) ? r.tab : 'overview';
      if (r.projectId !== cur.sel) void selectProject(r.projectId, t);
      else if (t !== cur.tab) { cur.setTab(t); if (t === 'run') void loadCommands(); if (t === 'cost') void loadMetrics(); loadForTab(t); }
    };
    window.addEventListener('hashchange', onHash);
    window.addEventListener('popstate', onHash);
    return () => { window.removeEventListener('hashchange', onHash); window.removeEventListener('popstate', onHash); };
  }, []);
  return null;
}
