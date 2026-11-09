#!/usr/bin/env node
// Behavioural tests for core/hooks/gate.py — the PreToolUse gate.
//
// The gate is the one component that can BLOCK a user's command, and it is the
// only one with a pure, fully testable interface: a PreToolUse payload on stdin,
// a JSON permissionDecision (or nothing) on stdout. Until this file existed it
// had no test at all — every one of its shipped regressions (a Bash-only matcher
// leaving the phase gate dead, branch state resolved in the wrong checkout,
// unanswerable "ask"s in headless runs) reached users first.
//
//   node scripts/test-gate.mjs

import { spawnSync, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const GATE = join(root, "core", "hooks", "gate.py");

const python = ["py", "python3", "python"].find((c) => {
  try { return spawnSync(c, ["--version"], { stdio: "ignore" }).status === 0; }
  catch { return false; }
});
if (!python) { console.error("test-gate: no python found on PATH"); process.exit(2); }

let failures = 0;
const check = (name, cond, detail = "") => {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
};

const tmps = [];
function scratch() {
  const d = mkdtempSync(join(tmpdir(), "gate-"));
  tmps.push(d);
  mkdirSync(join(d, ".claude"), { recursive: true });
  return d;
}
function writeConfig(dir, cfg) {
  writeFileSync(join(dir, ".claude", "gate-config.json"), JSON.stringify(cfg));
}
function gitRepo(dir, branch) {
  const git = (...a) => execFileSync("git", a, { cwd: dir, stdio: "ignore" });
  git("init", "-q");
  git("config", "user.email", "t@t.t");
  git("config", "user.name", "t");
  git("config", "commit.gpgsign", "false");
  writeFileSync(join(dir, "f.txt"), "x");
  git("add", "-A");
  git("commit", "-qm", "init");
  git("branch", "-M", "main");
  if (branch && branch !== "main") git("checkout", "-qb", branch);
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
}

// Run the hook with a payload. Returns { decision, reason, raw, status }.
function run(payload, { projectDir } = {}) {
  const r = spawnSync(python, [GATE], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir || "" },
  });
  const raw = (r.stdout || "").trim();
  if (!raw) return { decision: null, reason: null, raw, status: r.status };
  try {
    const o = JSON.parse(raw).hookSpecificOutput;
    return { decision: o.permissionDecision, reason: o.permissionDecisionReason, raw, status: r.status };
  } catch {
    return { decision: "UNPARSEABLE", reason: null, raw, status: r.status };
  }
}
const bash = (command, extra = {}) => ({ tool_name: "Bash", tool_input: { command }, ...extra });
const task = (subagent_type, extra = {}) => ({ tool_name: "Task", tool_input: { subagent_type }, ...extra });

const GATE_CFG = {
  deny: ["node ace migration:fresh", "node ace db:wipe"],
  ask: ["node ace migration:run", "psql"],
  ask_on_default_branch: ["git commit", "git push", "docker compose"],
  default_branch: "main",
};

