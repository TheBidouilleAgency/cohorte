#!/usr/bin/env node
// test-metrics.mjs — end-to-end checks for scripts/metrics/collect.mjs.
//
// Builds a throwaway repo plus a synthetic ~/.claude/projects transcript, runs the real
// collector against it via --json, and asserts the numbers. The cases are the ones that
// silently produce plausible-but-wrong output rather than crashing:
//
//   1. one API response written as several transcript lines, each repeating `usage`
//   2. a <task-notification> arriving mid-command (must not split the run)
//   3. subagent spend, which lives in a separate file tree
//   4. <synthetic> harness messages, which carry usage but cost nothing
//   5. the cache-tier pricing arithmetic itself
//
// Run: node scripts/test-metrics.mjs

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const COLLECT = path.join(HERE, 'metrics', 'collect.mjs');

let failures = 0;
const ok = (label) => console.log(`  ✓ ${label}`);
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) return ok(label);
  failures += 1;
  console.log(`  ✗ ${label}\n      expected ${e}\n      actual   ${a}`);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cohorte-metrics-'));
const repo = path.join(tmp, 'repo');
const cfg = path.join(tmp, 'claude');
const SESSION = 'sess-test-0001';
const projectDir = path.join(cfg, 'projects', 'test-slug');
fs.mkdirSync(path.join(projectDir, SESSION, 'subagents'), { recursive: true });
fs.mkdirSync(repo, { recursive: true });
execFileSync('git', ['init', '-q'], { cwd: repo, stdio: 'ignore' });

const T0 = Date.parse('2026-07-30T10:00:00.000Z');
const at = (s) => new Date(T0 + s * 1000).toISOString();

const assistant = (id, tsS, model, usage, content = [{ type: 'text', text: 'x' }]) => ({
  type: 'assistant', timestamp: at(tsS), cwd: repo, sessionId: SESSION,
  message: { id, model, content, usage },
});
const user = (tsS, text) => ({
  type: 'user', timestamp: at(tsS), cwd: repo, sessionId: SESSION,
  message: { role: 'user', content: text },
});

const usageOpus = {
  input_tokens: 100, output_tokens: 1000,
  cache_creation_input_tokens: 1000, cache_read_input_tokens: 10000,
  cache_creation: { ephemeral_5m_input_tokens: 1000, ephemeral_1h_input_tokens: 0 },
};

const lines = [
  user(0, '<command-message>build</command-message>\n<command-name>/cohorte-build</command-name>'),
  // Case 1: one response, three lines, identical usage on each. Only one should be billed.
  assistant('m1', 5, 'claude-opus-5', usageOpus, [{ type: 'thinking', thinking: '...' }]),
  assistant('m1', 5, 'claude-opus-5', usageOpus, [{ type: 'text', text: 'hello' }]),
  assistant('m1', 6, 'claude-opus-5', usageOpus, [{ type: 'tool_use', id: 'toolu_A', name: 'Task', input: {} }]),
  // Case 2: a background agent finished mid-run. This is not the human starting anything.
  user(10, '<task-notification>\n<task-id>a1</task-id>\n</task-notification>'),
  // Case 4: harness-authored message, has usage, costs nothing.
  assistant('m2', 12, '<synthetic>', { input_tokens: 0, output_tokens: 999999 }),
  assistant('m3', 20, 'claude-opus-5', { input_tokens: 0, output_tokens: 500 }),
  // A second, genuinely separate run — long enough not to read as a steering turn.
  user(600, 'unrelated question about the repository layout and its conventions'),
  assistant('m4', 605, 'claude-opus-5', { input_tokens: 0, output_tokens: 40 }),
  // Case 6: a command named inside ordinary prose. The harness emits no <command-name>
  // for this, but it is the way commands actually get invoked in practice.
  user(1200, 'move on branding-ramp and /cohorte-review'),
  assistant('m5', 1205, 'claude-opus-5', { input_tokens: 0, output_tokens: 60 }),
  // Case 7: a short steer continues the /cohorte-review rather than opening an anonymous run.
  user(1260, 'continue'),
  assistant('m6', 1265, 'claude-opus-5', { input_tokens: 0, output_tokens: 70 }),
  // Case 8: a slash token that is not a command must not invent one.
  user(1800, 'look at the /usr/local/share directory and report what you find there'),
  assistant('m7', 1805, 'claude-opus-5', { input_tokens: 0, output_tokens: 10 }),
  // Case 9: a long prompt that merely DISCUSSES a command is not an invocation of it.
  // Without the length gate, writing about /cohorte-review bills the conversation to /cohorte-review —
  // which is what happened in cohorte's own repo while the pipeline was being designed.
  user(2400, 'I want to talk through how /cohorte-review behaves when a surface has no findings at '
    + 'all, because the verdict logic there is what produced the false green we saw last week '
    + 'and I am not convinced the fix covers the case where every reviewer dies at once.'),
  assistant('m8', 2405, 'claude-opus-5', { input_tokens: 0, output_tokens: 20 }),
  // Case 10: a RETIRED command name still attributes to itself. 2.0.0 prefixed every
  // command, so months of existing transcripts say `/build` — and the collector reads its
  // known names off the shipped core, where `build.md` no longer exists. Without the
  // retired list every one of those runs silently reclassifies to (chat), rewriting spend
  // history and inflating the catch-all. This is the largest instance of that bug class,
  // so it gets pinned rather than trusted to a comment.
  user(3000, '/build branding-ramp'),
  assistant('m9', 3005, 'claude-opus-5', { input_tokens: 0, output_tokens: 90 }),
];
fs.writeFileSync(path.join(projectDir, `${SESSION}.jsonl`),
  lines.map((l) => JSON.stringify(l)).join('\n') + '\n');

