#!/usr/bin/env node
// End-to-end walk of the DETERMINISTIC half of the pipeline, on a real git repo.
//
// No model runs here (CI has no API key, and an LLM step is not reproducible). What this
// does pin is every piece of glue the commands rely on, in the order a feature uses them:
//
//   install → sync a fixture repo → doctor green → a feature branch adds a NEW file
//   (untracked: the 2.x review never saw those) → feature-diff.sh reports it → preflight.sh
//   red aborts, green stamps → the committed gate lets the review dispatch through on a fresh
//   stamp and asks once the tree moves → the gate denies a force-push to main and protects
//   its own files → kanban card moves → uninstall --project, uninstall → nothing left.
//
// Each step is a contract between the prose in core/commands and a script; a refactor of
// either side that breaks the hand-off fails here instead of in a user's session.
//
//   node scripts/test-e2e.mjs

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const CLI = join(root, "bin", "cli.js");
if (process.platform === "win32") {
  // The shipped scripts are POSIX sh and the committed hook command assumes a POSIX shell.
  console.log("test-e2e: skipped on Windows (POSIX shell scripts)");
  process.exit(0);
}

let failures = 0;
const check = (name, cond, detail = "") => {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${String(detail).slice(0, 600)}` : ""}`); }
};
const tmps = [];
const scratch = (p) => { const d = mkdtempSync(join(tmpdir(), p)); tmps.push(d); return d; };
const write = (p, s) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, s); };
const read = (p) => readFileSync(p, "utf8");

const home = scratch("cohorte-e2e-home-");
const g = join(home, ".claude");
const env = { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: g, COHORTE_NO_VERSION_CHECK: "1", CI: "1" };
const cli = (...a) => {
  const r = spawnSync(process.execPath, [CLI, ...a], { env, encoding: "utf8", input: "" });
  return { status: r.status, out: (r.stdout || "") + (r.stderr || "") };
};
const sh = (cmd, cwd, extra = {}) => {
  const r = spawnSync("sh", ["-c", cmd], { cwd, env: { ...env, ...extra }, encoding: "utf8" });
  return { status: r.status, out: (r.stdout || "") + (r.stderr || "") };
};

// ── 1. install ────────────────────────────────────────────────────────────────
console.log("1. install");
check("cohorte install exits 0", cli("install").status === 0);
const core = join(g, "cohorte");
const script = (n) => join(core, "pipeline", "scripts", n);
for (const n of ["preflight.sh", "kanban-move.sh", "feature-diff.sh"]) check(`${n} shipped`, existsSync(script(n)));

// ── 2. a fixture repo, wired ──────────────────────────────────────────────────
console.log("2. a project, wired by sync");
const repo = scratch("cohorte-e2e-repo-");
const git = (...a) => spawnSync("git", ["-C", repo, ...a], { encoding: "utf8" });
git("init", "-q", "-b", "main");
git("config", "user.email", "e2e@example.invalid");
git("config", "user.name", "e2e");
write(join(repo, "package.json"), JSON.stringify({ name: "e2e", private: true, scripts: { test: "node --test" } }, null, 2));
write(join(repo, "apps/api/sum.js"), "module.exports = (a, b) => a + b;\n");
write(join(repo, "apps/api/sum.test.js"), "const t=require('node:test');const a=require('node:assert');const s=require('./sum');t.test('sum',()=>a.strictEqual(s(1,2),3));\n");
write(join(repo, "PIPELINE.md"), [
  "# e2e", "", "```yaml pipeline-profile", "name: e2e", "surfaces:", "  - key: api", "    path: apps/api",
  "    agent: api", "    label: API", "gate:", "  default_branch: main", "  deny:", "    - git push --force",
  "  ask: []", "  ask_on_default_branch:", "    - git commit", "  preflight:", "    enabled: true",
  "    agents: [cohorte-review]", "    max_age_minutes: 30", "```", "",
].join("\n"));
write(join(repo, ".claude/agents/api.md"), "---\nname: api\ndescription: e2e surface\ntools: Read, Write, Edit, Bash\nmodel: sonnet\n---\nImplements apps/api.\n");
write(join(repo, ".claude/gate-config.json"), JSON.stringify({
  deny: ["git push --force"], ask: [], ask_on_default_branch: ["git commit"], default_branch: "main",
  preflight: { enabled: true, agents: ["cohorte-review"], max_age_minutes: 30 },
}, null, 2));
const synced = cli("sync", repo);
check("cohorte sync exits 0", synced.status === 0, synced.out);
git("add", "-A");
git("commit", "-q", "-m", "wire cohorte");
const doc = cli("doctor", repo);
check("doctor reports no bad check on the wired, committed repo", doc.status === 0, doc.out);

// ── 3. a feature adds a NEW, untracked file ───────────────────────────────────
console.log("3. a feature that only adds a file");
git("switch", "-q", "-c", "feature/mul");
write(join(repo, "apps/api/mul.js"), "module.exports = (a, b) => a * b;\n");
const numstat = sh(`"${script("feature-diff.sh")}" --default main --numstat`, repo);
check("feature-diff.sh sees the untracked file (2.x reviewed an empty diff here)",
  numstat.status === 0 && /apps\/api\/mul\.js/.test(numstat.out), numstat.out);
