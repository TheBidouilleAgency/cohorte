import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

const CONFIG = `schemaVersion: 1
project: { id: ts-monorepo, defaultBranch: main, protectedBranches: [main] }
runtime: { id: fake }
authentication: { mode: none, allowApiKeys: false }
routing: { allowedProviders: [fake], defaults: { implementer: coding, fixer: coding, reviewer: reasoning }, tiers: {}, escalation: { sameFailureCount: 2, ladder: [], maxPerRun: 2 }, fallback: { enabled: false } }
budgets: { run: { wallClockMs: 600000 }, phase: {}, agent: {}, provider: {}, tool: {}, concurrency: 2, maxIncarnations: 3 }
loop: { maxFixRounds: 2, noProgressWindow: 2, maxDeniedCallsPerAgent: 2, leftovers: { major: fix, minor: park, info: park } }
checks: { test: [pnpm, test], timeoutMs: 120000 }
provision: { argv: [pnpm, install, --frozen-lockfile, --ignore-scripts, --offline], network: false, cacheDirs: [], lockfiles: [pnpm-lock.yaml], env: {}, dependencyDirs: ["**/node_modules"], writableCaches: [node_modules/.cache] }
policy: { commands: { allow: [], ask: [], deny: [] }, dangerousCommands: [], symlinks: { mode: deny-outgoing, hardlinksOnWrite: deny }, approvals: { unattended: deny, parkAfterMinutes: 10, ship: human, notify: false, autoResume: false }, inDoubt: ask, skip: [], steer: { enabled: false }, admin: { runTool: false }, quota: { autoResume: false } }
host: { idleExitMinutes: 30, pauseKeepAliveMinutes: 30, pollMs: 250 }
network: { proxyEnv: false }
sandbox: { brain: os-if-available }
git: { branchPrefix: cohorte/, commitIdentity: user, keepWorktrees: on-failure }
retention: { transcriptsDays: 30, eventsDays: forever, artifactsDays: 90, compressAfterDays: 7 }
telemetry: { remote: false }
`;

export async function buildTsMonorepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'cohorte-fixture-ts-'));
  await mkdir(join(root, '.cohorte', 'specs'), { recursive: true });
  await mkdir(join(root, 'packages', 'frontend'), { recursive: true });
  await mkdir(join(root, 'packages', 'backend'), { recursive: true });
  await writeFile(join(root, '.cohorte', 'config.yaml'), CONFIG);
  await writeFile(
    join(root, '.cohorte', 'ownership.yaml'),
    'surfaces:\n  frontend: { paths: [packages/frontend/**], owners: [implementer], reviewers: [reviewer] }\n  backend: { paths: [packages/backend/**], owners: [implementer], reviewers: [reviewer] }\n',
  );
  await writeFile(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n');
  await writeFile(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n');
  await writeFile(
    join(root, 'package.json'),
    '{"name":"fixture-ts-monorepo","private":true,"scripts":{"test":"node -e \\"process.exit(0)\\"}}\n',
  );
  await writeFile(join(root, 'packages/frontend/index.ts'), 'export const greeting = "hello";\n');
  await writeFile(join(root, 'packages/backend/index.ts'), 'export const health = true;\n');
  await run('git', ['init', '--initial-branch', 'main'], { cwd: root });
  return root;
}
