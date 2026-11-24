// Typed views of the plain-JS modules shared with the CLI (lib/*.js, bin/report.js). They stay JavaScript —
// the CLI, the installer and the tests use them directly — so the dashboard describes only what it uses.
import fs from 'fs';
import path from 'path';
import type { GitHubIdentity, GitIdentity } from '../shared/api';

// The package root, found by walking up: this file runs from ui/server/ (ts) and ui/dist-server/server/ (built).
function findRoot(from: string): string {
  for (let d = from; ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, 'bin', 'cli.js')) && fs.existsSync(path.join(d, 'lib', 'registry.js'))) return d;
    if (path.dirname(d) === d) throw new Error('cohorte ui: cannot locate the cohorte package root');
  }
}
export const repo = findRoot(__dirname);
export const uiDir = path.join(repo, 'ui');
const load = (rel: string): any => require(path.join(repo, rel)); // eslint-disable-line @typescript-eslint/no-require-imports

export interface Project { id: string; root: string; addedAt?: string }
export interface WorktreeRow { path: string; branch: string | null; head?: string; bare?: boolean; detached?: boolean }

export class RegistryErrorBase extends Error {}
export interface Registry {
  load(globalDir: string): Project[];
  add(globalDir: string, p: unknown, o?: { founding?: boolean }): { project: Project; created: boolean };
  remove(globalDir: string, id: string): boolean;
  get(globalDir: string, id: string): Project | null;
  discover(globalDir: string, storePath?: string): { name: string; root: string }[];
  worktrees(root: string): WorktreeRow[];
  RegistryError: typeof RegistryErrorBase;
}
export const registry: Registry = load('lib/registry.js');

export interface DoctorState {
  profile?: { name?: string; one_liner?: string } | null;
  summary: { ok: number; warn: number; bad: number; skip: number };
  checks: { label: string; status: string; detail: string; fix?: string }[];
  specs: { status?: string; id?: string }[];
  versions?: { core?: string | null };
  [k: string]: unknown;
}
export interface SpecScan { id: string; file: string; status?: string; title?: string; branch?: string; [k: string]: unknown }
export interface Doctor {
  state(o: { projectRoot: string; globalDir: string; cliVersion: string; offline: boolean }): Promise<DoctorState>;
  scanSpecs(root: string): SpecScan[];
  checkTrust(cwd: string, globalDir: string): { status: string; detail: string; fix?: string };
}
export const doctor: Doctor = load('lib/doctor.js');
export const report: { specRecords(root: string, scan: Doctor['scanSpecs']): unknown[] } = load('bin/report.js');
export const parseProfileBlock: (text: string) => Record<string, any> | null = load('lib/yaml.js').parseProfileBlock;

export interface IdentityLib {
  classifyIdentity(id: { name?: string; email?: string }): { status: GitIdentity['status']; reason: string };
  suspiciousEmail(email: string): string | null;
  readIdentity(cwd: string): GitIdentity;
  githubIdentityOf(user: unknown): GitHubIdentity | null;
  fixCommand(name: string, email: string): string;
  setIdentity(cwd: string, name: string, email: string): GitIdentity;
}
/** The git identity commits in a repo would carry, and whether a code host can link it (shared with `cohorte doctor`). */
export const identity: IdentityLib = load('lib/identity.js');

/** `cohorte sync` — re-wires a repo from its PIPELINE.md (profile.json, gate, pointer). */
export const project: { sync(root: string): unknown } = load('lib/project.js');
