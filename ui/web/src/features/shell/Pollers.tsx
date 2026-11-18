import { usePoll } from '../../lib/usePoll';
import { LIVE, useJobs } from '../../store/jobs';
import { useApp } from '../../store/app';
import { isLive, useLive } from '../../store/live';

/** Background polling of the watched job's log (only while a job-bearing tab is open and the live stream is not delivering). */
export function Pollers() {
  const tab = useApp((s) => s.tab);
  const job = useJobs((s) => s.job);
  const live = isLive(useLive((s) => s.status));
  usePoll(() => useJobs.getState().poll(), 1200, !!job && (tab === 'worktrees' || tab === 'docker') && LIVE.includes(job.status) && !live, `${job?.id}:${job?.status}`);
  return null;
}
