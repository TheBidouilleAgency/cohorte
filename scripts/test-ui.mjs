#!/usr/bin/env node
// Tests for `cohorte ui`: the project registry and the dashboard's HTTP surface.
// The security cases matter most — this origin will launch commands in a later release.
//
//   node scripts/test-ui.mjs

import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import http from "node:http";

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL("..", import.meta.url));
const registry = require(join(root, "lib/registry.js"));
const { create } = require(join(root, "ui/server.js"));

let failures = 0;
const check = (name, cond, detail = "") => {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
};

const tmps = [];
const scratch = () => { const d = realpathSync(mkdtempSync(join(tmpdir(), "cohorte-ui-"))); tmps.push(d); return d; };
const write = (p, s) => { mkdirSync(join(p, ".."), { recursive: true }); writeFileSync(p, s); };
const git = (cwd, ...a) => spawnSync("git", ["-C", cwd, ...a], { encoding: "utf8" });

const home = scratch();
process.env.HOME = home; // the doctor must not read the developer's real ~/.claude
const globalDir = join(home, ".claude");
const storePath = join(home, ".claude.json");

const proj = join(home, "app");
mkdirSync(proj);
git(proj, "init", "-q");
write(join(proj, "PIPELINE.md"), "# app\n");
write(join(proj, "specs", "f1.md"), "---\nfeature_id: f1\ntitle: First\nstatus: draft\nbranch: feat/f1\n---\nbody\n");
write(join(proj, "specs", "reports", "f1.verdict.json"), JSON.stringify({ verdict: "SHIP" }));
git(proj, "add", "-A");
git(proj, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
write(join(proj, ".claude", "profile.json"), JSON.stringify({ name: "app",
  commands: { dev: `node -e "console.log('hello-dev');setInterval(()=>{},1000)"`, dev_ready: `node -e "process.exit(0)"` } }));
const plain = join(home, "plain");
mkdirSync(plain);

console.log("registry");
{
  check("empty at first", registry.load(globalDir).length === 0);
  let err = null;
  try { registry.add(globalDir, plain); } catch (e) { err = e; }
  check("refuses a folder without cohorte", err instanceof registry.RegistryError);
  err = null;
  try { registry.add(globalDir, "relative/path"); } catch (e) { err = e; }
  check("refuses a relative path", err instanceof registry.RegistryError);
  const r = registry.add(globalDir, join(proj, "specs"));
  check("a subfolder registers the git root", r.created && r.project.root === proj, JSON.stringify(r));
  check("no duplicate", registry.add(globalDir, proj).created === false && registry.load(globalDir).length === 1);
  writeFileSync(storePath, JSON.stringify({ projects: { [proj]: {}, [plain]: {}, "/nope": {} } }));
  check("discover skips registered, plain and missing folders", registry.discover(globalDir, storePath).length === 0);
  check("worktrees lists the main checkout", registry.worktrees(proj).length === 1 || git(proj, "rev-parse", "HEAD").status !== 0);
  check("remove", registry.remove(globalDir, r.project.id) && registry.load(globalDir).length === 0);
}

console.log("dashboard http");
// A stand-in for `claude -p` speaking the same stream-json control protocol (verified against claude 2.1.326).
const fake = join(home, "fake-claude.js");
writeFileSync(fake, `#!/usr/bin/env node
const rl = require("readline").createInterface({ input: process.stdin });
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
const waiting = new Map();
let prompt = null, stage = 0;
const ask = (req) => { const id = "r" + (++stage); waiting.set(id, true); out({ type: "control_request", request_id: id, request: req }); return id; };
rl.on("line", (line) => {
  const v = JSON.parse(line);
  if (v.type === "user") {
    prompt = v.message.content[0].text;
    out({ type: "system", subtype: "init", session_id: "s1" });
    out({ type: "assistant", message: { content: [{ type: "text", text: "starting " + prompt }, { type: "tool_use", id: "t1", name: "Bash", input: { command: "rm -rf build" } }] } });
    if (prompt.includes("hang")) return;
    ask({ subtype: "can_use_tool", tool_name: "Bash", input: { command: "rm -rf build" }, decision_reason: "gate: confirm", decision_reason_type: "hook" });
  } else if (v.type === "control_response") {
    const r = v.response.response;
    if (stage === 1) {
      out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", is_error: r.behavior === "deny", content: r.behavior === "deny" ? r.message : "ok" }] } });
      ask({ subtype: "can_use_tool", tool_name: "AskUserQuestion", input: { questions: [{ question: "Which db?", header: "DB", multiSelect: false, options: [{ label: "pg", description: "" }, { label: "sqlite", description: "" }] }] } });
    } else {
      out({ type: "result", subtype: "success", is_error: false, result: "answers=" + JSON.stringify(r.updatedInput.answers), total_cost_usd: 0.01, duration_ms: 5 });
    }
  }
});
rl.on("close", () => process.exit(0));
`);
chmodSync(fake, 0o755);
process.env.COHORTE_CLAUDE_BIN = fake;
write(join(globalDir, "commands", "cohorte-build.md"), "---\ndescription: Build a frozen spec\nargument-hint: <id>\n---\nbody\n");
const ui = create({ globalDir, version: "0.0.0-test", storePath });
const l = await ui.listen(0);
const call = (path, { method = "GET", headers = {}, body, token = l.token } = {}) => new Promise((resolve, reject) => {
  const req = http.request({ host: "127.0.0.1", port: l.port, path, method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers } }, (res) => {
    let data = "";
    res.on("data", (c) => { data += c; });
    res.on("end", () => { let json = null; try { json = JSON.parse(data); } catch { /* not json */ } resolve({ status: res.statusCode, headers: res.headers, json, text: data }); });
  });
  req.on("error", reject);
  if (body !== undefined) req.write(body);
  req.end();
});
const JSON_H = { "Content-Type": "application/json" };

