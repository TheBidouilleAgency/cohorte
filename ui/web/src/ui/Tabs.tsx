import { useRef, type KeyboardEvent } from 'react';

export interface TabDef<T extends string> { id: T; label: string }

export function Tabs<T extends string>({ tabs, value, onChange, label }: { tabs: readonly TabDef<T>[]; value: T; onChange: (t: T) => void; label: string }) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const onKey = (e: KeyboardEvent, i: number) => {
    const next = e.key === 'ArrowRight' ? i + 1 : e.key === 'ArrowLeft' ? i - 1 : -1;
    if (next < 0) return;
    const j = (next + tabs.length) % tabs.length;
    refs.current[j]?.focus();
    onChange(tabs[j].id);
  };
  return (
    <div className="tabs" role="tablist" aria-label={label}>
      {tabs.map((t, i) => (
        <button key={t.id} ref={(el) => { refs.current[i] = el; }} type="button" role="tab" id={`tab-${t.id}`} aria-selected={t.id === value}
          aria-controls="tabpanel" tabIndex={t.id === value ? 0 : -1} className={`tab${t.id === value ? ' sel' : ''}`}
          onClick={() => onChange(t.id)} onKeyDown={(e) => onKey(e, i)}>{t.label}</button>
      ))}
    </div>
  );
}
