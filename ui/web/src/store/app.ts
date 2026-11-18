import { create } from 'zustand';
import type { ProjectDetail, ProjectSummary, Suggestion } from '../../../shared/api';
import { api, errorMessage } from '../api/client';

/** Registry of tabs: add one entry (and a component in features/shell/Tabs) to add a tab. */
export const TABS = [
  ['overview', 'Overview'], ['health', 'Health'], ['specs', 'Specs'], ['run', 'Run'],
  ['worktrees', 'Worktrees'], ['docker', 'Docker'], ['cost', 'Cost'],
] as const;
export type TabId = (typeof TABS)[number][0];

interface AppState {
  version: string; projects: ProjectSummary[]; suggestions: Suggestion[];
  sel: string | null; tab: TabId; detail: ProjectDetail | null; error: string | null; busy: boolean;
  /** Runs `fn` with the busy flag and error banner, like the old page's guard(). */
  guard: (fn: () => Promise<void>) => Promise<void>;
  refresh: () => Promise<void>;
  loadDetail: () => Promise<void>;
  /** Re-reads the detail without blanking the page (live updates, job/run status changes). */
  reloadDetail: () => Promise<void>;
  /** guard + reload the project's detail afterwards. */
  act: (fn: () => Promise<void>) => Promise<void>;
  setError: (message: string | null) => void;
  setTab: (t: TabId) => void;
}

/** Subscribers (tab stores) reset themselves when the selected project changes. */
const resetters: (() => void)[] = [];
export const onProjectChange = (fn: () => void): void => { resetters.push(fn); };

export const useApp = create<AppState>((set, get) => ({
  version: '', projects: [], suggestions: [], sel: null, tab: 'overview', detail: null, error: null, busy: false,
  async guard(fn) {
    set({ busy: true });
    try { await fn(); set({ error: null }); } catch (e) { set({ error: errorMessage(e) }); }
    set({ busy: false });
  },
  async refresh() {
    const [st, dis] = await Promise.all([api.state(), api.discover()]);
    let sel = get().sel;
    if (sel && !st.projects.some((p) => p.id === sel)) sel = null;
    set({ projects: st.projects, version: st.version, suggestions: dis.suggestions, sel });
  },
  async loadDetail() {
    const id = get().sel;
    set({ detail: null });
    if (!id) return;
    try { const d = await api.project(id); if (get().sel === id) set({ detail: d, error: null }); } catch (e) { set({ error: errorMessage(e) }); }
  },
  async reloadDetail() {
    const id = get().sel;
    if (!id) return;
    try { const d = await api.project(id); if (get().sel === id) set({ detail: d }); } catch (e) { set({ error: errorMessage(e) }); }
  },
  async act(fn) { await get().guard(async () => { await fn(); await get().reloadDetail(); }); },
  setError: (error) => set({ error }),
  setTab: (tab) => set({ tab }),
}));

const switchProject = (id: string | null, tab: TabId = 'overview') => {
  resetters.forEach((r) => r());
  useApp.setState({ sel: id, tab, detail: null });
};

export const isTab = (t: string | null | undefined): t is TabId => !!t && TABS.some(([id]) => id === t);
export const selectProject = (id: string, tab: TabId = 'overview') => useApp.getState().guard(async () => { switchProject(id, tab); await useApp.getState().loadDetail(); });
/** Home: no project selected — the cross-project overview and activity. */
export const goHome = () => { if (useApp.getState().sel !== null) switchProject(null); };
export const addProject = (path: string) => useApp.getState().guard(async () => {
  const r = await api.addProject(path);
  await useApp.getState().refresh();
  switchProject(r.project.id);
  await useApp.getState().loadDetail();
});
export const removeProject = (id: string) => useApp.getState().guard(async () => {
  await api.removeProject(id);
  switchProject(null);
  await useApp.getState().refresh();
});
/** First load: the project list, then whatever the address bar asks for (`#/p/<id>/<tab>`), else Home. */
export const bootstrap = (route: { projectId: string | null; tab: string | null }) => useApp.getState().guard(async () => {
  await useApp.getState().refresh();
  const { projects } = useApp.getState();
  if (route.projectId && projects.some((p) => p.id === route.projectId)) {
    switchProject(route.projectId, isTab(route.tab) ? route.tab : 'overview');
    await useApp.getState().loadDetail();
  }
});
