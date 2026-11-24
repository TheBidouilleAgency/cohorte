// The wire contract between `cohorte ui`'s server (server/*.ts) and its page (web/src). Types only.
// Strings that come from a project (titles, paths, report text) are DATA: the page renders them as text.

export type Tone = 'ok' | 'warn' | 'bad' | 'skip';
export type CheckStatus = 'ok' | 'warn' | 'bad' | 'skip';

export interface Summary { ok: number; warn: number; bad: number; skip: number }
export interface Check { id?: string; label: string; status: CheckStatus; detail: string; fix?: string }

export interface ProjectSummary {
  id: string; root: string; name: string; addedAt?: string;
  missing?: boolean; error?: string;
  /** Set while the project is being founded from cohorte ui (New project) — the Founding page replaces the tabs. */
  founding?: FoundingPhase | null;
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
/** The decider's read of a question it did not settle alone: what it would pick, and why it handed it to you. */
export interface DecisionAdvice { choice: string | null; rationale: string; agreement: number; category: string; escalated: string }
export interface PendingItem {
  requestId: string; kind: 'permission' | 'question'; tool: string; summary?: string; reason?: string; via?: string; questions?: PendingQuestion[];
  /** The decider is working on it — not yours yet. */
  deciding?: boolean; advice?: DecisionAdvice;
}
export interface RunResult { ok: boolean; text: string; costUsd: number | null; durationMs: number | null; turns: number | null }
export type RunEvent =
  // `sub`: said or done by a subagent the run dispatched (the stream's parent_tool_use_id) — not the run's own words.
  | { t: number; kind: 'text'; text: string; sub?: true }
  | { t: number; kind: 'tool'; id: string; name: string; summary: string; sub?: true }
  | { t: number; kind: 'tool_result'; id: string; error: boolean; text: string; sub?: true }
  | { t: number; kind: 'reply'; text: string }
  | { t: number; kind: 'resolved'; requestId: string; decision: 'allow' | 'deny' }
  | ({ t: number; kind: 'result' } & RunResult)
  | { t: number; kind: 'stderr' | 'system'; text: string }
  | { t: number; kind: 'approval'; requestId: string; tool: string; summary: string; reason: string; via: string }
  | { t: number; kind: 'question'; requestId: string; tool: string; questions: PendingQuestion[] };
/** What a run is for. `command` is a human-started /cohorte-* run (the Run tab); the others belong to the company flow. */
export type RunRole = 'command' | 'po' | 'lead' | 'stage' | 'acceptance' | 'product-map' | 'vision' | 'foundation' | 'scaffold' | 'setup';
export interface RunMeta { role: RunRole; featureId?: string; ticketId?: string; stage?: string; title?: string }
export interface RunView {
  id: string; command: string; cwd: string; permissionMode: string; status: RunStatus; startedAt: string; endedAt: string | null;
  result: RunResult | null; sessionId: string | null; pending: PendingItem[]; events?: RunEvent[]; cursor?: number;
  meta?: RunMeta; model?: string | null;
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
  /** POST /projects: the folder is a repo that does not use cohorte yet — the dashboard can set it up (New project → existing). */
  notCohorte?: boolean;
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
export interface StreamEvent { type: 'job' | 'run' | 'flow'; projectId: string; id: string; status: string; pending?: number }
export interface ActivityItem { projectId: string; projectName: string; kind: 'dev' | 'job' | 'run' | 'docker'; id: string; label: string; status: string; pending: number; startedAt: string }
export interface ActivityResponse { items: ActivityItem[] }

// ---- company flow: tickets (business) → features (lead + autopilot) → PR → acceptance ----

export type TicketType = 'feature' | 'bug' | 'tech';
/** One per board column of the company layout (profile/schema/kanban.md), plus `rejected`. */
export type TicketStatus = 'discussion' | 'validate' | 'backlog' | 'framing' | 'building' | 'checkpoint' | 'pr' | 'acceptance' | 'done' | 'rejected';
export type Priority = 'high' | 'medium' | 'low';
export type Size = 'S' | 'M' | 'L' | '?';
export interface AcceptanceNote { summary: string; changes: string[]; howToTest: string[]; outOfScope: string[]; at: string }
export interface Ticket {
  id: string; title: string; type: TicketType; status: TicketStatus; requester: string; priority: Priority; size: Size;
  created: string; updated: string; parent: string | null; pr: string | null; conversation: string | null;
  need: string; value: string; criteria: string[]; outOfScope: string[]; notes: string;
  acceptance: AcceptanceNote | null; feedback: string[];
}
/** A ticket as the PO agent proposes it, in a ```cohorte-ticket``` block. `ref` is stable across revisions in one conversation. */
export interface TicketProposal {
  ref: string; title: string; type: TicketType; need: string; value: string; criteria: string[]; outOfScope: string[];
  priority: Priority; size: Size; parent?: string | null;
}
export interface TrackerInfo { kind: 'obsidian' | 'local'; dir: string; board: string | null; reason: string; projectName: string | null }
export interface ConversationView {
  runId: string; role: 'po' | 'lead'; title: string; status: RunStatus; startedAt: string; ticketId: string | null;
  /** ref → ticket id: the draft tickets this conversation created (CP0 validates them). */
  tickets: Record<string, string>; pending: number;
}
export interface TicketsResponse { tracker: TrackerInfo; tickets: Ticket[]; conversations: ConversationView[]; adoptable?: AdoptableSpec[] }

/** The lead's plan, from its ```cohorte-plan``` block — what CP1 asks you to validate. */
export interface Plan {
  summary: string; criteria: { id: string; text: string }[]; contract: string;
  surfaces: { key: string; tasks: string[] }[]; risks: string[]; assumptions: string[]; questions: string[]; size: Size;
}

export type FeaturePhase =
  | 'provisioning' | 'framing' | 'cp1' | 'freezing' | 'autopilot' | 'cp2' | 'cp3'
  | 'shipping' | 'pr' | 'merging' | 'closing' | 'acceptance' | 'done' | 'abandoned' | 'failed';
export type CheckpointKind = 'cp1' | 'cp2' | 'cp3';
export interface Checkpoint { kind: CheckpointKind; reason: string; openedAt: string }
export interface StageRecord { stage: string; runId: string; model: string; status: RunStatus; costUsd: number | null; startedAt: string; endedAt: string | null; note?: string }
/** `recommendation`: a reversible choice nothing written settles — the asking agent's own recommended option was taken. */
export interface DecisionSource { kind: 'spec' | 'decision' | 'convention' | 'preference' | 'code' | 'plan' | 'recommendation' | 'none'; ref: string; quote: string }
export interface DecisionRecord {
  id: string; at: string; runId: string; stage: string; question: string; header: string; options: string[]; chosen: string;
  /** `remote`: answered from another process than the one running the stage (the page for a terminal's run, a terminal
   *  for the page's), or a checkpoint relayed from a Claude Code session — someone did, but not provably the developer
   *  at the run's own screen: listed at CP3 with the decider's, never learned as a preference. */
  by: 'decider' | 'human' | 'remote'; agreement: number | null; category: string | null; source: DecisionSource | null; rationale: string;
  contested: { at: string; note: string } | null; confirmed: boolean;
}
export interface Correction { at: string; checkpoint: CheckpointKind | 'pr'; text: string }
export interface FeatureView {
  id: string; projectId: string; ticketId: string; title: string; worktree: string | null; branch: string | null;
  phase: FeaturePhase; checkpoint: Checkpoint | null; leadRunId: string | null; currentRunId: string | null;
  stages: StageRecord[]; rounds: number; decisions: DecisionRecord[]; corrections: Correction[];
  pr: { number: number; url: string; state: string; checks: PullInfo['checks'] } | null; plan: Plan | null;
  error: string | null; warning: string | null; createdAt: string; updatedAt: string; costUsd: number;
  /** The process with a run of this feature in flight — `cohorte ui`, or a `cohorte` verb in a terminal. Absent when idle. */
  driver?: FeatureDriver | null;
}
export interface FeatureDriver { pid: number; start?: number | null; by: 'ui' | 'cli'; at: string }
/** A spec written outside the flow (a plain Claude Code session) that no feature record follows yet. */
export interface AdoptableSpec { id: string; title: string; status: string | null; worktree: string | null; branch: string | null; ticket: boolean }
export interface FeatureDetail extends FeatureView {
  pipeline: PipelineInfo | null; ticket: Ticket | null;
  /** CP3 material: what a human signs off. */
  review: { verdict: string | null; findings: Finding[]; deferred: Finding[] } | null;
  dod: { text: string; done: boolean }[]; assumptions: string[]; diff: { files: number; insertions: number; deletions: number } | null;
}
export interface FeaturesResponse { features: FeatureView[] }

export type Autonomy = 'prudent' | 'balanced' | 'autonomous';
export type ModelRole = 'po' | 'lead' | 'build' | 'implementer' | 'review' | 'fix' | 'verify' | 'ship' | 'learn' | 'acceptance' | 'productMap' | 'scaffold' | 'setup' | 'decider' | 'deciderEscalation';
export interface ProjectSettings {
  autonomy: Autonomy; models: Record<ModelRole, string>; deciderVotes: number; maxRounds: number;
  mergeMethod: 'squash' | 'merge' | 'rebase'; autopilot: boolean; requester: string;
}
export interface SettingsResponse { settings: ProjectSettings; defaults: ProjectSettings; tracker: TrackerInfo; productMap: { exists: boolean; updated: string | null } }

export type InboxKind = 'cp0' | 'cp1' | 'cp2' | 'cp3' | 'cp4' | 'question' | 'permission' | 'pr' | 'founding';
/** `ref` is the ticket id (cp0, cp4), the feature id (cp1–cp3, pr) or the run id (question, permission); `feature` names the feature when there is one. */
export interface InboxItem { projectId: string; projectName: string; kind: InboxKind; ref: string; feature: string | null; title: string; detail: string; at: string }
export interface InboxResponse { items: InboxItem[] }
export interface LearningResponse {
  decisions: { total: number; byDecider: number; contested: number; confirmed: number };
  preferences: number; stages: { stage: string; model: string; runs: number; ok: number; costUsd: number }[];
}

// ---- Founding a new project (New project in cohorte ui) ----

/** The PO's vision of a product that does not exist yet, from its ```cohorte-vision``` block — what the Vision checkpoint validates. */
export interface Vision {
  name: string; pitch: string; users: string[]; problem: string; today: string; firstVersion: string[]; later: string[];
  success: string; constraints: string[]; language: string;
}
export interface FoundationSurface { key: string; path: string; stack: string; generate: string | null; packageManager: string; test: string; lint: string; build: string }
/** The lead's foundations plan, from its ```cohorte-foundation``` block — what the Foundations checkpoint validates. */
export interface Foundation {
  summary: string; surfaces: FoundationSurface[]; data: string; auth: string; hosting: string; devCommand: string; ci: string;
  basedOn: string | null; conventions: string[]; skeleton: string; decisions: string[]; assumptions: string[]; questions: string[];
}
/** The scaffold's report, from its ```cohorte-scaffold``` block. */
export interface ScaffoldReport {
  status: 'ok' | 'failed'; surfaces: { key: string; path: string; test: string; lint: string; build: string; ok: boolean }[];
  devCommand: string; checks: { command: string; ok: boolean; note: string }[]; assumptions: string[]; notes: string;
}
/**
 * vision → cp-vision → foundation → cp-foundation → scaffold (→ cp-scaffold on a failure) → setup → done.
 * A developer who knows what to build starts at `foundation`; an existing folder without cohorte starts at `setup`.
 */
export type FoundingPhase = 'vision' | 'cp-vision' | 'foundation' | 'cp-foundation' | 'scaffold' | 'cp-scaffold' | 'setup' | 'done' | 'abandoned';
export type FoundingMode = 'idea' | 'stack' | 'existing';
export interface FoundingStage { stage: 'vision' | 'foundation' | 'scaffold' | 'setup'; runId: string; model: string; status: RunStatus; costUsd: number | null; startedAt: string; endedAt: string | null }
export interface FoundingView {
  projectId: string; root: string; name: string; mode: FoundingMode; phase: FoundingPhase; brief: string; basedOn: string | null; requester: string;
  vision: Vision | null; tickets: TicketProposal[]; foundation: Foundation | null; scaffold: ScaffoldReport | null;
  currentRunId: string | null; stages: FoundingStage[]; error: string | null; warning: string | null; createdAt: string; updatedAt: string; costUsd: number;
  /** Who cohorte's commits in this folder would be authored by — `null` once the founding is over. Not `ok` ⇒ nothing is committed until it is set. */
  identity: GitIdentity | null;
}
/** The git identity a commit in a repository would carry (lib/identity.js). `missing`: git would invent `<os user>@<hostname>`. */
export interface GitIdentity {
  name: string; email: string; nameOrigin: string; emailOrigin: string; effective: string;
  status: 'ok' | 'missing' | 'suspicious'; reason: string;
}
/** The signed-in GitHub account, as a commit identity: its no-reply address links commits to the account. */
export interface GitHubIdentity { login: string; name: string; email: string }
export interface IdentityInfo { identity: GitIdentity; github: GitHubIdentity | null; gh: { installed: boolean; authed: boolean } }
export interface IdentityBody { source?: 'github' | 'manual'; name?: string; email?: string }
export interface NewProjectBody { mode: FoundingMode; name?: string; parent?: string; path?: string; brief?: string; basedOn?: string | null; requester?: string }
/** Where the code is hosted: the `origin` remote, and whether `gh` can create a GitHub repo from here. */
export interface RemoteInfo { origin: string | null; branch: string | null; ahead: number | null; gh: { installed: boolean; authed: boolean; user: string | null } }
