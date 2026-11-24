#!/usr/bin/env node
// Behavioural tests for scripts/verify-run.sh — /cohorte-verify's process manager.
//
// The failure that matters is not a red check, it is a server left running: a stray dev server
// holds its port, the NEXT verify's ready probe answers against the stale build, and a feature is
// "verified" by code that is no longer on disk. So every path below — pass, failing smoke, ready
// timeout, a dev server that dies, a SIGTERM mid-run — asserts the server's pid is gone and its
// port refuses connections. The dev command is always a WRAPPER (`sh dev.sh` → node), so a script
// that killed only `$!` would leave the node grandchild alive and fail here.
//
// Also pinned: the shared-database refusal, the down-then-up rollback check, the gate consult
// (deny ⇒ SKIPPED, ask ⇒ exit 4 until --confirmed), and `rollback-check` on spec sections.
//
//   node scripts/test-verify.mjs

import { spawnSync, spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, connect } from "node:net";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const SCRIPT = join(root, "scripts", "verify-run.sh");

if (process.platform === "win32") {
  console.log("test-verify: skipped on Windows (verify-run.sh is a bash process manager)");
  process.exit(0);
}

let failures = 0;
const check = (name, cond, detail = "") => {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
};

const tmps = [];
// The developer's own ~/.claude/settings.json may allow anything: the gate cases read an empty
// user settings directory instead.
const userDir = mkdtempSync(join(tmpdir(), "verify-user-"));
tmps.push(userDir);
const iso = { env: { ...process.env, CLAUDE_CONFIG_DIR: userDir } };
const git =(cwd, ...args) => spawnSync("git", args, { cwd, encoding: "utf8" });

const SERVER = `
const http = require("http"), fs = require("fs");
const port = Number(process.argv[2]);
fs.writeFileSync("server.pid", String(process.pid));
if (process.argv[3] === "die") process.exit(7);
const delay = Number(process.argv[3] || 0);
setTimeout(() => http.createServer((q, r) => { r.writeHead(q.url === "/broken" ? 500 : 200); r.end("ok"); })
  .listen(port, "127.0.0.1"), delay);
`;
// Fake migrations: each call appends to db.log — the "database".
const MIGRATE = `require("fs").appendFileSync("db.log", process.argv[2] + "\\n"); process.exit(process.argv[3] === "fail" ? 5 : 0);`;

function repo() {
  const d = mkdtempSync(join(tmpdir(), "verify-"));
  tmps.push(d);
  git(d, "init", "-q", "-b", "main");
  git(d, "config", "user.email", "t@t"); git(d, "config", "user.name", "t");
  writeFileSync(join(d, "server.js"), SERVER);
  writeFileSync(join(d, "migrate.js"), MIGRATE);
  // `; true` keeps sh from exec-ing node: the wrapper stays the group leader and node a child.
  writeFileSync(join(d, "dev.sh"), 'node server.js "$@"; true\n');
  writeFileSync(join(d, ".gitignore"), "specs/reports/\nserver.pid\ndb.log\n");
  git(d, "add", "-A"); git(d, "commit", "-q", "-m", "init");
  git(d, "checkout", "-q", "-b", "feature/x");
  return d;
}

async function freePort() {
  return new Promise((res) => { const s = createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); }); });
}
const portOpen = (port) => new Promise((res) => {
  const c = connect(port, "127.0.0.1"); c.on("connect", () => { c.destroy(); res(true); }); c.on("error", () => res(false));
});
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const serverPid = (d) => existsSync(join(d, "server.pid")) ? Number(readFileSync(join(d, "server.pid"), "utf8")) : 0;
const checkPid = (d) => existsSync(join(d, "check.pid")) ? Number(readFileSync(join(d, "check.pid"), "utf8")) : 0;
const watchdogs = () => spawnSync("pgrep", ["-f", "sleep 297"], { encoding: "utf8" }).stdout.trim();
const run = (d, args, opts = {}) => spawnSync("bash", [SCRIPT, ...args], { cwd: d, encoding: "utf8", timeout: 60000, ...opts });
const verdict = (d, phase = "verify") => JSON.parse(readFileSync(join(d, "specs/reports", `x.${phase}.json`), "utf8"));
const status = (v, name) => (v.checks.find((c) => c.name === name) || {}).status;