// ── Bash command gating ──────────────────────────────────────────────────────
console.log("gate.py — Bash command gating");
{
  const d = scratch(); writeConfig(d, GATE_CFG); gitRepo(d, "feature/x");
  const at = p => ({ projectDir: d });

  check("harmless command passes silently",
    run(bash("ls -la"), at()).decision === null);
  check("non-Bash, non-Task tool is ignored",
    run({ tool_name: "Read", tool_input: { file_path: "x" } }, at()).decision === null);
  check("deny pattern ⇒ deny",
    run(bash("node ace migration:fresh"), at()).decision === "deny");
  check("ask pattern ⇒ ask",
    run(bash("node ace migration:run"), at()).decision === "ask");

  // The headline capability: prefix-based settings.json rules cannot see this.
  check("CHAINED command is caught (cd x && …)",
    run(bash("cd apps/api && node ace migration:run"), at()).decision === "ask");
  check("chained after a semicolon is caught",
    run(bash("echo hi; node ace db:wipe"), at()).decision === "deny");
  check("chained after a pipe is caught",
    run(bash("cat x | psql"), at()).decision === "ask");
  check("chained after || is caught",
    run(bash("false || node ace migration:fresh"), at()).decision === "deny");
  check("newline-separated is caught",
    run(bash("echo a\nnode ace migration:run"), at()).decision === "ask");

  check("whitespace is normalized before matching",
    run(bash("node   ace    migration:run"), at()).decision === "ask");
  check("deny wins over ask on the same segment",
    run(bash("node ace migration:fresh"), at()).decision === "deny");
  // Deny must win ACROSS segments too: with segment-order scanning, the benign ask
  // surfaced first and the human's one confirm ran the hard-denied command behind it.
  check("deny in a LATER segment wins over an earlier ask segment",
    run(bash("node ace migration:run && node ace migration:fresh"), at()).decision === "deny");
  check("deny in a later segment wins over an earlier branch-gated ask",
    run(bash("git commit -m x && node ace db:wipe"), at()).decision === "deny");
  // Matching is substring-on-the-whole-pattern, so a partial overlap is NOT a
  // match — `migration:run` alone does not trigger `node ace migration:run`.
  check("a partial overlap of a pattern does not gate",
    run(bash("echo 'we never run migration:run here'"), at()).decision === null);
  // …but the full pattern inside a quoted string DOES gate. Intentional: the gate
  // cannot know a shell quote is inert (`sh -c "node ace db:wipe"` is real), so it
  // over-gates rather than reasoning about quoting.
  check("the full pattern inside a quoted string still gates (fail-safe over-gating)",
    run(bash("echo \"node ace db:wipe\""), at()).decision === "deny");
  check("…including when wrapped in sh -c, which really would execute",
    run(bash("sh -c 'node ace db:wipe'"), at()).decision === "deny");

  // bypassPermissions: nobody can answer a prompt.
  check("ask in bypassPermissions ⇒ escalated to deny",
    run(bash("node ace migration:run"), { ...at(), }).decision === "ask");
  const unattended = run({ ...bash("node ace migration:run"), permission_mode: "bypassPermissions" }, at());
  check("ask + bypassPermissions ⇒ deny", unattended.decision === "deny", unattended.decision);
  check("…and the reason says why", /unattended/i.test(unattended.reason || ""), unattended.reason);
}

