import { useEffect, useRef } from 'react';
import { LIVE, stopJob, useJobs } from '../../store/jobs';
import { Button, Muted, SectionTitle } from '../../ui/primitives';

/** The log pane of the watched job (worktree scripts, dev servers, docker commands). `only` limits it to jobs whose label matches. */
export function JobPanel({ only }: { only?: RegExp }) {
  const job = useJobs((s) => s.job);
  const ref = useRef<HTMLPreElement>(null);
  useEffect(() => { const el = ref.current; if (el) el.scrollTop = el.scrollHeight; }, [job?.lines.length]);
  if (!job || (only && !only.test(job.label))) return null;
  return (
    <>
      <SectionTitle>{job.label} · <span aria-live="polite">{job.status}</span>{LIVE.includes(job.status) ? <> <Button onClick={() => void stopJob(job.id)}>Stop</Button></> : null}</SectionTitle>
      <Muted mono>{job.command}</Muted>
      <pre ref={ref} className="pre pre-max" aria-label="Job output">{job.lines.join('\n')}</pre>
    </>
  );
}