// Case 3: subagent spend, linked back to /cohorte-build by the Task tool_use id.
const agentDir = path.join(projectDir, SESSION, 'subagents');
fs.writeFileSync(path.join(agentDir, 'agent-a1.meta.json'),
  JSON.stringify({ agentType: 'core', description: 'Build core surface', toolUseId: 'toolu_A', spawnDepth: 1 }));
fs.writeFileSync(path.join(agentDir, 'agent-a1.jsonl'),
  JSON.stringify(assistant('s1', 8, 'claude-sonnet-5', { input_tokens: 0, output_tokens: 2000 })) + '\n');

const run = spawnSync(process.execPath, [COLLECT, repo, '--json', '--runs'], {
  encoding: 'utf8',
  env: { ...process.env, CLAUDE_CONFIG_DIR: cfg },
});
if (run.status !== 0) {
  console.error('collector failed:\n' + (run.stderr || run.stdout));
  process.exit(1);
}
const out = JSON.parse(run.stdout);
const build = out.commands.find((c) => c.command === '/cohorte-build');
const chat = out.commands.find((c) => c.command === '(chat)');
const retired = out.commands.find((c) => c.command === '/build');
const review = out.commands.find((c) => c.command === '/cohorte-review');

console.log('test-metrics');
check('the mid-command task-notification did not split the run', out.totals.runs, 6);
check('/cohorte-build is one run, not three', build.runs, 1);
check('duplicate lines of one response are billed once', build.tokens.output, 1000 + 500 + 2000);
check('the <synthetic> message contributed no tokens', build.tokens.output < 999999, true);
check('cache-write tokens are kept on their own tier', build.tokens.cacheWrite5m, 1000);
check('cache-read tokens are kept on their own tier', build.tokens.cacheRead, 10000);
check('the subagent was attributed to the command that spawned it', build.agents.total, 1);
check('the second prompt is a separate (chat) run', chat.runs, 3);
check('a command named inside prose is attributed to that command', review && review.runs, 1);
check('a short steer continues the run instead of opening a new one', review.continuations, 1);
check('the continued turn counts toward the command it continued', review.tokens.output, 60 + 70);
check('a non-command slash token does not invent a command', chat.tokens.output, 40 + 10 + 20);
check('a long prompt that discusses a command is not counted as running it',
  review.runs, 1);
check('a retired unprefixed command stays attributed to itself, not (chat)',
  retired && retired.runs, 1);
check('…and keeps its own spend', retired && retired.tokens.output, 90);

// opus-5 $5 in / $25 out per MTok; 5m cache write 1.25x input, cache read 0.1x input.
//   m1  100*5 + 1000*25 + 1000*6.25 + 10000*0.5 = 36750
//   m3  500*25                                   = 12500
//   s1  sonnet-5 2000*10                         = 20000   (subagent, $2/$10 since 2026-08)
check('cost sums the cache tiers at their own rates', Number(build.cost.total.toFixed(6)), 0.06925);
check('the unpriced list stays empty for known models', build.unpriced, []);

const detail = out.runs.find((r) => r.command === '/cohorte-build');
check('per-run detail carries the subagent', detail.agents.map((a) => a.type), ['core']);

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `\ntest-metrics: ${failures} FAILED` : '\ntest-metrics: OK');
process.exit(failures ? 1 : 0);
