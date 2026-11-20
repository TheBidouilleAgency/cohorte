import type { ReactNode } from 'react';
import type { ProjectDetail } from '../../../../shared/api';
import { removeProject, TABS, useApp, type TabId } from '../../store/app';
import { goTab } from '../../store/nav';
import { Button, EmptyState, ErrorText, Muted } from '../../ui/primitives';
import { Tabs } from '../../ui/Tabs';
import { Cost } from '../cost/Cost';
import { Docker } from '../docker/Docker';
import { Health } from '../health/Health';
import { Overview } from '../overview/Overview';
import { Run } from '../run/Run';
import { Specs } from '../specs/Specs';
import { Worktrees } from '../worktrees/Worktrees';
import { Home } from '../home/Home';
import { Tickets } from '../tickets/Tickets';
import { Features } from '../features/Features';
import { Settings } from '../settings/Settings';
import { Topbar } from './Topbar';
import { Founding } from '../founding/Founding';

const PANELS: Record<TabId, (d: ProjectDetail) => ReactNode> = {
  overview: (d) => <Overview d={d} />, health: (d) => <Health d={d} />, specs: (d) => <Specs d={d} />, run: (d) => <Run d={d} />,
  worktrees: (d) => <Worktrees d={d} />, docker: (d) => <Docker d={d} />, cost: () => <Cost />,
  tickets: (d) => <Tickets d={d} />, features: (d) => <Features d={d} />, settings: () => <Settings />,
};
const TAB_DEFS = TABS.map(([id, label]) => ({ id, label }));

export function Main() {
  const { projects, sel, detail, tab, error, busy } = useApp();
  const onTab = (t: TabId) => goTab(t);
  const sum = projects.find((p) => p.id === sel);
  if (!sel || !sum) return <main className="main"><Topbar />{error ? <ErrorText>{error}</ErrorText> : null}<Home /></main>;
  return (
    <main className="main">
      <Topbar />
      {error ? <ErrorText>{error}</ErrorText> : null}
      {sum ? (
        <header>
          <h2>{sum.title || sum.name}</h2>
          <Muted>{sum.oneLiner ?? ''}</Muted>
          <Muted mono>{sum.root}</Muted>
          <div className="head-actions"><Button onClick={() => { if (window.confirm('Remove this project from the dashboard? Nothing on disk is touched.')) void removeProject(sum.id); }}>Remove from dashboard</Button></div>
        </header>
      ) : null}
      {sum.founding ? <Founding /> : (
        <>
          <Tabs tabs={TAB_DEFS} value={tab} onChange={onTab} label="Project sections" />
          <div id="tabpanel" role="tabpanel" aria-labelledby={`tab-${tab}`}>
            {!detail ? <EmptyState>{busy ? 'Loading…' : 'Nothing to show.'}</EmptyState> : PANELS[tab](detail)}
          </div>
        </>
      )}
    </main>
  );
}
