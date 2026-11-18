import type { PipelineInfo } from '../../../../shared/api';
import { Pill, type PillTone } from '../../ui/primitives';

const tone = (v: string, blocking: number | null): PillTone => (v === 'SHIP' && !blocking ? 'ok' : v === 'BLOCK' ? 'bad' : v === 'REVISE' ? 'warn' : '');

/** `REVISE · 1 blocking / 7` — the review verdict in one chip. */
export function Verdict({ v }: { v: PipelineInfo['verdict'] }) {
  if (!v) return null;
  const counts = v.findings != null ? ` · ${v.blocking ?? 0} blocking / ${v.findings}` : '';
  return <Pill tone={tone(v.verdict, v.blocking)}>{`${v.verdict || 'no verdict'}${counts}`}</Pill>;
}