async function assertStopped(d, port, label) {
  const pid = serverPid(d);
  check(`${label}: server pid ${pid} is gone`, pid > 0 && !alive(pid));
  check(`${label}: port ${port} refuses connections`, !(await portOpen(port)));
  check(`${label}: no pidfile left behind`, !existsSync(join(d, "specs/reports/x.verify/pgids")));
}

// ── 1. green: start → ready → smoke + e2e → stop ──────────────────────────────
{
  console.log("pass path");
  const d = repo(); const port = await freePort();
  const r = run(d, ["run", "x", "--dev", `sh dev.sh ${port} 300`, "--ready", `http://127.0.0.1:${port}/`,
    "--check", `smoke=curl -sf http://127.0.0.1:${port}/`, "--check", `e2e=node -e "process.exit(0)"`, "--ready-timeout", "20"]);
  check("exit 0 on PASS", r.status === 0, r.stderr + r.stdout);
  const v = verdict(d);
  check("verify.json verdict PASS", v.verdict === "PASS", JSON.stringify(v));
  check("checks ready/smoke/e2e all PASS", ["ready", "smoke", "e2e"].every((n) => status(v, n) === "PASS"), JSON.stringify(v.checks));
  check("evidence lists the dev log and the check logs", v.evidence.some((e) => e.endsWith("dev.log")) && v.evidence.some((e) => e.endsWith("smoke.log")));
  check("verify.md written with the checks table", /\| `smoke` \| PASS \|/.test(readFileSync(join(d, "specs/reports/x.verify.md"), "utf8")));
  check("checks see VERIFY_BASE_URL / VERIFY_ARTIFACTS", run(d, ["run", "x", "--dev", `sh dev.sh ${port}`, "--ready", `http://127.0.0.1:${port}/`,
    "--check", `env=test "$VERIFY_BASE_URL" = "http://127.0.0.1:${port}" && test -d "$VERIFY_ARTIFACTS"`]).status === 0);
  await assertStopped(d, port, "pass");
}

// ── 2. failing smoke ⇒ FAIL, server still stopped ─────────────────────────────
{
  console.log("failing smoke");
  const d = repo(); const port = await freePort();
  const r = run(d, ["run", "x", "--dev", `sh dev.sh ${port}`, "--ready", `http://127.0.0.1:${port}/`,
    "--check", `smoke=curl -sf http://127.0.0.1:${port}/broken`, "--check", "e2e=true"]);
  check("exit 1 on FAIL", r.status === 1, r.stdout + r.stderr);
  const v = verdict(d);
  check("verdict FAIL, smoke FAIL, the later e2e still ran", v.verdict === "FAIL" && status(v, "smoke") === "FAIL" && status(v, "e2e") === "PASS", JSON.stringify(v.checks));
  await assertStopped(d, port, "fail");
}

// ── 3. ready timeout ⇒ FAIL, the never-ready server is killed ─────────────────
{
  console.log("ready timeout");
  const d = repo(); const port = await freePort(); const other = await freePort();
  // The server listens on the WRONG port, so the probe never answers but the process lives.
  const r = run(d, ["run", "x", "--dev", `sh dev.sh ${other}`, "--ready", `http://127.0.0.1:${port}/`,
    "--ready-timeout", "2", "--check", "smoke=true"]);
  const v = verdict(d);
  check("exit 1, ready FAIL, smoke never ran", r.status === 1 && status(v, "ready") === "FAIL" && !status(v, "smoke"), JSON.stringify(v.checks));
  await assertStopped(d, other, "timeout");
}

// ── 4. dev server dies before ready ⇒ fast FAIL ───────────────────────────────
{
  console.log("dev dies");
  const d = repo(); const port = await freePort();
  const t0 = Date.now();
  const r = run(d, ["run", "x", "--dev", `node server.js ${port} die`, "--ready", `http://127.0.0.1:${port}/`, "--ready-timeout", "30"]);
  const v = verdict(d);
  check("exit 1 well before the ready timeout", r.status === 1 && Date.now() - t0 < 15000, `${r.status} after ${Date.now() - t0}ms`);
  check("ready FAIL names the early exit", /exited/.test((v.checks.find((c) => c.name === "ready") || {}).note || ""), JSON.stringify(v.checks));
}

