import type {
  ActivityResponse, ApiErrorBody, DiffListResponse, FileDiff, GitResponse, Command, DiscoverResponse, DockerStatus, JobView, MetricsResponse, ProjectDetail,
  ProjectSummary, RunView, SpecDetail, StateResponse, TicketsResponse, Ticket, FeaturesResponse, FeatureDetail, FeatureView, SettingsResponse,
  ProjectSettings, InboxResponse, LearningResponse, TrackerInfo, FoundingView, NewProjectBody, RemoteInfo, IdentityInfo, IdentityBody,
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

  // company flow
  inbox: () => request<InboxResponse>('/inbox'),
  tickets: (id: string) => request<TicketsResponse>(`/projects/${id}/tickets`),
  createTicket: (id: string, body: { title: string; type: string; need: string; criteria: string[] }) => post<{ ticket: Ticket }>(`/projects/${id}/tickets`, body),
  decideTicket: (id: string, t: string, action: 'validate' | 'reject') => post<{ ticket: Ticket }>(`/projects/${id}/tickets/${t}/decide`, { action }),
  takeTicket: (id: string, t: string, body: { confirmed?: boolean; skipDockerCheck?: boolean } = {}) => post<{ feature: FeatureView }>(`/projects/${id}/tickets/${t}/take`, body),
  adopt: (id: string, spec: string) => post<{ feature: FeatureView }>(`/projects/${id}/adopt`, { id: spec }),
  acceptance: (id: string, t: string, body: { action: 'accept' | 'not-quite'; text?: string }) => post<{ ticket: Ticket; run: RunView | null }>(`/projects/${id}/tickets/${t}/acceptance`, body),
  startPO: (id: string, body: { text: string; requester?: string; parent?: string }) => post<{ run: RunView }>(`/projects/${id}/po`, body),
  features: (id: string) => request<FeaturesResponse>(`/projects/${id}/features`),
  feature: (id: string, f: string) => request<FeatureDetail>(`/projects/${id}/features/${f}`),
  checkpoint: (id: string, f: string, body: { action: string; text?: string }) => post<{ feature: FeatureView }>(`/projects/${id}/features/${f}/checkpoint`, body),
  replyLead: (id: string, f: string, text: string) => post<{ ok: boolean }>(`/projects/${id}/features/${f}/lead`, { text }),
  merge: (id: string, f: string) => post<{ job: JobView }>(`/projects/${id}/features/${f}/merge`),
  contest: (id: string, f: string, d: string, note: string) => post<{ feature: FeatureView }>(`/projects/${id}/features/${f}/decisions/${d}/contest`, { note }),
  settings: (id: string) => request<SettingsResponse>(`/projects/${id}/settings`),
  saveSettings: (id: string, body: Partial<ProjectSettings>) => post<SettingsResponse>(`/projects/${id}/settings`, body),
  connectObsidian: (id: string, body: { vault: string; board?: string }) => post<{ created: boolean; board: string; migrated: number; tracker: TrackerInfo }>(`/projects/${id}/tracker`, body),
  productMap: (id: string) => post<{ run: RunView }>(`/projects/${id}/product-map`),
  newProject: (body: NewProjectBody) => post<{ project: ProjectSummary; founding: FoundingView }>('/founding', body),
  founding: (id: string) => request<FoundingView>(`/projects/${id}/founding`),
  foundingReply: (id: string, text: string) => post<FoundingView>(`/projects/${id}/founding/reply`, { text }),
  foundingCheckpoint: (id: string, body: { action: string; text?: string }) => post<FoundingView>(`/projects/${id}/founding/checkpoint`, body),
  foundingIdentity: (id: string) => request<IdentityInfo>(`/projects/${id}/founding/identity`),
  setFoundingIdentity: (id: string, body: IdentityBody) => post<FoundingView>(`/projects/${id}/founding/identity`, body),
  remote: (id: string) => request<RemoteInfo>(`/projects/${id}/remote`),
  connectRemote: (id: string, body: { kind: 'github' | 'url'; name?: string; visibility?: string; url?: string }) => post<{ job: JobView }>(`/projects/${id}/remote`, body),
  learning: (id: string) => request<LearningResponse>(`/projects/${id}/learning`),
};

export const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));
