import { useEffect } from 'react';
import type { DockerService, ProjectDetail } from '../../../../shared/api';
import { usePoll } from '../../lib/usePoll';
import { useApp } from '../../store/app';
import { dockerAct, useDocker } from '../../store/docker';
import { LIVE, useJobs } from '../../store/jobs';
import { Button, Card, Cards, Dot, EmptyState, ErrorText, Muted, Pill, Table, type PillTone } from '../../ui/primitives';
import { JobPanel } from '../worktrees/JobPanel';

const STATE_TONE: Record<string, PillTone> = { running: 'ok', exited: 'warn', dead: 'bad', restarting: 'warn' };
const healthTone = (h: string): PillTone => (h === 'healthy' ? 'ok' : h === 'unhealthy' ? 'bad' : 'warn');

function ServiceRow({ v, up, busy }: { v: DockerService; up: boolean; busy: boolean }) {
  return (
    <tr>
      <td className="mono">{v.name}</td>
      <td><Pill tone={STATE_TONE[v.state] ?? ''}>{v.state}</Pill>{v.health ? <> <Pill tone={healthTone(v.health)}>{v.health}</Pill></> : null}</td>
      <td className="mono">{v.ports.join(', ')}</td>
      <td className="muted">{v.status}</td>
      <td><div className="actions">{up ? <>
        {v.state === 'running' ? <Button disabled={busy} onClick={() => void dockerAct('stop', v.name)}>Stop</Button> : <Button disabled={busy} onClick={() => void dockerAct('up', v.name)}>Start</Button>}
        <Button disabled={busy} onClick={() => void dockerAct('restart', v.name)}>Restart</Button>
        <Button onClick={() => void dockerAct('logs', v.name)}>Logs</Button>
      </> : null}</div></td>
    </tr>
  );
}

export function Docker({ d }: { d: ProjectDetail }) {
  const docker = useDocker((s) => s.docker);
  const job = useJobs((s) => s.job);
  const tab = useApp((s) => s.tab);
  useEffect(() => { void useDocker.getState().load(); }, []);
  usePoll(async () => { await useDocker.getState().load(); }, 4000, tab === 'docker', 'docker');
  if (!d.docker) return <EmptyState>No compose file here. Declare isolation.compose_file in PIPELINE.md, or add a docker-compose.yml at the repo root.</EmptyState>;
  if (!docker) return <EmptyState>Loading…</EmptyState>;
  if ('error' in docker && typeof docker.error === 'string') return <ErrorText>{docker.error}</ErrorText>;
  const k = docker as Exclude<typeof docker, { error: string }>;
  const dm = k.daemon;
  const services = k.services ?? [];
  const up = !!dm?.up;
  const busy = !!job && LIVE.includes(job.status) && /^docker/.test(job.label);
  const off = !up || busy;
  return (
    <div>
      <Cards>
        <Card><div className="stat-v"><Dot tone={up ? 'ok' : 'bad'} /> {up ? 'Docker up' : 'Docker down'}</div><div className="muted">{up ? `engine ${dm?.version ?? ''}` : dm?.error}</div></Card>
        <Card><div className="stat-v">{`${k.running ?? 0}/${services.length}`}</div><div className="muted">services running</div></Card>
        <Card><div className="stat-v mono small">{k.file}</div><div className="muted">compose file</div></Card>
      </Cards>
      {k.configError ? <ErrorText>{`compose: ${k.configError}`}</ErrorText> : null}
      {!up ? <Muted>Start Docker Desktop (or the docker service). scripts/new-feature.sh needs it to create a worktree’s database.</Muted> : null}
      <div className="toolbar">
        <Button disabled={off} onClick={() => void dockerAct('up')}>Start stack</Button>
        <Button disabled={off} onClick={() => void dockerAct('restart')}>Restart all</Button>
        <Button disabled={off} onClick={() => void dockerAct('stop')}>Stop all</Button>
        <Button disabled={off} onClick={() => void dockerAct('down')}>Down (keeps volumes)</Button>
      </div>
      <Table head={['Service', 'State', 'Ports', 'Status', '']}>
        {services.map((v) => <ServiceRow key={v.name} v={v} up={up} busy={busy} />)}
      </Table>
      <JobPanel only={/^docker/} />
    </div>
  );
}
