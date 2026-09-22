export type Phase = 'build' | 'test' | 'review' | 'fix';
export type Verdict = { verdict: 'pass' | 'fix'; summary: string; findings: string[] };
export type CheckResult = { argv: string[]; exitCode: number; output: string };
export type Status = 'pending' | 'running' | 'blocked' | 'interrupted' | 'completed' | 'cancelled';
export interface Run {
  id: string;
  repo: string;
  worktree: string;
  branch: string;
  spec: string;
  config: Config;
  phase: Phase;
  status: Status;
  round: number;
  feedback: string;
  summary: string;
  checks: CheckResult[];
  threadIds: string[];
}
export interface Config {
  model: string;
  codex: string;
  docker: string;
  image: string;
  checks: string[][];
  writablePaths: string[];
  maxRounds: number;
  timeoutMs: number;
}
export interface AgentTask {
  phase: 'build' | 'review' | 'fix';
  run: Run;
  signal: AbortSignal;
  onThread(id: string): void;
  onEvent(kind: string, detail: string): void;
}
export interface AgentRuntime {
  execute(task: AgentTask): Promise<Verdict>;
}
export interface CheckRunner {
  execute(run: Run, signal: AbortSignal): Promise<CheckResult[]>;
}
export const verdictSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'summary', 'findings'],
  properties: {
    verdict: { type: 'string', enum: ['pass', 'fix'] },
    summary: { type: 'string' },
    findings: { type: 'array', items: { type: 'string' } },
  },
};
export function parseVerdict(value: unknown): Verdict {
  const v = value as Partial<Verdict>;
  if (
    !v ||
    typeof v !== 'object' ||
    Array.isArray(v) ||
    Object.keys(v).sort().join(',') !== 'findings,summary,verdict' ||
    !['pass', 'fix'].includes(v.verdict ?? '') ||
    typeof v.summary !== 'string' ||
    v.summary.length > 16_384 ||
    !Array.isArray(v.findings) ||
    v.findings.length > 100 ||
    v.findings.some((x) => typeof x !== 'string' || x.length > 8192) ||
    (v.verdict === 'pass' && v.findings.length > 0)
  )
    throw new Error('Invalid agent verdict');
  return v as Verdict;
}
export function parseConfig(value: unknown): Config {
  const c = value as Config;
  if (
    !c ||
    typeof c !== 'object' ||
    Array.isArray(c) ||
    Object.keys(c).sort().join(',') !== 'checks,codex,docker,image,maxRounds,model,timeoutMs,writablePaths' ||
    ![c.model, c.codex, c.docker, c.image].every(
      (x) => typeof x === 'string' && x.length > 0 && x.length < 1024 && !x.includes('\0'),
    ) ||
    !Array.isArray(c.checks) ||
    c.checks.length < 1 ||
    c.checks.length > 20 ||
    c.checks.some(
      (a) =>
        !Array.isArray(a) ||
        a.length < 1 ||
        a.length > 64 ||
        a.some((x) => typeof x !== 'string' || !x || x.includes('\0')),
    ) ||
    !Array.isArray(c.writablePaths) ||
    c.writablePaths.length < 1 ||
    c.writablePaths.some(
      (x) =>
        typeof x !== 'string' ||
        !x ||
        x.startsWith('/') ||
        x.split('/').some((p) => !p || p === '.' || p === '..' || p.startsWith('.')),
    ) ||
    !Number.isInteger(c.maxRounds) ||
    c.maxRounds < 0 ||
    c.maxRounds > 10 ||
    !Number.isInteger(c.timeoutMs) ||
    c.timeoutMs < 1000 ||
    c.timeoutMs > 3_600_000
  )
    throw new Error('Invalid config; see examples/config.json');
  return structuredClone(c);
}
