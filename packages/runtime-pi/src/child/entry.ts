#!/usr/bin/env node
// packages/runtime-pi/src/child/entry.ts — DESIGN 1.4 step 3's "agent-host" bundle entry, and the packaging-path
// deliverable of PLAN U0.10 ("--selftest imports the three Pi packages, asserts equal versions, prints the Pi
// version"). This file, and no other outside `packages/runtime-pi/src/child/**`, may import `@earendil-works/*`
// (layers.json rule b) — real RPC-child behaviour is `U4.08`'s (DESIGN §9 "runRpcMode host variant").
import { readFileSync } from 'node:fs';
import { findPackageJSON } from 'node:module';
import '@earendil-works/pi-agent-core';
import '@earendil-works/pi-ai';
import '@earendil-works/pi-coding-agent';

const PI_PACKAGES = [
  '@earendil-works/pi-ai',
  '@earendil-works/pi-agent-core',
  '@earendil-works/pi-coding-agent',
] as const;

function piPackageVersion(name: (typeof PI_PACKAGES)[number]): string {
  const path = findPackageJSON(name, import.meta.url);
  if (!path) throw new Error(`agent-host: cannot locate an installed package.json for ${name}`);
  const pkg = JSON.parse(readFileSync(path, 'utf8')) as { version?: unknown };
  if (typeof pkg.version !== 'string') throw new Error(`agent-host: ${name}'s package.json has no "version"`);
  return pkg.version;
}

export interface SelfTestResult {
  readonly versions: Readonly<Record<string, string>>;
  readonly version: string;
}

/** F-6: `pnpm-workspace.yaml` pins the three packages to one exact version so pnpm never installs two copies of
 * `pi-ai` (which would break `instanceof ModelsError`); this is the runtime side of that invariant. */
export function selfTest(): SelfTestResult {
  const entries = PI_PACKAGES.map((name) => [name, piPackageVersion(name)] as const);
  const versions: Record<string, string> = Object.fromEntries(entries);
  const distinct = new Set(entries.map(([, version]) => version));
  if (distinct.size !== 1) {
    throw new Error(`agent-host: Pi package versions disagree: ${JSON.stringify(versions)}`);
  }
  const [version] = distinct;
  if (!version) throw new Error('agent-host: no Pi package version found');
  return { versions, version };
}

async function main(): Promise<void> {
  if (process.argv.includes('--selftest')) {
    const result = selfTest();
    process.stdout.write(`agent-host selftest ok, pi=${result.version}\n`);
    return;
  }
  process.stderr.write('agent-host: only --selftest is implemented in V3.0 Wave 0 (the RPC child is U4.08)\n');
  process.exitCode = 1;
}

// `import.meta.main` (node >= 24.2), not a hand-rolled `import.meta.url === `file://${argv[1]}``: the latter is
// false whenever the file is reached through a symlink (how npm installs a `bin`) and breaks on any path
// carrying a space or a non-ASCII character (`import.meta.url` is percent-encoded, `argv[1]` is not).
if (import.meta.main) {
  main().catch((error: unknown) => {
    process.stderr.write(
      `agent-host fatal: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