// ── branch-conditional gating ────────────────────────────────────────────────
console.log("gate.py — branch-conditional gating");
{
  const main = scratch(); writeConfig(main, GATE_CFG); gitRepo(main, "main");
  const feat = scratch(); writeConfig(feat, GATE_CFG); gitRepo(feat, "feature/x");

  check("git commit on the default branch ⇒ ask",
    run({ ...bash("git commit -m x"), cwd: main }, { projectDir: main }).decision === "ask");
  check("git commit on a feature branch ⇒ free",
    run({ ...bash("git commit -m x"), cwd: feat }, { projectDir: feat }).decision === null);
  check("docker compose on a feature branch ⇒ free",
    run({ ...bash("docker compose up"), cwd: feat }, { projectDir: feat }).decision === null);

  // The 1.3.3 fix: git state must resolve at the payload's cwd (the worktree),
  // not CLAUDE_PROJECT_DIR (the main checkout, usually on the default branch).
  const cross = run({ ...bash("git commit -m x"), cwd: feat }, { projectDir: main });
  check("branch resolves at the payload cwd, not CLAUDE_PROJECT_DIR",
    cross.decision === null, `got ${cross.decision} (a worktree commit must not be gated)`);

  // Fail-safe: no repo ⇒ unknown branch ⇒ gate.
  const norepo = scratch(); writeConfig(norepo, GATE_CFG);
  check("unknown branch (not a repo) ⇒ gated, to stay safe",
    run({ ...bash("git commit -m x"), cwd: norepo }, { projectDir: norepo }).decision === "ask");

  // 2.0.2: the tool's shell keeps no cwd between calls, so agents write
  // `cd <other repo> && git commit`. Resolving the branch at the payload cwd
  // judged that commit against the wrong checkout — and the refusal named a
  // branch the command was never going to run on, so no approval could lift it.
  const chained = run({ ...bash(`cd ${feat} && git commit -m x`), cwd: main }, { projectDir: main });
  check("`cd <feature checkout> && git commit` follows the cd ⇒ free",
    chained.decision === null, `got ${chained.decision}: ${chained.reason}`);
  check("`cd <default-branch checkout> && git commit` still gated",
    run({ ...bash(`cd ${main} && git commit -m x`), cwd: feat }, { projectDir: feat }).decision === "ask");
  check("a cd only affects segments AFTER it",
    run({ ...bash(`git commit -m x && cd ${feat}`), cwd: main }, { projectDir: main }).decision === "ask");
  check("relative cd resolves against the payload cwd",
    run({ ...bash("cd .. && git commit -m x"), cwd: join(feat, ".claude") },
        { projectDir: feat }).decision === null);
  check("cd into a missing dir keeps the current cwd (still gated)",
    run({ ...bash("cd /definitely/not/here && git commit -m x"), cwd: main },
        { projectDir: main }).decision === "ask");
  check("an unresolvable cd ($(…)) keeps the current cwd (still gated)",
    run({ ...bash("cd $(mktemp -d) && git commit -m x"), cwd: main },
        { projectDir: main }).decision === "ask");
  check("`cd -` is never treated as a resolvable move",
    run({ ...bash("cd - && git commit -m x"), cwd: main }, { projectDir: main }).decision === "ask");
  check("a quoted cd path with a space is followed",
    run({ ...bash(`cd "${feat}" && git commit -m x`), cwd: main }, { projectDir: main }).decision === null);
  // A cd must not soften the unconditional tiers — those are branch-independent.
  check("cd does not exempt a `deny` pattern",
    run({ ...bash(`cd ${feat} && node ace db:wipe`), cwd: main }, { projectDir: main }).decision === "deny");
  check("cd does not exempt an always-`ask` pattern",
    run({ ...bash(`cd ${feat} && psql`), cwd: main }, { projectDir: main }).decision === "ask");
}

// ── config robustness ────────────────────────────────────────────────────────
console.log("gate.py — config robustness");
{
  const none = scratch();                       // no gate-config.json at all
  check("missing gate-config.json ⇒ silent (never bricks a repo)",
    run(bash("node ace migration:fresh"), { projectDir: none }).decision === null);

  const bad = scratch();
  writeFileSync(join(bad, ".claude", "gate-config.json"), "{ not json");
  check("unparseable gate-config.json ⇒ silent",
    run(bash("node ace migration:fresh"), { projectDir: bad }).decision === null);

  const empty = scratch(); writeConfig(empty, { deny: [], ask: [], ask_on_default_branch: [] });
  check("empty pattern lists ⇒ silent",
    run(bash("node ace migration:fresh"), { projectDir: empty }).decision === null);

  const r = spawnSync(python, [GATE], { input: "not json at all", encoding: "utf8" });
  check("malformed stdin ⇒ exit 0, no output (never blocks on its own bug)",
    r.status === 0 && (r.stdout || "").trim() === "", `status=${r.status} out=${r.stdout}`);
}