// ── 5. something already answers ⇒ refuse, never verify someone else's server ──
{
  console.log("port already taken");
  const d = repo(); const port = await freePort();
  const squatter = spawn("node", ["-e", `require("http").createServer((q,r)=>r.end("x")).listen(${port},"127.0.0.1")`], { stdio: "ignore" });
  for (let i = 0; i < 50 && !(await portOpen(port)); i++) await new Promise((r) => setTimeout(r, 100));
  const r = run(d, ["run", "x", "--dev", `sh dev.sh ${port}`, "--ready", `http://127.0.0.1:${port}/`, "--check", "smoke=true"]);
  const v = verdict(d);
  check("exit 1, ready FAIL 'answered BEFORE'", r.status === 1 && /BEFORE/.test(v.checks[0].note), JSON.stringify(v.checks));
  check("the dev command was never started", !existsSync(join(d, "server.pid")));
  check("the other process was left alone", alive(squatter.pid));
  squatter.kill("SIGKILL");
}

// ── 6. SIGTERM mid-run ⇒ trap stops the server, verdict is FAIL (incomplete) ────
{
  console.log("killed mid-run");
  const d = repo(); const port = await freePort();
  const child = spawn("bash", [SCRIPT, "run", "x", "--dev", `sh dev.sh ${port}`, "--ready", `http://127.0.0.1:${port}/`,
    "--check", `e2e=node -e 'require("fs").writeFileSync("check.pid",String(process.pid));setTimeout(()=>{},30000)'`, "--check-timeout", "297"], { cwd: d, stdio: "ignore" });
  // Wait until the check itself is running (its pid file), not a fixed delay: slow runners race.
  for (let i = 0; i < 200 && !checkPid(d); i++) await new Promise((r) => setTimeout(r, 100));
  await new Promise((r) => setTimeout(r, 300));
  child.kill("SIGTERM");
  await new Promise((r) => child.on("exit", r));
  const v = verdict(d);
  check("an interrupted run leaves FAIL, never a stale PASS", v.verdict === "FAIL", JSON.stringify(v));
  await assertStopped(d, port, "sigterm");
  check("sigterm: the in-flight check is gone too", checkPid(d) > 0 && !alive(checkPid(d)));
  check("sigterm: no watchdog left sleeping", watchdogs() === "", watchdogs());
}

// ── 6b. SIGKILL skips every trap ⇒ the pidfile lets `stop` (or the next run) reap it ──
{
  console.log("SIGKILLed run");
  const d = repo(); const port = await freePort();
  const child = spawn("bash", [SCRIPT, "run", "x", "--dev", `sh dev.sh ${port}`, "--ready", `http://127.0.0.1:${port}/`,
    "--check", `e2e=node -e 'require("fs").writeFileSync("check.pid",String(process.pid));setTimeout(()=>{},30000)'`, "--check-timeout", "297"], { cwd: d, stdio: "ignore" });
  // Wait until the check itself is running (its pid file), not a fixed delay: slow runners race.
  for (let i = 0; i < 200 && !checkPid(d); i++) await new Promise((r) => setTimeout(r, 100));
  await new Promise((r) => setTimeout(r, 300));
  child.kill("SIGKILL");
  await new Promise((r) => child.on("exit", r));
  check("after SIGKILL the server is still up (no trap ran) and a pidfile names it",
    (await portOpen(port)) && existsSync(join(d, "specs/reports/x.verify/pgids")));
  const r = run(d, ["stop", "x"]);
  check("`verify-run.sh stop x` reaps it", r.status === 0, r.stdout + r.stderr);
  await assertStopped(d, port, "sigkill");
  check("sigkill: the in-flight check and its watchdog were reaped as well", checkPid(d) > 0 && !alive(checkPid(d)) && watchdogs() === "", watchdogs());
}

