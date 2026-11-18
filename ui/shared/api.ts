// The wire contract between `cohorte ui`'s server (server/*.ts) and its page (web/src). Types only.
// Strings that come from a project (titles, paths, report text) are DATA: the page renders them as text.

export type Tone = 'ok' | 'warn' | 'bad' | 'skip';
export type CheckStatus = 'ok' | 'warn' | 'bad' | 'skip';

export interface Summary { ok: number; warn: number; bad: number; skip: number }
export interface Check { id?: string; label: string; status: CheckStatus; detail: string; fix?: string }

export interface ProjectSummary {
  id: string; root: string; name: string; addedAt?: string;
  missing?: boolean; error?: string;
  title?: string; oneLiner?: string; summary?: Summary; specCounts?: Record<string, number>; specTotal?: number; core?: string | null;
}
export interface StateResponse { version: string; projects: ProjectSummary[] }
export interface Suggestion { name: string; root: string }
export interface DiscoverResponse { suggestions: Suggestion[] }

export type StageState = 'done' | 'current' | 'blocked' | 'skipped' | 'todo';
export interface PipelineStage { key: string; label: string; state: StageState }
export interface PipelineInfo {
  stages: PipelineStage[];
  /** The next /cohorte-* command a human would run for this spec, with why. `args` is the spec id. */
  next: { command: string; args: string; why: string } | null;
  verdict: { verdict: string; blocking: number | null; findings: number | null; security: number | null; deferred: number | null; ts: string | null } | null;
  loop: { outcome: string | null; reason: string | null } | null;
}
export interface SpecRecord { id: string; title: string; status: string; branch: string; kind?: string; tone?: string; file?: string; pipeline?: PipelineInfo; [k: string]: unknown }

export type JobStatus = 'starting' | 'running' | 'ready' | 'done' | 'failed' | 'stopped';
export interface JobView {
  id: string; kind: string; label: string; cwd: string; tag: string | null; command: string; status: JobStatus;
  pid: number | null; startedAt: string; endedAt: string | null; exitCode: number | null;
  lines?: string[]; cursor?: number;
  /** Local URLs a dev server printed (for the Open link). */
  urls: string[];
}

export interface Worktree { path: string; branch: string | null; head?: string; bare?: boolean; detached?: boolean; main: boolean; dev: JobView | null }

export interface ProjectDetail {
  id: string; root: string; name: string;
  doctor: { summary: Summary; checks: Check[]; profile?: { name?: string; one_liner?: string } | null; [k: string]: unknown };
  specs: SpecRecord[];
  worktrees: Worktree[];
  dev: { command: string | null; ready: string | null };
  isolation: { create: boolean; remove: boolean };
  docker: { file: string } | null;
  runs: RunView[];
}

export interface Finding { severity: string; file: string; line: number | null; category: string; problem: string; fix: string; outOfScope: string }
export interface FindingsReport { findings: Finding[]; deferred: Finding[]; verdict: string | null }
export interface SpecDetail {
  spec: SpecRecord; body: string; reports: Record<string, unknown>;
  pipeline: PipelineInfo;
  /** The review's findings parsed from specs/reports/<id>.md (empty when there is no report), plus that report's raw text. */
  review: FindingsReport & { raw: string };
}

export interface Command { name: string; description: string; argumentHint: string }

export type RunStatus = 'running' | 'done' | 'failed' | 'stopped';
export interface PendingQuestion { question: string; header: string; multiSelect: boolean; options: { label: string; description: string }[] }
export interface PendingItem { requestId: string; kind: 'permission' | 'question'; tool: string; summary?: string; reason?: string; via?: string; questions?: PendingQuestion[] }
export interface RunResult { ok: boolean; text: string; costUsd: number | null; durationMs: number | null; turns: number | null }
export type RunEvent =
  | { t: number; kind: 'text'; text: string }
  | { t: number; kind: 'tool'; id: string; name: string; summary: string }
  | { t: number; kind: 'tool_result'; id: string; error: boolean; text: string }
  | { t: number; kind: 'reply'; text: string }
  | { t: number; kind: 'resolved'; requestId: string; decision: 'allow' | 'deny' }
  | ({ t: number; kind: 'result' } & RunResult)
  | { t: number; kind: 'stderr' | 'system'; text: string }
  | { t: number; kind: 'approval'; requestId: string; tool: string; summary: string; reason: string; via: string }
  | { t: number; kind: 'question'; requestId: string; tool: string; questions: PendingQuestion[] };
export interface RunView {
  id: string; command: string; cwd: string; permissionMode: string; status: RunStatus; startedAt: string; endedAt: string | null;
  result: RunResult | null; sessionId: string | null; pending: PendingItem[]; events?: RunEvent[]; cursor?: number;
}

export interface DockerService { name: string; state: string; health: string; status: string; ports: string[]; image: string }
export interface DockerStatus {
  configured: boolean; file?: string;
  daemon?: { installed: boolean; up: boolean; version?: string; error?: string };
  services?: DockerService[]; running?: number; configError?: string | null; psError?: string;
}
export interface DockerPreflight { ok: boolean; reason: string; services: string[]; missing: string[]; daemonUp: boolean }

export interface MetricsResponse { totals?: { cost?: number; runs?: number; sessions?: number; agents?: number }; commands?: { command: string; runs: number; cost: number | { total: number } }[]; [k: string]: unknown }

// Error bodies
export interface ApiErrorBody {
  error: string; needsConfirmation?: boolean; command?: string; reason?: string;
  untrusted?: boolean; fix?: string; dockerDown?: boolean; dockerPreflight?: DockerPreflight;
}

// ---- git / PR ----
export interface GitInfo {
  branch: string | null; ahead: number; behind: number; upstream: string | null;
  modified: number; staged: number; untracked: number; conflicted: number; clean: boolean;
  base: string | null; lastCommit: { sha: string; subject: string; when: string } | null;
  diff: { files: number; insertions: number; deletions: number };
  error?: string;
}
export interface PullInfo { number: number; state: string; url: string; title: string; draft: boolean; review: string | null; checks: 'success' | 'failure' | 'pending' | null }
export interface GitResponse { worktrees: Record<string, GitInfo & { pull: PullInfo | null }>; gh: boolean }
export interface ChangedFile { path: string; status: string }
export interface FileDiff { file: string; status: string; diff: string; truncated: boolean }
export interface DiffListResponse { base: string | null; files: ChangedFile[] }

// ---- live updates & activity ----
/** One change notice on /api/stream. The page refetches the item it names (with its cursor); nothing sensitive rides here. */
export interface StreamEvent { type: 'job' | 'run'; projectId: string; id: string; status: string; pending?: number }
export interface ActivityItem { projectId: string; projectName: string; kind: 'dev' | 'job' | 'run' | 'docker'; id: string; label: string; status: string; pending: number; startedAt: string }
export interface ActivityResponse { items: ActivityItem[] }