// ── the preflight phase gate (Task dispatches) ───────────────────────────────
console.log("gate.py — preflight phase gate");
{
  const pf = { enabled: true, agents: ["review"], max_age_minutes: 30 };
  const d = scratch(); writeConfig(d, { ...GATE_CFG, preflight: pf });
  const head = gitRepo(d, "main");
  const stamp = (epoch, sha) =>
    writeFileSync(join(d, ".claude", "preflight.ok"), `${epoch} ${sha}\n`);
  const now = () => Math.floor(Date.now() / 1000);
  const at = { projectDir: d };

  check("no stamp ⇒ ask", run(task("review"), at).decision === "ask");
  check("…and the reason names the phase gate",
    /phase gate/i.test(run(task("review"), at).reason || ""));

  stamp(now(), head);
  check("fresh stamp at the current HEAD ⇒ passes", run(task("review"), at).decision === null);

  stamp(now() - 60 * 60, head);
  check("stamp older than max_age_minutes ⇒ ask", run(task("review"), at).decision === "ask");
  check("…and the reason says it is stale",
    /min old/.test(run(task("review"), at).reason || ""));

  stamp(now(), "0000000000000000000000000000000000000000");
  const moved = run(task("review"), at);
  check("stamp from a different HEAD ⇒ ask", moved.decision === "ask", moved.decision);
  check("…and the reason says HEAD moved", /HEAD moved/.test(moved.reason || ""));

  writeFileSync(join(d, ".claude", "preflight.ok"), "garbage\n");
  check("unreadable stamp ⇒ ask, reported as unreadable",
    /unreadable/.test(run(task("review"), at).reason || ""));

  stamp(now(), head);
  check("an unlisted subagent_type is not gated",
    run(task("backend"), at).decision === null);
  check("a Task with no subagent_type is not gated",
    run({ tool_name: "Task", tool_input: {} }, at).decision === null);

  // Unattended: an "ask" nobody can answer must become a deny (1.3.3 fix).
  writeFileSync(join(d, ".claude", "preflight.ok"), "garbage\n");
  const headless = run({ ...task("review"), permission_mode: "bypassPermissions" }, at);
  check("stale stamp + bypassPermissions ⇒ deny, not an unanswerable ask",
    headless.decision === "deny", headless.decision);

  // Disabled / absent block ⇒ the phase gate must not fire at all.
  const off = scratch(); writeConfig(off, { ...GATE_CFG, preflight: { enabled: false } });
  check("preflight.enabled false ⇒ Task never gated",
    run(task("review"), { projectDir: off }).decision === null);
  const noblock = scratch(); writeConfig(noblock, GATE_CFG);
  check("profile with no preflight block ⇒ Task never gated (older installs keep working)",
    run(task("review"), { projectDir: noblock }).decision === null);
}

// ── the content digest (2.0.0): freshness keyed on code, not on HEAD ─────────
// Before this, the stamp recorded the HEAD sha — backwards on both sides. The
// reviewed tree is normally DIRTY, so committing already-verified code made the
// gate ask on a clean tree (and a committed stamp made it ask forever), while an
// implementer's edit between preflight and dispatch invalidated nothing.
console.log("gate.py — preflight content digest");
{
  const pf = { enabled: true, agents: ["review"], max_age_minutes: 30 };
  const d = scratch(); writeConfig(d, { ...GATE_CFG, preflight: pf });
  gitRepo(d, "main");
  mkdirSync(join(d, "specs", "reports"), { recursive: true });
  writeFileSync(join(d, "specs", "s.md"), "spec\n");
  writeFileSync(join(d, "src.txt"), "code v1\n");     // uncommitted feature work
  const git = (...a) => execFileSync("git", a, { cwd: d, stdio: "ignore" });
  const at = { projectDir: d };
  const runPreflight = () =>
    spawnSync("sh", [join(root, "scripts", "preflight.sh"), join(d, "specs", "reports", "r.txt"), "true"],
      { cwd: d, encoding: "utf8" });

  const pre = runPreflight();
  const raw = execFileSync("cat", [join(d, ".claude", "preflight.ok")], { encoding: "utf8" }).trim();
  check("preflight.sh stamps three fields (epoch, sha, digest)",
    raw.split(/\s+/).length === 3, `${pre.status}: ${raw}`);
  check("fresh stamp on a dirty tree ⇒ passes", run(task("review"), at).decision === null);

  // The regression that started this: commit the very code the preflight verified.
  git("add", "-A"); git("commit", "-qm", "wip");
  const afterCommit = run(task("review"), at);
  check("committing the verified code ⇒ still passes (HEAD moved, code did not)",
    afterCommit.decision === null, `got ${afterCommit.decision} — ${afterCommit.reason}`);

  // The pipeline's own writes must never invalidate its own stamp.
  writeFileSync(join(d, "specs", "s.md"), "spec + DoD ticks\n");
  writeFileSync(join(d, "specs", "reports", "r2.txt"), "report\n");
  writeFileSync(join(d, ".claude", "pipeline-metrics.jsonl"), "{}\n");
  check("spec ticks, report buffer and metrics writes ⇒ still passes",
    run(task("review"), at).decision === null);

  // …and a real edit must.
  writeFileSync(join(d, "src.txt"), "code v2\n");
  const edited = run(task("review"), at);
  check("an uncommitted code edit ⇒ ask", edited.decision === "ask", edited.decision);
  check("…and the reason says the code changed", /code changed/.test(edited.reason || ""));

  // A brand-new untracked source file is a code change too (the sha never saw these).
  writeFileSync(join(d, "src.txt"), "code v1\n");
  writeFileSync(join(d, "extra.txt"), "new surface\n");
  check("a new untracked source file ⇒ ask", run(task("review"), at).decision === "ask");
  rmSync(join(d, "extra.txt"));
  check("reverting to the verified content ⇒ passes again",
    run(task("review"), at).decision === null);

  // The hook must never touch the caller's index — it computes in a throwaway one.
  const status = execFileSync("git", ["status", "--porcelain"], { cwd: d, encoding: "utf8" });
  check("the gate leaves the real index untouched (nothing staged)",
    !/^[MARCD]/m.test(status), status.trim());
}