try {
  check("page is served with a CSP", await call("/", { token: null }).then((r) => r.status === 200 && /script-src 'self'/.test(r.headers["content-security-policy"])));
  check("no path traversal on static files", (await call("/..%2f..%2fpackage.json", { token: null })).status === 404);
  check("api without token → 401", (await call("/api/state", { token: null })).status === 401);
  check("api with a wrong token → 401", (await call("/api/state", { token: "nope" })).status === 401);
  check("foreign Host → 403 (DNS rebinding)", (await call("/api/state", { headers: { Host: "evil.example:80" } })).status === 403);
  check("foreign Origin → 403", (await call("/api/state", { headers: { Origin: "http://evil.example" } })).status === 403);
  check("own Origin passes", (await call("/api/state", { headers: { Origin: l.origin } })).status === 200);
  check("POST without JSON content type → 415", (await call("/api/projects", { method: "POST", body: "path=/x", headers: { "Content-Type": "application/x-www-form-urlencoded" } })).status === 415);
  check("POST with a bad path → 400", (await call("/api/projects", { method: "POST", headers: JSON_H, body: JSON.stringify({ path: plain }) })).status === 400);

  const added = await call("/api/projects", { method: "POST", headers: JSON_H, body: JSON.stringify({ path: proj }) });
  check("add a project → 201", added.status === 201 && added.json.created, JSON.stringify(added.json));
  const id = added.json.project.id;
  const st = await call("/api/state");
  check("state lists it with spec counts", st.json.projects.length === 1 && st.json.projects[0].specCounts.draft === 1, JSON.stringify(st.json));
  const d = await call(`/api/projects/${id}`);
  check("detail has checks, specs and worktrees", d.status === 200 && d.json.doctor.checks.length > 0 && d.json.specs.length === 1 && Array.isArray(d.json.worktrees));
  const sp = await call(`/api/projects/${id}/specs/f1`);
  check("spec detail returns body and reports", sp.status === 200 && sp.json.body.includes("body") && sp.json.reports.verdict.verdict === "SHIP");
  check("spec id is validated", (await call(`/api/projects/${id}/specs/..%2f..%2fPIPELINE`)).status === 404);
  check("unknown project id → 404", (await call("/api/projects/ffffffffff")).status === 404);
  check("a raw path is not an id", (await call(`/api/projects/${encodeURIComponent(proj)}`)).status === 404);
  const m = await call(`/api/projects/${id}/metrics`);
  check("metrics answers (json or a clean error)", m.status === 200 || m.status === 502, String(m.status));
  // --- step 2: worktrees and dev servers ---
  const post = (path, obj) => call(path, { method: "POST", headers: JSON_H, body: JSON.stringify(obj) });
  const waitJob = async (jid, want) => {
    for (let i = 0; i < 60; i++) {
      const j = (await call(`/api/projects/${id}/jobs/${jid}/logs?since=0`)).json;
      if (want.includes(j.status)) return j;
      await new Promise((r) => setTimeout(r, 150));
    }
    return (await call(`/api/projects/${id}/jobs/${jid}/logs?since=0`)).json;
  };
  check("bad feature id → 400", (await post(`/api/projects/${id}/worktrees`, { feature: "../evil" })).status === 400);
  const cw = await post(`/api/projects/${id}/worktrees`, { feature: "feat-x" });
  check("create worktree → 202", cw.status === 202, JSON.stringify(cw.json));
  const cwj = await waitJob(cw.json.job.id, ["done", "failed"]);
  check("worktree job finishes", cwj.status === "done", JSON.stringify(cwj));
  const d2 = (await call(`/api/projects/${id}`)).json;
  check("detail now lists 2 worktrees, main first", d2.worktrees.length === 2 && d2.worktrees[0].main === true && d2.dev.command.includes("hello-dev"));
  const wt = d2.worktrees[1].path;
  check("a path that is not a worktree → 404", (await post(`/api/projects/${id}/dev`, { worktree: home })).status === 404);
  const dv = await post(`/api/projects/${id}/dev`, { worktree: wt });
  check("start dev → 202", dv.status === 202, JSON.stringify(dv.json));
  const dj = await waitJob(dv.json.job.id, ["ready"]);
  check("dev server is ready and its logs stream", dj.status === "ready" && dj.lines.some((x) => x.includes("hello-dev")), JSON.stringify(dj));
  check("second start in the same worktree → 409", (await post(`/api/projects/${id}/dev`, { worktree: wt })).status === 409);
  check("remove refused while dev runs", (await post(`/api/projects/${id}/worktrees/remove`, { path: wt })).status === 409);
  check("main checkout cannot be removed", (await post(`/api/projects/${id}/worktrees/remove`, { path: proj })).status === 400);
  check("stop → 200", (await post(`/api/projects/${id}/jobs/${dj.id}/stop`, {})).status === 200);
  const dstop = await waitJob(dj.id, ["stopped"]);
  check("dev server stopped, process group gone", dstop.status === "stopped" && (() => { try { process.kill(dj.pid, 0); return false; } catch { return true; } })());
  const rm = await post(`/api/projects/${id}/worktrees/remove`, { path: wt });
  check("remove worktree → job done", rm.status === 202 && (await waitJob(rm.json.job.id, ["done", "failed"])).status === "done");
  check("back to 1 worktree", (await call(`/api/projects/${id}`)).json.worktrees.length === 1);
  check("unknown job → 404", (await call(`/api/projects/${id}/jobs/deadbeef/logs`)).status === 404);

  // the project's gate has the last word
  const gate = join(proj, ".claude", "hooks", "cohorte-gate.py");
  write(gate, "import sys; sys.exit(2)\n");
  const denied = await post(`/api/projects/${id}/dev`, { worktree: proj });
  check("gate deny → 403, nothing started", denied.status === 403, JSON.stringify(denied.json));
  write(gate, "import sys; sys.exit(1)\n");
  const asked = await post(`/api/projects/${id}/dev`, { worktree: proj });
  check("gate ask → 409 needsConfirmation", asked.status === 409 && asked.json.needsConfirmation === true);
  const okd = await post(`/api/projects/${id}/dev`, { worktree: proj, confirmed: true });
  check("gate ask + confirmed → 202", okd.status === 202);
  await post(`/api/projects/${id}/jobs/${okd.json.job.id}/stop`, {});
  await waitJob(okd.json.job.id, ["stopped"]);

  // --- step 3: pipeline runs through claude -p, gates answered over HTTP ---
  const cmds = (await call("/api/commands")).json.commands;
  check("lists the installed /cohorte-* commands", cmds.length === 1 && cmds[0].name === "cohorte-build" && cmds[0].description === "Build a frozen spec" && cmds[0].argumentHint === "<id>", JSON.stringify(cmds));
  const runsUrl = `/api/projects/${id}/runs`;
  check("unknown command → 400", (await post(runsUrl, { worktree: proj, command: "rm -rf /" })).status === 400);
  check("a command name outside cohorte-* is refused", (await post(runsUrl, { worktree: proj, command: "cohorte-nope" })).status === 400);
  check("multi-line args → 400", (await post(runsUrl, { worktree: proj, command: "cohorte-build", args: "a\n/exit" })).status === 400);
  writeFileSync(storePath, JSON.stringify({ projects: {} }));
  const untrusted = await post(runsUrl, { worktree: proj, command: "cohorte-build", args: "f1" });
  check("untrusted folder → 409 with the fix, nothing started", untrusted.status === 409 && untrusted.json.untrusted === true && !!untrusted.json.fix, JSON.stringify(untrusted.json));
  writeFileSync(storePath, JSON.stringify({ projects: { [proj]: { hasTrustDialogAccepted: true } } }));
  const started = await post(runsUrl, { worktree: proj, command: "/cohorte-build", args: "f1", permissionMode: "bypassPermissions" });
  check("run starts → 202 (bypassPermissions is downgraded to default)", started.status === 202 && started.json.run.permissionMode === "default", JSON.stringify(started.json));
  const rid = started.json.run.id;
  const poll = async (pred) => {
    for (let i = 0; i < 80; i++) {
      const v = (await call(`${runsUrl}/${rid}?since=0`)).json;
      if (pred(v)) return v;
      await new Promise((r) => setTimeout(r, 100));
    }
    return (await call(`${runsUrl}/${rid}?since=0`)).json;
  };
  check("second run in the same worktree → 409", (await post(runsUrl, { worktree: proj, command: "cohorte-build" })).status === 409);
  let v = await poll((x) => x.pending.length > 0);
  check("a gate ask is parked with the hook's reason", v.pending.length === 1 && v.pending[0].kind === "permission" && v.pending[0].summary === "rm -rf build" && v.pending[0].reason === "gate: confirm" && v.pending[0].via === "hook", JSON.stringify(v.pending));
  check("the feed shows text and the tool call", v.events.some((e) => e.kind === "text" && e.text.includes("/cohorte-build f1")) && v.events.some((e) => e.kind === "tool" && e.name === "Bash"));
  check("respond with a bad behavior → 400", (await post(`${runsUrl}/${rid}/respond`, { requestId: v.pending[0].requestId, behavior: "maybe" })).status === 400);
  check("respond to an unknown request → 404", (await post(`${runsUrl}/${rid}/respond`, { requestId: "nope", behavior: "allow" })).status === 404);
  check("deny → 200", (await post(`${runsUrl}/${rid}/respond`, { requestId: v.pending[0].requestId, behavior: "deny" })).status === 200);
  v = await poll((x) => x.pending.some((p) => p.kind === "question"));
  check("the denial reached the CLI (error tool_result)", v.events.some((e) => e.kind === "tool_result" && e.error && /denied/.test(e.text)));
  check("a question is parked with its options", v.pending[0] && v.pending[0].kind === "question" && v.pending[0].questions[0].options.map((o) => o.label).join() === "pg,sqlite");
  check("answer → 200", (await post(`${runsUrl}/${rid}/respond`, { requestId: v.pending[0].requestId, behavior: "allow", answers: { "Which db?": ["sqlite"] } })).status === 200);
  v = await poll((x) => x.status !== "running");
  check("the answer reached the CLI keyed by question text", v.result && v.result.ok && v.result.text === 'answers={"Which db?":"sqlite"}', JSON.stringify(v.result));
  check("the run ends done once the stream is quiet (stdin closed)", v.status === "done" && v.result.costUsd === 0.01, v.status);

  const hang = await post(runsUrl, { worktree: proj, command: "cohorte-build", args: "hang" });
  check("a second run can start once the first ended", hang.status === 202);
  const hid = hang.json.run.id;
  check("stop → 200", (await post(`${runsUrl}/${hid}/stop`, {})).status === 200);
  let hv;
  for (let i = 0; i < 60; i++) { hv = (await call(`${runsUrl}/${hid}?since=0`)).json; if (hv.status !== "running") break; await new Promise((r) => setTimeout(r, 100)); }
  check("a stopped run is marked stopped", hv.status === "stopped", hv.status);
  check("a run of another project is not reachable by id", (await call(`/api/projects/ffffffffff/runs/${rid}`)).status === 404);

  check("remove → 200", (await call(`/api/projects/${id}`, { method: "DELETE" })).status === 200);
  check("project is gone", (await call("/api/state")).json.projects.length === 0);
} finally {
  await ui.close();
  for (const t of tmps) rmSync(t, { recursive: true, force: true });
}

if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log("\nui: all checks passed");
