import { useEffect, useRef } from 'react';

/** Calls `fn` every `ms` while `enabled`. `fn` returns false to stop polling. Calls never overlap. */
export function usePoll(fn: () => Promise<boolean | void>, ms: number, enabled: boolean, key: unknown): void {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    if (!enabled) return undefined;
    let dead = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      let again = true;
      try { again = (await ref.current()) !== false; } catch { /* the next tick retries */ }
      if (!dead && again) timer = setTimeout(tick, ms);
    };
    timer = setTimeout(tick, ms);
    return () => { dead = true; clearTimeout(timer); };
  }, [ms, enabled, key]);
}
