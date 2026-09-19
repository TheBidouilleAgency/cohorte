#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const REPO_ROOT = resolve(import.meta.dirname, '..');
export const OUTPUT = join(REPO_ROOT, 'docs/v3/protocol/reference.md');

export function renderProtocolReference(repoRoot: string): string {
  const schemasDir = join(repoRoot, 'schemas');
  const schemas = existsSync(schemasDir)
    ? readdirSync(schemasDir)
        .filter((file) => file.endsWith('.schema.json'))
        .sort()
    : [];
  const version = JSON.parse(readFileSync(join(repoRoot, 'packages/protocol/package.json'), 'utf8')) as {
    version?: string;
  };
  return [
    '# Cohorte Protocol reference',
    '',
    `Generated from the V3 protocol catalogue. Protocol wire version: **1.0**. Package version: **${version.version ?? 'unknown'}**.`,
    '',
    'The public protocol is JSON/NDJSON and deliberately runtime-independent. Consumers should validate documents against the published schemas.',
    '',
    '## Published schemas',
    '',
    ...schemas.map((schema) => `- [${schema}](../../../schemas/${schema})`),
    '',
    '## Compatibility',
    '',
    '- Minor releases may add event types and optional fields.',
    '- Existing event meanings and required fields are not reinterpreted.',
    '- Unknown open-enum values must be preserved by forward-compatible clients.',
    '',
  ].join('\n');
}

export function generateProtocolDocs(options: { repoRoot?: string; check?: boolean } = {}): boolean {
  const repoRoot = resolve(options.repoRoot ?? REPO_ROOT);
  const output = join(repoRoot, 'docs/v3/protocol/reference.md');
  const expected = renderProtocolReference(repoRoot);
  if (options.check) return existsSync(output) && readFileSync(output, 'utf8') === expected;
  writeFileSync(output, expected);
  return true;
}

if (import.meta.main) {
  const check = process.argv.includes('--check');
  if (check && !generateProtocolDocs({ check: true })) {
    process.stderr.write('gen-protocol-docs: generated reference is stale\n');
    process.exitCode = 1;
  } else if (!check) {
    generateProtocolDocs();
    process.stdout.write(`gen-protocol-docs: wrote ${OUTPUT}\n`);
  } else process.stdout.write('gen-protocol-docs: up to date\n');
}
