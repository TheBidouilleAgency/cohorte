import { Bell, BellOff, HelpCircle, Search } from 'lucide-react';
import { useApp } from '../../store/app';
import { useLive } from '../../store/live';
import { useUi } from '../../store/ui';
import { ThemeToggle } from './Theme';

const LIVE_TEXT = { connecting: 'connecting', live: 'live', reconnecting: 'reconnecting', polling: 'polling' } as const;
const LIVE_TIP = {
  connecting: 'Connecting to the live update stream', live: 'Live: changes are pushed as they happen',
  reconnecting: 'The live stream dropped — reconnecting', polling: 'Live stream unavailable — refreshing on a timer',
} as const;

/** Browser notifications are opt-in; permission is only requested from this click. */
async function toggleNotify(): Promise<void> {
  const { notify, setNotify } = useUi.getState();
  if (notify) { setNotify(false); return; }
  try {
    if (typeof Notification === 'undefined') { useApp.getState().setError('This browser has no notification support.'); return; }
    const perm = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
    if (perm === 'granted') setNotify(true);
    else useApp.getState().setError('Notifications are blocked for this page — allow them in the browser’s site settings.');
  } catch { useApp.getState().setError('Could not enable notifications here.'); }
}

export function Topbar() {
  const status = useLive((s) => s.status);
  const { notify, setPalette, setHelp } = useUi();
  return (
    <div className="topbar">
      <span className={`live live-${status}`} title={LIVE_TIP[status]} role="status"><span className="live-dot" aria-hidden="true" />{LIVE_TEXT[status]}</span>
      <button type="button" className="btn icon" onClick={() => setPalette(true)} aria-label="Open the command palette" title="Command palette (Ctrl/⌘ K)"><Search size={14} /><span className="kbd">⌘K</span></button>
      <button type="button" className="btn icon" onClick={() => void toggleNotify()} aria-pressed={notify} aria-label={notify ? 'Turn notifications off' : 'Turn notifications on'} title={notify ? 'Notifications on: runs that need you or finish while this tab is hidden' : 'Notify me when a run needs me or finishes'}>
        {notify ? <Bell size={14} /> : <BellOff size={14} />}
      </button>
      <button type="button" className="btn icon" onClick={() => setHelp(true)} aria-label="Keyboard shortcuts" title="Keyboard shortcuts (?)"><HelpCircle size={14} /></button>
      <ThemeToggle />
    </div>
  );
}
