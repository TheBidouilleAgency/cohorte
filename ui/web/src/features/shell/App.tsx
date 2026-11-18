import { useEffect } from 'react';
import { token } from '../../api/client';
import { parseRoute } from '../../lib/route';
import { bootstrap, TABS } from '../../store/app';
import { startLive } from '../../store/live';
import { EmptyState } from '../../ui/primitives';
import { Sidebar } from '../sidebar/Sidebar';
import { GlobalKeys } from './GlobalKeys';
import { Main } from './Main';
import { Palette } from './Palette';
import { Pollers } from './Pollers';
import { Router } from './Router';
import { Shortcuts } from './Shortcuts';
import { TitleBadge } from './TitleBadge';

export function App() {
  useEffect(() => {
    if (!token) return;
    void bootstrap(parseRoute(location.hash, TABS.map(([id]) => id)));
    startLive();
  }, []);
  if (!token) return <EmptyState>Open the URL printed by `cohorte ui` — it carries this session’s token.</EmptyState>;
  return (
    <div className="layout">
      <Sidebar /><Main /><Pollers /><Router /><GlobalKeys /><TitleBadge /><Palette /><Shortcuts />
    </div>
  );
}