// ── worktree awareness (the 1.3.3 known_heads fix) ───────────────────────────
console.log("gate.py — worktree awareness");
{
  const pf = { enabled: true, agents: ["review"], max_age_minutes: 30 };
  const d = scratch(); writeConfig(d, { ...GATE_CFG, preflight: pf });
  const mainHead = gitRepo(d, "main");
  const wt = join(d, "..", `wt-${Math.abs(mainHead.charCodeAt(0))}-${tmps.length}`);
  let wtHead = null;
  try {
    execFileSync("git", ["worktree", "add", "-q", "-b", "feature/w", wt], { cwd: d, stdio: "ignore" });
    tmps.push(wt);
    // The worktree MUST diverge, or its HEAD equals the main checkout's and the
    // test passes against the single-HEAD implementation too — a vacuous test
    // (mutation testing is how that was caught).
    writeFileSync(join(wt, "g.txt"), "y");
    execFileSync("git", ["add", "-A"], { cwd: wt, stdio: "ignore" });
    execFileSync("git", ["commit", "-qm", "wt"], { cwd: wt, stdio: "ignore" });
    wtHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: wt, encoding: "utf8" }).trim();
    if (wtHead === mainHead) wtHead = null; // did not diverge ⇒ nothing to prove
  } catch { /* worktree unsupported here — skip */ }

  if (wtHead) {
    // The preflight legitimately runs in the worktree while the Task dispatch
    // fires from the main checkout (or vice versa). Comparing against a single
    // HEAD flagged those as stale.
    writeFileSync(join(d, ".claude", "preflight.ok"), `${Math.floor(Date.now() / 1000)} ${wtHead}\n`);
    const r = run({ ...task("review"), cwd: d }, { projectDir: d });
    check("a stamp from a linked worktree's HEAD is accepted", r.decision === null,
      `got ${r.decision} — ${r.reason}`);
  } else {
    console.log("  – worktree test skipped (git worktree unavailable)");
  }
}

