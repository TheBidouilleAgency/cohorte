import { useEffect } from 'react';
import { SHORTCUTS } from '../../lib/keys';
import { useUi } from '../../store/ui';
import { Button } from '../../ui/primitives';

export function Shortcuts() {
  const open = useUi((s) => s.helpOpen);
  const setOpen = useUi((s) => s.setHelp);
  useEffect(() => {
    if (!open) return undefined;
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [open, setOpen]);
  if (!open) return null;
  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) setOpen(false); }}>
      <div className="dialog" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts">
        <h2>Keyboard shortcuts</h2>
        <dl className="shortcuts">{SHORTCUTS.map(([k, v]) => <div key={k}><dt className="kbd">{k}</dt><dd>{v}</dd></div>)}</dl>
        <Button onClick={() => setOpen(false)}>Close</Button>
      </div>
    </div>
  );
}
