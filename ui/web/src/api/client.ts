import type {
  ActivityResponse, ApiErrorBody, DiffListResponse, FileDiff, GitResponse, Command, DiscoverResponse, DockerStatus, JobView, MetricsResponse, ProjectDetail,
  ProjectSummary, RunView, SpecDetail, StateResponse,
} from '../../../shared/api';
import { readToken } from '../lib/token';

export const token: string | null = readToken();

/** An HTTP error from the server, with the structured body it answered (gate asks, untrusted folder, docker pre-check…). */
export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly body: Partial<ApiErrorBody>) { super(message); }
}

interface Opts { method?: 'GET' | 'POST' | 'DELETE'; body?: unknown }

async function request<T>(path: string, opts: Opts = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: opts.method ?? 'GET',
    headers: { Authorization: `Bearer ${token}`, ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new ApiError(String(data.error ?? `HTTP ${res.status}`), res.status, data as Partial<ApiErrorBody>);
  return data as T;
}
const post = <T>(path: string, body: unknown = {}) => request<T>(path, { method: 'POST', body });

export const api = {
  state: () => request<StateResponse>('/state'),
  discover: () => request<DiscoverResponse>('/discover'),
  commands: () => request<{ commands: Command[] }>('/commands'),
  addProject: (path: string) => post<{ project: ProjectSummary; created: boolean }>('/projects', { path }),
  removeProject: (id: string) => request<{ removed: boolean }>(`/projects/${id}`, { method: 'DELETE' }),
  project: (id: string) => request<ProjectDetail>(`/projects/${id}`),
  spec: (id: string, spec: string) => request<SpecDetail>(`/projects/${id}/specs/${encodeURIComponent(spec)}`),
  git: (id: string) => request<GitResponse>(`/projects/${id}/git`),
  diffList: (id: string, worktree: string) => request<DiffListResponse>(`/projects/${id}/diff?worktree=${encodeURIComponent(worktree)}`),
  fileDiff: (id: string, worktree: string, file: string) => request<FileDiff>(`/projects/${id}/diff?worktree=${encodeURIComponent(worktree)}&file=${encodeURIComponent(file)}`),
  activity: () => request<ActivityResponse>('/activity'),
  metrics: (id: string) => request<MetricsResponse>(`/projects/${id}/metrics`),
  docker: (id: string) => request<DockerStatus>(`/projects/${id}/docker`),
  dockerAct: (id: string, body: { action: string; service?: string; confirmed?: boolean }) => post<{ job: JobView }>(`/projects/${id}/docker`, body),
  startDev: (id: string, body: { worktree: string; confirmed?: boolean }) => post<{ job: JobView }>(`/projects/${id}/dev`, body),
  createWorktree: (id: string, body: { feature: string; confirmed?: boolean; skipDockerCheck?: boolean }) => post<{ job: JobView }>(`/projects/${id}/worktrees`, body),
  removeWorktree: (id: string, body: { path: string; confirmed?: boolean }) => post<{ job: JobView }>(`/projects/${id}/worktrees/remove`, body),
  jobLogs: (id: string, job: string, since: number) => request<JobView>(`/projects/${id}/jobs/${job}/logs?since=${since}`),
  stopJob: (id: string, job: string) => post<{ stopped: boolean }>(`/projects/${id}/jobs/${job}/stop`),
  startRun: (id: string, body: Record<string, unknown>) => post<{ run: RunView }>(`/projects/${id}/runs`, body),
  run: (id: string, run: string, since: number) => request<RunView>(`/projects/${id}/runs/${run}?since=${since}`),
  stopRun: (id: string, run: string) => post<{ stopped: boolean }>(`/projects/${id}/runs/${run}/stop`),
  reply: (id: string, run: string, text: string) => post<{ run: RunView }>(`/projects/${id}/runs/${run}/reply`, { text }),
  respond: (id: string, run: string, body: { requestId: string; behavior: 'allow' | 'deny'; answers?: Record<string, string[]> }) =>
    post<{ ok: boolean }>(`/projects/${id}/runs/${run}/respond`, body),
};

export const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));
