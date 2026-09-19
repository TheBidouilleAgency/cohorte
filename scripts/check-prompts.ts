#!/usr/bin/env node
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

/** Control-flow vocabulary belongs to TypeScript transition tables, never to agent-facing Markdown. */
const CONTROL_FLOW =
  /\b(?:transition|verdict|stop\s+rule|stop\s+the\s+run|retry\s+the\s+phase|escalat(?:e|ion)|PREFLIGHT|WAITING_APPROVAL|COMPLETED|CANCELLED|BLOCKED)\b/i;

export interface PromptViolation {
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

function filesUnder(root: string): string[] {
  try {
    return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
      const path = join(root, entry.name);
      if (entry.isDirectory()) return filesUnder(path);
      return entry.isFile() && /\.(md|mdx|txt)$/i.test(entry.name) ? [path] : [];
    });
  } catch {
    return [];
  }
}

export function checkPromptText(file: string, content: string): PromptViolation[] {
  if (file.endsWith('/README.md') || file === 'README.md') return [];
  return content
    .split(/\r?\n/)
    .flatMap((text, index) => (CONTROL_FLOW.test(text) ? [{ file, line: index + 1, text: text.trim() }] : []));
}

export function checkPrompts(repoRoot: string): PromptViolation[] {
  return ['prompts', 'skills'].flatMap((rootName) =>
    filesUnder(join(repoRoot, rootName)).flatMap((file) =>
      checkPromptText(relative(repoRoot, file), readFileSync(file, 'utf8')),
    ),
  );
}

async function main(): Promise<void> {
  const violations = checkPrompts(process.cwd());
  if (violations.length > 0) {
    for (const violation of violations)
      process.stderr.write(
        `${violation.file}:${violation.line}: forbidden control-flow vocabulary: ${violation.text}\n`,
      );
    process.exitCode = 1;
    return;
  }
  process.stdout.write('check-prompts: OK\n');
}

if (import.meta.main) await main();