check("…and leaves the real index untouched", !/mul\.js/.test(git("diff", "--cached", "--name-only").stdout));
const digest1 = sh(`"${script("feature-diff.sh")}" --default main --digest`, repo).out.trim();
check("the freshness digest is a stable hash", /^[0-9a-f]{16}$/.test(digest1)
  && sh(`"${script("feature-diff.sh")}" --default main --digest`, repo).out.trim() === digest1, digest1);

// ── 4. preflight: red aborts, green stamps ────────────────────────────────────
console.log("4. preflight");
mkdirSync(join(repo, "specs/reports"), { recursive: true });
const red = sh(`"${script("preflight.sh")}" specs/reports/mul.preflight.txt "node -e 'process.exit(3)'"`, repo);
check("a red check exits 1 and writes no stamp", red.status === 1 && !existsSync(join(repo, ".claude/preflight.ok")), red.out);
const green = sh(`"${script("preflight.sh")}" specs/reports/mul.preflight.txt "npm test --silent"`, repo);
check("a green run stamps .claude/preflight.ok", green.status === 0 && existsSync(join(repo, ".claude/preflight.ok")), green.out);

// ── 5. the committed gate, as Claude Code runs it ─────────────────────────────
console.log("5. the gate");
const reg = Object.fromEntries(JSON.parse(read(join(repo, ".claude/settings.json"))).hooks.PreToolUse
  .filter((h) => h.hooks.some((x) => x.command.includes("cohorte-gate.py"))).map((h) => [h.matcher, h.hooks[0].command]));
const hook = (matcher, tool_name, tool_input) => {
  const r = spawnSync("sh", ["-c", reg[matcher]], {
    input: JSON.stringify({ tool_name, tool_input, cwd: repo, hook_event_name: "PreToolUse", permission_mode: "default" }),
    env: { ...env, CLAUDE_PROJECT_DIR: repo }, encoding: "utf8",
  });
  const o = (r.stdout || "").trim();
  return o ? JSON.parse(o).hookSpecificOutput.permissionDecision : (r.status === 0 ? "allow" : `rc=${r.status}`);
};
const review = () => hook("Bash|Task|Agent", "Agent", { subagent_type: "cohorte-review", prompt: "review mul" });
check("a review dispatch with a fresh stamp goes through", review() === "allow", review());
write(join(repo, "apps/api/mul.js"), "module.exports = (a, b) => a * b; // edited after preflight\n");
check("…and asks once the tree changed after the stamp", review() === "ask", review());
check("a force-push to main is denied", hook("Bash|Task|Agent", "Bash", { command: "git push origin main --force" }) === "deny");
check("…including the refspec form", hook("Bash|Task|Agent", "Bash", { command: "git push origin +feature/mul:main" }) === "deny");
check("a commit on the feature branch is free", hook("Bash|Task|Agent", "Bash", { command: "git commit -m mul" }) === "allow");
check("the agent cannot rewrite the gate config from the shell",
  hook("Bash|Task|Agent", "Bash", { command: "echo {} > .claude/gate-config.json" }) === "deny");
check("an Edit of the gate config needs the human",
  hook("Write|Edit|MultiEdit", "Edit", { file_path: join(repo, ".claude/gate-config.json"), old_string: "a", new_string: "b" }) === "ask");
check("an ordinary Write passes", hook("Write|Edit|MultiEdit", "Write", { file_path: join(repo, "apps/api/x.js"), content: "x" }) === "allow");

// ── 6. kanban ─────────────────────────────────────────────────────────────────
console.log("6. kanban");
const board = join(scratch("cohorte-e2e-vault-"), "Tasks.md");
write(board, ["---", "", "kanban-plugin: board", "", "---", "", "## Ready to build", "", "- [ ] mul #mul", "",
  "## Review", "", "## Shipped", "", ""].join("\n"));
const mv = sh(`"${script("kanban-move.sh")}" "${board}" mul Review`, repo);
check("kanban-move.sh moves the card", mv.status === 0 && /## Review\n\n- \[ \] mul #mul/.test(read(board)), mv.out + read(board));

// ── 7. uninstall ──────────────────────────────────────────────────────────────
console.log("7. uninstall");
const up = cli("uninstall", "--project", repo);
check("uninstall --project removes the wiring", up.status === 0 && !existsSync(join(repo, ".claude/hooks/cohorte-gate.py")), up.out);
check("…and keeps the project's own files", existsSync(join(repo, "PIPELINE.md")) && existsSync(join(repo, ".claude/agents/api.md")));
const um = cli("uninstall", "--purge");
const left = existsSync(g) ? readdirSync(g, { recursive: true }) : [];
check("uninstall --purge leaves nothing of cohorte in ~/.claude", um.status === 0 && left.length === 0, left.join(", "));

for (const d of tmps) { try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
console.log("");
if (failures) { console.error(`test-e2e: ${failures} failure(s)`); process.exit(1); }
console.log("test-e2e: OK");
