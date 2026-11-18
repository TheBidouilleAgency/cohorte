import { create } from 'zustand';

const read = (k: string): string | null => { try { return localStorage.getItem(k); } catch { return null; } };
const write = (k: string, v: string): void => { try { localStorage.setItem(k, v); } catch { /* storage blocked */ } };

export type SpecView = 'list' | 'board';
export const useUi = create<{
  paletteOpen: boolean; helpOpen: boolean; specView: SpecView; notify: boolean;
  setPalette: (v: boolean) => void; setHelp: (v: boolean) => void; setSpecView: (v: SpecView) => void; setNotify: (v: boolean) => void;
}>((set) => ({
  paletteOpen: false, helpOpen: false,
  specView: read('cohorte-spec-view') === 'board' ? 'board' : 'list',
  notify: read('cohorte-notify') === '1',
  setPalette: (paletteOpen) => set({ paletteOpen }),
  setHelp: (helpOpen) => set({ helpOpen }),
  setSpecView: (specView) => { write('cohorte-spec-view', specView); set({ specView }); },
  setNotify: (notify) => { write('cohorte-notify', notify ? '1' : '0'); set({ notify }); },
}));