// ── 6c. the pgids file is the agent's to write: `stop` kills only groups it started ──
{
  console.log("forged pgids");
  const d = repo();
  // A detached process of the user's (cohorte ui, a detached drive): its own group leader.
  const victim = spawn("node", ["-e", "setTimeout(()=>{},30000)"], { stdio: "ignore", detached: true });
  const bashVictim = spawn("bash", ["-c", "sleep 30; true", "x"], { stdio: "ignore", detached: true });
  await new Promise((r) => setTimeout(r, 300));
  mkdirSync(join(d, "specs/reports/x.verify"), { recursive: true });
  const fake = "0123456789abcdef0123";
  writeFileSync(join(d, "specs/reports/x.verify/pgids"),
    [`${victim.pid}`, `${victim.pid} ${fake}`, `${bashVictim.pid} ${fake}`, `-1 ${fake}`, `0 ${fake}`, `1 ${fake}`, `${process.pid} ${fake}`, "$(touch pwned) x"].join("\n") + "\n");
  const r = run(d, ["stop", "x"]);
  check("stop exits 0 and says it refused", r.status === 0 && /refused/.test(r.stderr), r.stdout + r.stderr);
  check("a process this script did not start is left alone", alive(victim.pid) && alive(bashVictim.pid));
  check("nothing in the file is evaluated", !existsSync(join(d, "pwned")));
  // the same file met at the start of a run is not trusted either
  writeFileSync(join(d, "specs/reports/x.verify/pgids"), `${victim.pid} ${fake}\n`);
  run(d, ["run", "x", "--check", "smoke=true"]);
  check("…nor by the reap at the start of the next run", alive(victim.pid));
  victim.kill("SIGKILL"); bashVictim.kill("SIGKILL");
}

// ── 6d. --out and the id never reach the machine-wide install ───────────────────
{
  console.log("outputs stay out of the cohorte install");
  const d = repo();
  const cfg = mkdtempSync(join(tmpdir(), "verify-cfg-")); tmps.push(cfg);
  mkdirSync(join(cfg, "cohorte", "lib"), { recursive: true }); mkdirSync(join(cfg, "cohorte-ui"), { recursive: true });
  const e = { env: { ...process.env, CLAUDE_CONFIG_DIR: cfg } };
  for (const [label, args] of [
    ["--out in <config>/cohorte-ui", ["run", "x", "--out", join(cfg, "cohorte-ui", "runs"), "--check", "smoke=true"]],
    ["--out in the core", ["run", "x", "--out", join(cfg, "cohorte", "lib"), "--check", "smoke=true"]],
    ["--out through a symlink into the core", ["run", "x", "--out", "core-link/x", "--check", "smoke=true"]],
    ["--out with ..", ["run", "x", "--out", "specs/../../x", "--check", "smoke=true"]],
    ["an id with a slash", ["run", "../../x", "--check", "smoke=true"]],
    ["stop with --out in the core", ["stop", "x", "--out", join(cfg, "cohorte")]],
  ]) {
    if (label.includes("symlink")) spawnSync("ln", ["-sfn", join(cfg, "cohorte"), join(d, "core-link")]);
    const r = run(d, args, e);
    check(`${label} ⇒ refused (exit 2)`, r.status === 2 && /install|id must|\.\./.test(r.stderr), `${r.status} ${r.stderr}`);
  }
  check("nothing was written into the install", spawnSync("find", [cfg, "-type", "f"], { encoding: "utf8" }).stdout.trim() === "");
  check("the default --out still works", run(d, ["run", "x", "--check", "smoke=true"], e).status === 0);
}

// ── 7. check timeout ⇒ FAIL 124, the check's own children killed ──────────────
{
  console.log("check timeout");
  const d = repo();
  const r = run(d, ["run", "x", "--check", `e2e=node -e 'require("fs").writeFileSync("server.pid",String(process.pid));setTimeout(()=>{},60000)'; true`, "--check-timeout", "2"]);
  const v = verdict(d);
  check("e2e FAIL with exit 124", r.status === 1 && v.checks[0].exit === 124, JSON.stringify(v.checks));
  const pid = serverPid(d);
  check("the timed-out check's grandchild is gone", pid > 0 && !alive(pid));
}

