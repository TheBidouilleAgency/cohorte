// What git (and, when it is installed, `gh`) says about a worktree: ahead/behind, dirty files, the last commit,
// the PR for its branch and that PR's checks, and the diff against the default branch.
// Read-only and bounded: every call is async, has a timeout and never goes through a shell. A file to diff must be
// one that `git` itself lists for the worktree — the client never names a path git did not report.

import { spawn } from 'child_process';
import type { ChangedFile, FileDiff, GitInfo, PullInfo, RemoteInfo } from '../shared/api';

interface Out { code: number | null; out: string; err: string }
function run(file: string, args: string[], cwd: string, timeout = 8000, max = 400_000): Promise<Out> {
  return new Promise((resolve) => {
    let out = ''; let err = ''; let done = false;
    let child: ReturnType<typeof spawn>;
    const finish = (code: number | null): void => { if (!done) { done = true; clearTimeout(timer); resolve({ code, out, err }); } };
    try { child = spawn(file, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' } }); } catch { return resolve({ code: -1, out, err: 'spawn failed' }); }
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } finish(-1); }, timeout);
    child.stdout?.on('data', (d: Buffer) => { if (out.length < max) out += d; });
    child.stderr?.on('data', (d: Buffer) => { if (err.length < 20_000) err += d; });
    child.on('error', () => finish(-1));
    child.on('close', (c: number | null) => finish(c));
  });
}
const git = (cwd: string, ...a: string[]): Promise<Out> => run('git', a, cwd);

export async function baseRef(cwd: string, defaultBranch: string): Promise<string | null> {
  for (const ref of [`origin/${defaultBranch}`, defaultBranch]) {
    if ((await git(cwd, 'rev-parse', '--verify', '-q', ref)).code === 0) return ref;
  }
  return null;
}

export function parseStatus(out: string): { branch: string | null; ahead: number; behind: number; upstream: string | null; modified: number; staged: number; untracked: number; conflicted: number } {
  const r = { branch: null as string | null, ahead: 0, behind: 0, upstream: null as string | null, modified: 0, staged: 0, untracked: 0, conflicted: 0 };
  for (const l of out.split('\n')) {
    if (l.startsWith('# branch.head ')) { const b = l.slice(14).trim(); r.branch = b === '(detached)' ? null : b; }
    else if (l.startsWith('# branch.upstream ')) r.upstream = l.slice(18).trim();
    else if (l.startsWith('# branch.ab ')) { const m = /\+(\d+) -(\d+)/.exec(l); if (m) { r.ahead = Number(m[1]); r.behind = Number(m[2]); } }
    else if (l.startsWith('1 ') || l.startsWith('2 ')) { const xy = l.split(' ')[1] || '..'; if (xy[0] !== '.') r.staged++; if (xy[1] !== '.') r.modified++; }
    else if (l.startsWith('u ')) r.conflicted++;
    else if (l.startsWith('? ')) r.untracked++;
  }
  return r;
}

export function parseShortstat(out: string): { files: number; insertions: number; deletions: number } {
  const n = (re: RegExp): number => { const m = re.exec(out); return m ? Number(m[1]) : 0; };
  return { files: n(/(\d+) files? changed/), insertions: n(/(\d+) insertions?\(\+\)/), deletions: n(/(\d+) deletions?\(-\)/) };
}

export async function worktreeGit(wtPath: string, defaultBranch: string): Promise<GitInfo> {
  const [st, last, base] = await Promise.all([
    git(wtPath, 'status', '--porcelain=v2', '--branch'),
    git(wtPath, 'log', '-1', '--format=%h%x09%s%x09%cr'),
    baseRef(wtPath, defaultBranch),
  ]);
  if (st.code !== 0) return { error: (st.err || 'git status failed').trim().split('\n')[0] } as GitInfo;
  const s = parseStatus(st.out);
  const [sha, subject, when] = last.out.trim().split('\t');
  let diff = { files: 0, insertions: 0, deletions: 0 };
  if (base) {
    const mb = await git(wtPath, 'merge-base', base, 'HEAD');
    if (mb.code === 0 && mb.out.trim()) diff = parseShortstat((await git(wtPath, 'diff', '--shortstat', mb.out.trim())).out);
  }
  return { ...s, base, lastCommit: sha ? { sha, subject: subject || '', when: when || '' } : null, diff, clean: !s.modified && !s.staged && !s.untracked && !s.conflicted };
}