// ---------------------------------------------------------------------------
// Runtime dialects. Four runtimes host this hook and none of them agree on the
// envelope. A verdict emitted in the wrong shape is read as "allow" by every one of
// them — the gate would look installed, print JSON, and block nothing. Two of them
// also have no confirmation tier, where an honest `ask` must become a `deny` rather
// than fall through.
console.log("gate.py — runtime dialects");
{
  const d = scratch();
  gitRepo(d, "main");
  writeConfig(d, {
    deny: ["rm -rf /"], ask: ["git push"], ask_on_default_branch: [],
    default_branch: "main", preflight: { enabled: true, agents: ["review"] },
  });
  const raw = (payload, ...args) => {
    const r = spawnSync(python, [GATE, ...args], {
      input: JSON.stringify(payload), encoding: "utf8",
      env: { ...process.env, CLAUDE_PROJECT_DIR: d },
    });
    let json = null;
    try { json = JSON.parse((r.stdout || "").trim()); } catch { /* no verdict */ }
    return { json, status: r.status };
  };
  const push = { tool_name: "Bash", tool_input: { command: "git push" }, cwd: d };

  const cc = raw(push, "--runtime", "claude");
  check("claude: ask stays an ask, in the PreToolUse envelope",
    cc.json?.hookSpecificOutput?.permissionDecision === "ask");
  check("no --runtime flag behaves exactly as claude (pre-adapter registrations)",
    raw(push).json?.hookSpecificOutput?.permissionDecision === "ask");

  const cx = raw(push, "--runtime", "codex");
  check("codex: ask escalates to deny (its `ask` is parsed but never honoured)",
    cx.json?.hookSpecificOutput?.permissionDecision === "deny");
  check("…and the reason says why it was refused rather than queried",
    /no confirmation tier/.test(cx.json?.hookSpecificOutput?.permissionDecisionReason || ""));
  for (const tool_name of ['spawn_agent', 'Agent']) {
    const dispatch = raw({ tool_name, tool_input: { agent_type: 'review' }, cwd: d }, '--runtime', 'codex');
    check(`codex: ${tool_name} with agent_type is denied without a preflight stamp`,
      dispatch.json?.hookSpecificOutput?.permissionDecision === 'deny'
      && /preflight/i.test(dispatch.json?.hookSpecificOutput?.permissionDecisionReason || ''));
    check(`codex: ${tool_name} for an ungated implementer passes`,
      raw({ tool_name, tool_input: { agent_type: 'backend' }, cwd: d }, '--runtime', 'codex').json === null);
  }
  const nativeCwd = spawnSync(python, [GATE, '--runtime', 'codex'], {
    input: JSON.stringify({ tool_name: 'spawn_agent', tool_input: { agent_type: 'review' }, cwd: d }),
    cwd: root, encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: '', COHORTE_PROJECT_DIR: '' },
  });
  check('codex: payload cwd locates project config without Claude environment variables',
    JSON.parse(nativeCwd.stdout || '{}').hookSpecificOutput?.permissionDecision === 'deny');

  // Cursor sends the command at the top level and names no tool.
  const cu = raw({ hook_event_name: "beforeShellExecution", command: "git push", cwd: d },
    "--runtime", "cursor");
  check("cursor: its own envelope, and the top-level command is found",
    cu.json?.permission === "ask" && typeof cu.json?.user_message === "string");
  const cuDeny = raw({ hook_event_name: "beforeShellExecution", command: "rm -rf /", cwd: d },
    "--runtime", "cursor");
  check("cursor: a deny also exits 2 (its documented blocking code)",
    cuDeny.json?.permission === "deny" && cuDeny.status === 2);

  const ge = raw({ tool_name: "run_shell_command", tool_input: { command: "rm -rf /" }, cwd: d },
    "--runtime", "gemini");
  check("gemini: BeforeTool envelope, and run_shell_command is recognised as the shell",
    ge.json?.decision === "deny" && typeof ge.json?.reason === "string");

  // Gemini exposes each subagent as a tool of its own name, so the phase gate has to fire
  // on `tool_name: review` — not only on Claude's `Task` + subagent_type shape.
  const geDispatch = raw({ tool_name: "review", tool_input: {}, cwd: d }, "--runtime", "gemini");
  check("gemini: a subagent-as-tool dispatch still hits the preflight phase gate",
    geDispatch.json?.decision === "deny"
      && /preflight/i.test(geDispatch.json?.reason || ""));
  check("an unrelated tool is never gated on any runtime",
    raw({ tool_name: "read_file", tool_input: {}, cwd: d }, "--runtime", "gemini").json === null);
}

for (const d of tmps) { try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }

console.log("");
if (failures) { console.error(`test-gate: ${failures} failure(s)`); process.exit(1); }
console.log("test-gate: OK");