// ── 8. migrations: up, down-then-up, failing down, revert phase ───────────────
{
  console.log("migrations");
  let d = repo(); let port = await freePort();
  let r = run(d, ["run", "x", "--migrate", "node migrate.js up", "--migrate-down", "node migrate.js down", "--db", "local",
    "--dev", `sh dev.sh ${port}`, "--ready", `http://127.0.0.1:${port}/`, "--check", "smoke=true"]);
  let v = verdict(d);
  check("migrate + rollback + smoke PASS", r.status === 0 && status(v, "migrate") === "PASS" && status(v, "rollback") === "PASS", JSON.stringify(v.checks));
  check("db saw up, down, up — in that order, before the app", readFileSync(join(d, "db.log"), "utf8") === "up\ndown\nup\n");
  await assertStopped(d, port, "migrate");

  d = repo();
  r = run(d, ["run", "x", "--migrate", "node migrate.js up", "--migrate-down", "node migrate.js down fail", "--db", "local", "--dev", "sh dev.sh 1", "--ready", "true"]);
  v = verdict(d);
  check("failing down ⇒ FAIL rollback, app never started", r.status === 1 && status(v, "rollback") === "FAIL" && !existsSync(join(d, "server.pid")), JSON.stringify(v.checks));

  d = repo();
  r = run(d, ["run", "x", "--migrate", "node migrate.js up fail", "--db", "local", "--dev", "sh dev.sh 1", "--ready", "true"]);
  check("failing up ⇒ FAIL, app never started", r.status === 1 && status(verdict(d), "migrate") === "FAIL" && !existsSync(join(d, "server.pid")));

  d = repo();
  r = run(d, ["run", "x", "--phase", "revert", "--migrate-down", "node migrate.js down", "--db", "local"]);
  check("revert phase runs the down migration only", r.status === 0 && readFileSync(join(d, "db.log"), "utf8") === "down\n"
    && status(verdict(d, "revert"), "migrate-down") === "PASS", r.stdout + r.stderr);

  d = repo();
  r = run(d, ["run", "x", "--phase", "revert", "--migrate", "node migrate.js up", "--migrate-down", "node migrate.js down", "--db", "local"]);
  check("revert phase with --migrate: up first, then down", r.status === 0 && readFileSync(join(d, "db.log"), "utf8") === "up\ndown\n", r.stdout + r.stderr);

  check("a migration flag without --db is a usage error", run(repo(), ["run", "x", "--migrate", "node migrate.js up"]).status === 2);
}

// ── 9. shared database: refused unless this is a worktree with its own DB ─────
{
  console.log("shared database");
  const d = repo();
  let r = run(d, ["run", "x", "--migrate", "node migrate.js up", "--migrate-down", "node migrate.js down", "--db", "shared",
    "--db-per-worktree", "true", "--dev", "sh dev.sh 1", "--ready", "true"]);
  const v = verdict(d);
  check("shared DB in the main checkout ⇒ SKIPPED (exit 3)", r.status === 3 && v.verdict === "SKIPPED", r.stdout + r.stderr);
  check("…nothing migrated, app not started", !existsSync(join(d, "db.log")) && !existsSync(join(d, "server.pid")));

  const wt = join(d, "..", `${d.split("/").pop()}-wt`); tmps.push(wt);
  git(d, "worktree", "add", "-q", "-b", "feature/y", wt);
  r = run(wt, ["run", "x", "--migrate", "node migrate.js up", "--db", "shared", "--db-per-worktree", "true"]);
  check("a bare `git worktree add` (no slot, so no DB of its own) ⇒ refused", r.status === 3 && !existsSync(join(wt, "db.log")), r.stdout + r.stderr);
  mkdirSync(join(d, ".worktrees"), { recursive: true });
  writeFileSync(join(d, ".worktrees/slots.tsv"), "y\t1\n");
  r = run(wt, ["run", "x", "--migrate", "node migrate.js up", "--db", "shared", "--db-per-worktree", "true"]);
  check("shared DB + per-worktree DB, in a registered feature worktree ⇒ allowed", r.status === 0 && existsSync(join(wt, "db.log")), r.stdout + r.stderr);
  r = run(wt, ["run", "x", "--migrate", "node migrate.js up", "--db", "shared", "--db-per-worktree", "false"]);
  check("shared DB without per-worktree DBs ⇒ refused even in a worktree", r.status === 3);
}