// ---- pull request for a branch, via gh (optional, cached by the caller) ----
export async function pullFor(root: string, branch: string): Promise<PullInfo | null> {
  const r = await run('gh', ['pr', 'list', '--head', branch, '--state', 'all', '--limit', '1', '--json', 'number,state,url,title,isDraft,reviewDecision,statusCheckRollup'], root, 12000);
  if (r.code !== 0) return null;
  let rows: any[];
  try { rows = JSON.parse(r.out); } catch { return null; }
  const p = rows[0];
  if (!p) return null;
  const roll: any[] = Array.isArray(p.statusCheckRollup) ? p.statusCheckRollup : [];
  const bad = roll.some((c) => ['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE'].includes(String(c.conclusion || c.state || '').toUpperCase()));
  const pending = roll.some((c) => !c.conclusion && !['SUCCESS', 'FAILURE', 'ERROR'].includes(String(c.state || '').toUpperCase()) && String(c.status || c.state || '').toUpperCase() !== 'COMPLETED');
  return { number: p.number, state: String(p.state), url: String(p.url), title: String(p.title), draft: p.isDraft === true, review: p.reviewDecision ? String(p.reviewDecision) : null,
    checks: !roll.length ? null : bad ? 'failure' : pending ? 'pending' : 'success' };
}
export async function ghAvailable(): Promise<boolean> { return (await run('gh', ['--version'], process.cwd(), 4000)).code === 0; }

// ---- diff ----
const STATUS: Record<string, string> = { A: 'added', M: 'modified', D: 'deleted', R: 'renamed', C: 'copied', T: 'changed' };
export async function changedFiles(wtPath: string, base: string | null): Promise<ChangedFile[]> {
  const files = new Map<string, ChangedFile>();
  if (base) {
    const mb = await git(wtPath, 'merge-base', base, 'HEAD');
    if (mb.code === 0 && mb.out.trim()) {
      const d = await git(wtPath, 'diff', '--name-status', '-z', mb.out.trim());
      const t = d.out.split('\0').filter(Boolean);
      for (let i = 0; i < t.length;) {
        const code = t[i][0];
        if (code === 'R' || code === 'C') { files.set(t[i + 2], { path: t[i + 2], status: STATUS[code] }); i += 3; } else { files.set(t[i + 1], { path: t[i + 1], status: STATUS[code] || 'modified' }); i += 2; }
      }
    }
  }
  const un = await git(wtPath, 'ls-files', '--others', '--exclude-standard', '-z');
  for (const f of un.out.split('\0').filter(Boolean)) files.set(f, { path: f, status: 'untracked' });
  return [...files.values()].sort((a, b) => a.path.localeCompare(b.path)).slice(0, 500);
}

export async function fileDiff(wtPath: string, base: string | null, file: string): Promise<FileDiff | null> {
  const list = await changedFiles(wtPath, base);
  const entry = list.find((f) => f.path === file);
  if (!entry) return null;
  if (entry.status === 'untracked') {
    const r = await run('git', ['diff', '--no-index', '--no-color', '--', '/dev/null', file], wtPath);
    return { file, status: entry.status, diff: r.out.slice(0, 200_000), truncated: r.out.length > 200_000 };
  }
  let range = 'HEAD';
  if (base) { const mb = await git(wtPath, 'merge-base', base, 'HEAD'); if (mb.code === 0 && mb.out.trim()) range = mb.out.trim(); }
  const r = await git(wtPath, 'diff', '--no-color', '--no-ext-diff', range, '--', file);
  return { file, status: entry.status, diff: r.out.slice(0, 200_000), truncated: r.out.length > 200_000 };
}

const ghBin = (): string => process.env.COHORTE_GH_BIN || 'gh';
/** Where the code is hosted, and whether `gh` could create a GitHub repository from here. Read-only. */
export async function remoteInfo(root: string): Promise<RemoteInfo> {
  const [origin, branch, ahead, ghv] = await Promise.all([
    git(root, 'remote', 'get-url', 'origin'), git(root, 'rev-parse', '--abbrev-ref', 'HEAD'),
    git(root, 'rev-list', '--count', '@{u}..HEAD'), run(ghBin(), ['--version'], root, 4000),
  ]);
  let authed = false; let user: string | null = null;
  if (ghv.code === 0) {
    const who = await run(ghBin(), ['api', 'user', '--jq', '.login'], root, 10000);
    authed = who.code === 0 && !!who.out.trim();
    user = authed ? who.out.trim().split('\n')[0].slice(0, 100) : null;
  }
  return { origin: origin.code === 0 ? origin.out.trim() || null : null, branch: branch.code === 0 ? branch.out.trim() || null : null,
    ahead: ahead.code === 0 ? Number(ahead.out.trim()) || 0 : null, gh: { installed: ghv.code === 0, authed, user } };
}

/** A bounded, shell-less process run (tool probes for the foundations context). */
export const probe = (file: string, args: string[], cwd: string, timeout = 4000): Promise<{ code: number | null; out: string; err: string }> => run(file, args, cwd, timeout, 20_000);
