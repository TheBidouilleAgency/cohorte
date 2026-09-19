#!/usr/bin/env node
//
// assert-gate-hook.mjs — post-install assertion on a settings.json's gate hook.
//
//   node scripts/assert-gate-hook.mjs <path-to-settings.json>
//
// Two invariants, both regressions that shipped to users:
//
//  1. EXACTLY ONE registration. Until 1.3.2 the installers appended
//     if-absent, and their "already registered?" test was a bare
//     `.endsWith("gate.py")` — false for the Windows form `py "C:\...\gate.py"`
//     because of the trailing quote. Every re-install appended another copy
//     (four seen in the wild), so gate.py ran once per copy on every Bash call.
//     CI installed only once, so it never noticed. Callers must install TWICE
//     before running this.
//
//  2. THE MATCHER COVERS Task. gate.py's preflight phase gate dispatches on
//     tool_name === "Task" (the `preflight` block in a repo's
//     gate-config.json). A Bash-only matcher never delivers a Task call to the
//     hook, so the gate was dead code from 1.3.0 (which introduced it) to 1.3.1.
//
// Exits non-zero with a specific message on failure.

import fs from 'node:fs';

const settingsPath = process.argv[2];
if (!settingsPath) {
  console.error('usage: assert-gate-hook.mjs <path-to-settings.json>');
  process.exit(2);
}

let data;
try {
  data = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
} catch (err) {
  console.error(`assert-gate-hook: cannot read ${settingsPath}: ${err.message}`);
  process.exit(1);
}

const pre = (data.hooks || {}).PreToolUse || [];
const isGate = (entry) =>
  (entry.hooks || []).some(
    (h) => typeof h.command === 'string' && h.command.trim().replace(/"+$/, '').endsWith('gate.py')
  );
const gate = pre.filter(isGate);

if (gate.length !== 1) {
  console.error(
    `assert-gate-hook: expected exactly 1 gate.py registration, found ${gate.length}.\n` +
      (gate.length > 1
        ? '  Registration is not idempotent — a re-install duplicated the hook.'
        : '  The installer did not register the gate hook.') +
      `\n  PreToolUse: ${JSON.stringify(pre, null, 2)}`
  );
  process.exit(1);
}

const matcher = gate[0].matcher || '';
if (!/\bTask\b/.test(matcher)) {
  console.error(
    `assert-gate-hook: gate matcher must cover Task, got ${JSON.stringify(matcher)}.\n` +
      "  gate.py's preflight phase gate keys off tool_name === 'Task'; without it\n" +
      '  the `preflight` block in gate-config.json is dead code.'
  );
  process.exit(1);
}
if (!/\bBash\b/.test(matcher)) {
  console.error(
    `assert-gate-hook: gate matcher must cover Bash, got ${JSON.stringify(matcher)}.\n` +
      '  The deny/ask command gating runs on Bash tool calls.'
  );
  process.exit(1);
}

console.log(`gate hook ok — 1 registration, matcher ${JSON.stringify(matcher)}`);