// ── 10. the project gate is consulted before anything runs ────────────────────
{
  console.log("gate");
  const d = repo();
  mkdirSync(join(d, ".claude/hooks"), { recursive: true });
  copyFileSync(join(root, "core/hooks/gate.py"), join(d, ".claude/hooks/cohorte-gate.py"));
  writeFileSync(join(d, ".claude/gate-config.json"), JSON.stringify({
    deny: ["node migrate.js down"], ask: ["node migrate.js up"], ask_on_default_branch: [], default_branch: "main" }));
  const args = ["run", "x", "--migrate", "node migrate.js up", "--migrate-down", "node migrate.js down", "--db", "local", "--check", "smoke=true"];
  let r = run(d, args);
  check("an `ask` command ⇒ exit 4, listed, nothing ran", r.status === 4 && /node migrate\.js up/.test(r.stderr) && !existsSync(join(d, "db.log")), r.stdout + r.stderr);
  r = run(d, [...args, "--confirmed"]);
  const v = verdict(d);
  check("--confirmed runs it; the denied down is SKIPPED, never run", r.status === 0 && status(v, "rollback") === "SKIPPED"
    && readFileSync(join(d, "db.log"), "utf8") === "up\n", JSON.stringify(v.checks));

  // Several checks: the consult loop reads them from a file — a gate that ate its stdin would
  // silently swallow the rest. The second one is denied and must never run.
  writeFileSync(join(d, ".claude/gate-config.json"), JSON.stringify({
    deny: ["node migrate.js denied", "node probe.js"], ask: [], ask_on_default_branch: [], default_branch: "main" }));
  // The profile declares the commands /cohorte-verify passes: those run with no confirmation.
  writeFileSync(join(d, ".claude/profile.json"), JSON.stringify({
    commands: { dev: "sh dev.sh 1", smoke: "node migrate.js smoke", e2e: "node migrate.js denied" },
    verify: { surfaces: { web: { smoke: "node migrate.js web" } } } }));
  r = run(d, ["run", "x", "--check", "smoke=node migrate.js smoke", "--check", "e2e=node migrate.js denied", "--check", "smoke:web=node migrate.js web"], iso);
  const v2 = verdict(d);
  check("denied 2nd of 3 checks ⇒ SKIPPED, the 1st and 3rd ran", status(v2, "smoke") === "PASS" && status(v2, "e2e") === "SKIPPED"
    && status(v2, "smoke:web") === "PASS" && !/denied/.test(readFileSync(join(d, "db.log"), "utf8")), JSON.stringify(v2.checks));
  r = run(d, ["run", "x", "--dev", "sh dev.sh 1", "--ready", "node probe.js"], iso);
  check("a denied ready probe ⇒ SKIPPED, the app never started", r.status === 3 && status(verdict(d), "ready") === "SKIPPED" && !existsSync(join(d, "server.pid")), r.stdout + r.stderr);

  // A command no gate rule matches is NOT an allow: Claude Code auto-approves `verify-run.sh …`
  // (the allowlisted <core>/pipeline/scripts/), so it would run with no prompt at all. Only the
  // profile's commands and permissions.allow rules run unconfirmed; anything else ⇒ exit 4.
  rmSync(join(d, "db.log"), { force: true });
  for (const cmd of ["node migrate.js evil", "python3 -c 'open(\"db.log\",\"a\").write(\"evil\\n\")'", "touch db.log"]) {
    r = run(d, ["run", "x", "--check", `smoke=${cmd}`], iso);
    check(`an undeclared check (${cmd.slice(0, 30)}) ⇒ exit 4, listed, nothing ran`,
      r.status === 4 && r.stderr.includes(cmd) && !existsSync(join(d, "db.log")), r.status + r.stdout + r.stderr);
  }
  r = run(d, ["run", "x", "--check", "smoke=node migrate.js smoke", "--check", "e2e=node migrate.js evil"], iso);
  check("one undeclared check among declared ones ⇒ exit 4, NOTHING ran", r.status === 4 && !existsSync(join(d, "db.log")), r.stdout + r.stderr);
  r = run(d, ["run", "x", "--check", "smoke=node migrate.js evil", "--check", "e2e=node migrate.js denied", "--confirmed"], iso);
  check("--confirmed (the human said yes in chat) runs the undeclared one, never the denied one",
    status(verdict(d), "smoke") === "PASS" && status(verdict(d), "e2e") === "SKIPPED"
    && readFileSync(join(d, "db.log"), "utf8") === "evil\n", r.stdout + r.stderr);
  rmSync(join(d, "db.log"), { force: true });
  r = run(d, ["run", "x", "--check", "smoke=node migrate.js smoke  "], iso);
  check("a declared command (whitespace aside) runs unconfirmed", r.status === 0, r.stdout + r.stderr);
  writeFileSync(join(d, ".claude/settings.local.json"), JSON.stringify({ permissions: { allow: ["Bash(node migrate.js allowed:*)"] } }));
  r = run(d, ["run", "x", "--check", "smoke=node migrate.js allowed --fast"], iso);
  check("a permissions.allow rule of the project's settings ⇒ runs unconfirmed", r.status === 0 && /allowed/.test(readFileSync(join(d, "db.log"), "utf8")), r.stdout + r.stderr);
  rmSync(join(d, ".claude/settings.local.json"));
  rmSync(join(d, ".claude/profile.json"));

  // From a linked worktree the gate still finds the main checkout's config.
  writeFileSync(join(d, ".claude/gate-config.json"), JSON.stringify({
    deny: [], ask: ["node migrate.js up"], ask_on_default_branch: [], default_branch: "main" }));
  const wt = join(d, "..", `${d.split("/").pop()}-gwt`); tmps.push(wt);
  git(d, "worktree", "add", "-q", "-b", "feature/g", wt);
  r = run(wt, ["run", "x", "--migrate", "node migrate.js up", "--db", "local"]);
  check("in a linked worktree the main checkout's gate still asks", r.status === 4 && !existsSync(join(wt, "db.log")), r.stdout + r.stderr);
}

// ── 10b. screenshots: a local Playwright CLI, evidence only ───────────────────
{
  console.log("screenshots");
  const d = repo(); const port = await freePort();
  const base = ["run", "x", "--dev", `sh dev.sh ${port}`, "--ready", `http://127.0.0.1:${port}/`, "--screenshot", `home=http://127.0.0.1:${port}/`];
  let r = run(d, base);
  let v = verdict(d);
  check("no local Playwright ⇒ screenshot SKIPPED, verdict still PASS", r.status === 0 && status(v, "screenshot:home") === "SKIPPED", JSON.stringify(v.checks));
  mkdirSync(join(d, "node_modules/.bin"), { recursive: true });
  // Stub CLI: `playwright screenshot --viewport-size=W,H <url> <file>` writes <file>.
  writeFileSync(join(d, "node_modules/.bin/playwright"), '#!/bin/sh\nfor a; do f="$a"; done\necho png > "$f"\n', { mode: 0o755 });
  r = run(d, base);
  v = verdict(d);
  check("with a local Playwright ⇒ mobile + desktop shots in evidence", r.status === 0 && status(v, "screenshot:home") === "PASS"
    && v.evidence.some((e) => e.endsWith("home.mobile.png")) && v.evidence.some((e) => e.endsWith("home.desktop.png"))
    && existsSync(join(d, "specs/reports/x.verify/home.desktop.png")), JSON.stringify(v));
  // A screenshot URL is data: it never reaches a shell as text, and only http(s) is captured.
  r = run(d, ["run", "x", "--dev", `sh dev.sh ${port}`, "--ready", `http://127.0.0.1:${port}/`,
    "--screenshot", `inj=http://127.0.0.1:${port}/"; touch pwned-a; echo "`, "--screenshot", `sub=http://127.0.0.1:${port}/$(touch pwned-b)`,
    "--screenshot", "file=file:///etc/passwd"]);
  v = verdict(d);
  check("a screenshot URL with shell syntax is never executed", !existsSync(join(d, "pwned-a")) && !existsSync(join(d, "pwned-b")), r.stdout + r.stderr);
  check("a non-http(s) screenshot URL ⇒ SKIPPED, not captured", status(v, "screenshot:file") === "SKIPPED"
    && !existsSync(join(d, "specs/reports/x.verify/file.mobile.png")), JSON.stringify(v.checks));
  await assertStopped(d, port, "screenshots");
}

// ── 11. tree digest: a check that writes feature code fails the run ───────────
{
  console.log("digest");
  const d = repo();
  const base = git(d, "rev-parse", "HEAD").stdout.trim();
  let r = run(d, ["run", "x", "--digest-base", base, "--check", "smoke=true"]);
  let v = verdict(d);
  check("digest recorded", r.status === 0 && /^[0-9a-f]{16}$/.test(v.digest || ""), JSON.stringify(v));
  r = run(d, ["run", "x", "--digest-base", base, "--check", "smoke=echo x > leaked.txt"]);
  v = verdict(d);
  check("a check that leaks a file into the diff ⇒ tree FAIL", r.status === 1 && status(v, "tree") === "FAIL", JSON.stringify(v.checks));
  check("nothing run ⇒ SKIPPED (exit 3)", run(d, ["run", "x", "--skip", "e2e=no commands.e2e"]).status === 3);
}

// ── 12. rollback-check ─────────────────────────────────────────────────────────
{
  console.log("rollback-check");
  const d = repo();
  const spec = (fm, body) => { writeFileSync(join(d, "s.md"), `---\nfeature_id: x\n${fm}\n---\n\n# X\n\n${body}\n## Remediation\n`); return run(d, ["rollback-check", "s.md"]).status; };
  const stub = "## Rollback\n\n> Required when migrations: true.\n\n- **Revert:** …\n- **Data:** …\n- **Migration down:** …\n\n";
  check("migrations: true + template stub ⇒ exit 1", spec("migrations: true", stub) === 1);
  for (const t of ["spec.template.md", "patch.template.md"]) {
    const tpl = readFileSync(join(root, "core/templates", t), "utf8").replace(/^migrations: false/m, "migrations: true");
    writeFileSync(join(d, "t.md"), tpl);
    check(`the shipped ${t} Rollback section counts as empty`, run(d, ["rollback-check", "t.md"]).status === 1);
    writeFileSync(join(d, "t.md"), tpl.replace("- **Data:** …", "- **Data:** the `notes.archived_at` values are lost"));
    check(`…and one filled line in it counts as filled`, run(d, ["rollback-check", "t.md"]).status === 0);
  }
  check("migrations: true + no section ⇒ exit 1", spec("migrations: true", "") === 1);
  check("migrations: true + one filled line ⇒ exit 0", spec("migrations: true", stub.replace("**Data:** …", "**Data:** the new column is dropped; its values are lost")) === 0);
  check("migrations: false ⇒ exit 0", spec("migrations: false", stub) === 0);
  check("no migrations key (legacy spec) ⇒ exit 0", spec("status: frozen", stub) === 0);
  check("a `migrations: true` line in the body is not front-matter", spec("status: frozen", "migrations: true\n" + stub) === 0);
  writeFileSync(join(d, "c.md"), `---\nfeature_id: x\nmigrations: true\n---\n\n${stub}`.replace(/\n/g, "\r\n"));
  check("a CRLF spec with migrations: true + stub ⇒ exit 1 (never fails open)", run(d, ["rollback-check", "c.md"]).status === 1);
}

for (const t of tmps) rmSync(t, { recursive: true, force: true });
if (failures) { console.error(`\ntest-verify: ${failures} failure(s)`); process.exit(1); }
console.log("\ntest-verify: OK");
