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
const { create } = require(join(root, "ui/dist-server/server/server.js"));

const WIN = process.platform === "win32";
let failures = 0;
const check = (name, cond, detail = "") => {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
};

const tmps = [];
const scratch = () => { const d = realpathSync.native(mkdtempSync(join(tmpdir(), "cohorte-ui-"))); tmps.push(d); return d; };
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
  commands: { dev: `node -e "console.log('hello-dev http://localhost:5173/');setInterval(()=>{},1000)"`, dev_ready: `node -e "process.exit(0)"` },
  isolation: { compose_file: "docker-compose.yml" } }));
write(join(proj, "docker-compose.yml"), "services:\n  postgres: {image: postgres}\n  api: {image: api}\n");
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
const resumed = process.argv.indexOf("--resume") >= 0 ? process.argv[process.argv.indexOf("--resume") + 1] : null;
rl.on("line", (line) => {
  const v = JSON.parse(line);
  if (v.type === "user" && resumed) {
    out({ type: "system", subtype: "init", session_id: resumed });
    out({ type: "result", subtype: "success", is_error: false, result: "resumed:" + resumed + ":" + v.message.content[0].text, total_cost_usd: 0.02, duration_ms: 3 });
    return;
  }
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

// A stand-in for the docker CLI: a state file says whether the daemon is up and which services run.
const fakeDocker = join(home, "fake-docker.js");
const dockerState = join(home, "docker-state.json");
writeFileSync(dockerState, JSON.stringify({ up: false, running: [] }));
writeFileSync(fakeDocker, `#!/usr/bin/env node
const fs = require("fs");
const st = ${JSON.stringify(dockerState)};
const read = () => JSON.parse(fs.readFileSync(st, "utf8"));
const a = process.argv.slice(2);
const s = read();
if (a[0] === "info") { if (!s.up) { console.error("Cannot connect to the Docker daemon at unix:///x.sock\\nIs the docker daemon running?"); process.exit(1); } console.log("29.0.0"); process.exit(0); }
const rest = a.slice(a.indexOf("-f") + 2);
if (rest[0] === "config") { console.log("postgres\\napi"); process.exit(0); }
if (!s.up) { console.error("Cannot connect to the Docker daemon"); process.exit(1); }
else if (rest[0] === "ps") for (const n of s.running) console.log(JSON.stringify({ Service: n, State: "running", Health: n === "postgres" ? "healthy" : "", Status: "Up 2 minutes", Image: n, Publishers: [{ PublishedPort: n === "api" ? 3333 : 0, TargetPort: 3333 }] }));
else if (rest[0] === "up") { s.running = rest[2] ? [rest[2]] : ["postgres", "api"]; fs.writeFileSync(st, JSON.stringify(s)); console.log("started " + s.running.join(",")); }
else if (rest[0] === "stop") { const x = rest[1]; s.running = x ? s.running.filter((n) => n !== x) : []; fs.writeFileSync(st, JSON.stringify(s)); console.log("stopped"); }
else if (rest[0] === "restart") console.log("restarted " + (rest[1] || "all"));
else if (rest[0] === "down") { s.running = []; fs.writeFileSync(st, JSON.stringify(s)); console.log("down " + JSON.stringify(rest)); }
else if (rest[0] === "logs") { console.log("log line from " + (rest[rest.length - 1])); setInterval(() => {}, 1000); }
`);
chmodSync(fakeDocker, 0o755);
process.env.COHORTE_DOCKER_BIN = fakeDocker;
const setDocker = (o) => writeFileSync(dockerState, JSON.stringify(o));
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
  {
    const idx = await call("/", { token: null });
    const assets = [...idx.text.matchAll(/(?:src|href)="\.?\/?(assets\/[^"]+)"/g)].map((m) => m[1]);
    check("the page references built assets (a missing build fails here, not in production)", assets.length >= 2, idx.text.slice(0, 300));
    const codes = await Promise.all(assets.map((a) => call(`/${a}`, { token: null }).then((r) => r.status)));
    check("every referenced asset is served", codes.every((c) => c === 200), JSON.stringify(codes));
    check("the page has no inline script or style (CSP)", !/<script(?![^>]*\bsrc=)[^>]*>/.test(idx.text) && !/<style/.test(idx.text) && !/ style="/.test(idx.text));
  }
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


  const dk = `/api/projects/${id}/docker`;
  if (!WIN) { // the fake docker / claude below are shebang scripts
  // --- docker: the project's compose stack ---
  check("detail flags the compose file", (await call(`/api/projects/${id}`)).json.docker.file === "docker-compose.yml");
  let ds = (await call(dk)).json;
  check("daemon down is reported, services still listed", ds.configured && ds.daemon.up === false && /Cannot connect/.test(ds.daemon.error) && ds.services.map((x) => x.name).join() === "postgres,api" && ds.services[0].state === "unknown", JSON.stringify(ds));
  const downUp = await post(dk, { action: "up" });
  check("up while the daemon is down → 409 dockerDown, nothing started", downUp.status === 409 && downUp.json.dockerDown === true, JSON.stringify(downUp.json));
  write(join(proj, "scripts", "new-feature.sh"), "#!/usr/bin/env bash\nif false; then\n  docker compose -f \"$repo_root/docker-compose.yml\" exec -T postgres psql -c 'select 1'\nfi\necho provisioned \"$1\"\n");
  const pre1 = await post(`/api/projects/${id}/worktrees`, { feature: "feat-y" });
  check("new worktree with Docker down → 409 with a diagnosis, script not run", pre1.status === 409 && pre1.json.dockerPreflight && pre1.json.dockerPreflight.daemonUp === false && /new-feature\.sh/.test(pre1.json.error) && pre1.json.dockerPreflight.missing.join() === "postgres", JSON.stringify(pre1.json));
  setDocker({ up: true, running: [] });
  ds = (await call(dk)).json;
  check("daemon up: services are 'not created'", ds.daemon.up && ds.services.every((x) => x.state === "not created") && ds.running === 0, JSON.stringify(ds));
  const pre2 = await post(`/api/projects/${id}/worktrees`, { feature: "feat-y" });
  check("Docker up but postgres not running → 409 naming the service", pre2.status === 409 && pre2.json.dockerPreflight.daemonUp === true && pre2.json.dockerPreflight.missing.join() === "postgres", JSON.stringify(pre2.json));
  check("bad action → 400", (await post(dk, { action: "rm" })).status === 400);
  check("a service the compose file lacks → 404", (await post(dk, { action: "stop", service: "evil; rm -rf /" })).status === 404);
  check("down takes no service → 400", (await post(dk, { action: "down", service: "api" })).status === 400);
  const up = await post(dk, { action: "up" });
  check("up → 202 and the job shows the fixed command", up.status === 202 && up.json.job.command === "docker compose -f docker-compose.yml up -d", JSON.stringify(up.json));
  await waitJob(up.json.job.id, ["done", "failed"]);
  await new Promise((r) => setTimeout(r, 300));
  ds = (await call(dk)).json;
  check("ps shows state, health and published ports", ds.services.some((x) => x.name === "postgres" && x.state === "running" && x.health === "healthy") && ds.services.some((x) => x.name === "api" && x.ports.join() === "3333→3333"), JSON.stringify(ds.services));
  const pre3 = await post(`/api/projects/${id}/worktrees`, { feature: "feat-y" });
  check("with postgres up the pre-check passes and the script runs", pre3.status === 202 && (await waitJob(pre3.json.job.id, ["done", "failed"])).lines.join().includes("provisioned feat-y"), JSON.stringify(pre3.json));
  const skip = await (async () => { setDocker({ up: false, running: [] }); const r = await post(`/api/projects/${id}/worktrees`, { feature: "feat-z", skipDockerCheck: true }); return r; })();
  check("skipDockerCheck lets the user run the script anyway", skip.status === 202);
  await waitJob(skip.json.job.id, ["done", "failed"]);
  setDocker({ up: true, running: ["postgres", "api"] });
  const lg = await post(dk, { action: "logs", service: "api" });
  check("logs follow a service as a job", lg.status === 202 && await (async () => { for (let i = 0; i < 40; i++) { const j = (await call(`/api/projects/${id}/jobs/${lg.json.job.id}/logs?since=0`)).json; if (j.lines.some((x) => x.includes("log line from api"))) return true; await new Promise((r) => setTimeout(r, 100)); } return false; })(), JSON.stringify(lg.json));
  check("following the same logs twice → 409", (await post(dk, { action: "logs", service: "api" })).status === 409);
  await post(`/api/projects/${id}/jobs/${lg.json.job.id}/stop`, {});
  await waitJob(lg.json.job.id, ["stopped"]);
  const stp = await post(dk, { action: "stop", service: "api" });
  await waitJob(stp.json.job.id, ["done", "failed"]);
  check("stop one service", (await call(dk)).json.running === 1);
  const dn = await post(dk, { action: "down" });
  const dnj = await waitJob(dn.json.job.id, ["done", "failed"]);
  check("down never passes -v (volumes stay)", dnj.status === "done" && !/-v|volumes/.test(dnj.command + dnj.lines.join()), JSON.stringify(dnj));
  check("stack is down", (await call(dk)).json.running === 0);
  rmSync(join(proj, "scripts"), { recursive: true, force: true });
  for (const w of (await call(`/api/projects/${id}`)).json.worktrees.slice(1)) git(proj, "worktree", "remove", "--force", w.path);

  }


  // --- v2: pipeline per spec, review findings, git, live stream, activity ---
  const d3 = (await call(`/api/projects/${id}`)).json;
  const f1 = d3.specs.find((x) => x.id === "f1");
  check("a draft spec's next step is /cohorte-spec", f1.pipeline.next.command === "cohorte-spec" && f1.pipeline.stages[0].state === "current" && f1.pipeline.stages.length === 5, JSON.stringify(f1.pipeline));
  write(join(proj, "specs", "reports", "f1.build.json"), JSON.stringify({ id: "f1", phase: "build", surfaces: { backend: "ok" }, dead: [] }));
  write(join(proj, "specs", "reports", "f1.verdict.json"), JSON.stringify({ id: "f1", phase: "review", verdict: "REVISE", findings: 2, blocking: 1, security: 0, deferred: 1, unreviewed: [] }));
  write(join(proj, "specs", "reports", "f1.md"), "# REVIEW REPORT\nVerdict: REVISE\n\n## Findings\n\n- **[LOW]** `a.ts:3` · quality · naming\n- **[CRITICAL]** `b.ts:9` · security · no authz → **Fix:** add the guard\n\n## Deferred\n\n- **[MEDIUM]** `c.ts:1` · quality · dup → **Fix:** extract · out of scope: shared\n");
  write(join(proj, "specs", "f1.md"), "---\nfeature_id: f1\ntitle: First\nstatus: in-review\nbranch: feat/f1\n---\nbody\n");
  const sp2 = (await call(`/api/projects/${id}/specs/f1`)).json;
  check("a REVISE verdict routes to /cohorte-fix and review is blocked", sp2.pipeline.next.command === "cohorte-fix" && sp2.pipeline.stages.find((x) => x.key === "review").state === "blocked" && sp2.pipeline.verdict.blocking === 1, JSON.stringify(sp2.pipeline));
  check("review findings are parsed and sorted by severity", sp2.review.findings.map((x) => x.severity).join() === "CRITICAL,LOW" && sp2.review.findings[0].fix === "add the guard" && sp2.review.deferred[0].outOfScope === "shared" && sp2.review.raw.includes("REVIEW REPORT"), JSON.stringify(sp2.review));
  write(join(proj, "specs", "reports", "f1.verdict.json"), JSON.stringify({ id: "f1", phase: "review", verdict: "SHIP", findings: 0, blocking: 0, unreviewed: [] }));
  check("SHIP then goes to verify", (await call(`/api/projects/${id}/specs/f1`)).json.pipeline.next.command === "cohorte-verify");
  const gi = (await call(`/api/projects/${id}/git`)).json;
  const mainGit = Object.values(gi.worktrees)[0]; // keyed by the path git reports (forward slashes on Windows)
  check("git info: branch, clean/dirty counts, last commit", mainGit && mainGit.branch && typeof mainGit.ahead === "number" && mainGit.lastCommit && mainGit.lastCommit.subject === "init", JSON.stringify(gi));
  write(join(proj, "scratch.txt"), "hello\n");
  const dl = (await call(`/api/projects/${id}/diff?worktree=${encodeURIComponent(proj)}`)).json;
  check("diff lists untracked files", dl.files.some((x) => x.path === "scratch.txt" && x.status === "untracked"), JSON.stringify(dl));
  const df = await call(`/api/projects/${id}/diff?worktree=${encodeURIComponent(proj)}&file=scratch.txt`);
  check("a file diff is served", df.status === 200 && df.json.diff.includes("+hello"), df.text.slice(0, 200));
  check("a path git did not list is refused", (await call(`/api/projects/${id}/diff?worktree=${encodeURIComponent(proj)}&file=${encodeURIComponent("../../etc/passwd")}`)).status === 404);
  check("diff of a non-worktree → 404", (await call(`/api/projects/${id}/diff?worktree=${encodeURIComponent(home)}`)).status === 404);
  rmSync(join(proj, "scratch.txt"), { force: true });
  // live stream: a change notice arrives when a dev server starts
  const got = await new Promise((resolve) => {
    const req = http.request({ host: "127.0.0.1", port: l.port, path: "/api/stream", headers: { Authorization: `Bearer ${l.token}` } }, (res) => {
      let buf = "";
      res.on("data", (c) => { buf += c; const m = /data: (\[.*\])/.exec(buf); if (m) { req.destroy(); resolve(JSON.parse(m[1])); } });
      setTimeout(async () => { const r = await post(`/api/projects/${id}/dev`, { worktree: proj, confirmed: true }); if (r.json && r.json.job) globalThis.__streamJob = r.json.job.id; }, 100);
    });
    req.on("error", () => resolve(null));
    setTimeout(() => { req.destroy(); resolve(null); }, 6000);
    req.end();
  });
  check("the event stream pushes a notice for the started job", Array.isArray(got) && got.some((e) => e.type === "job" && e.projectId === id), JSON.stringify(got));
  check("the stream needs the token", (await call("/api/stream", { token: null })).status === 401);
  const devJob = (await call(`/api/projects/${id}/jobs`)).json.jobs.find((j) => j.kind === "dev" && (j.status === "running" || j.status === "ready" || j.status === "starting"));
  const act = (await call("/api/activity")).json;
  check("activity lists the live dev server across projects", act.items.some((x) => x.kind === "dev" && x.projectId === id && x.projectName === "app"), JSON.stringify(act));
  await new Promise((r) => setTimeout(r, 400));
  const dj2 = (await call(`/api/projects/${id}/jobs/${devJob.id}/logs?since=0`)).json;
  check("a dev server's printed URL is offered as an Open link", dj2.urls.includes("http://localhost:5173/"), JSON.stringify(dj2.urls));
  await post(`/api/projects/${id}/jobs/${devJob.id}/stop`, {});
  await waitJob(devJob.id, ["stopped"]);

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

  if (!WIN) {
  setDocker({ up: true, running: ["postgres", "api"] });
  const dAsk = await post(dk, { action: "restart" });
  check("docker goes through the gate: ask → 409 needsConfirmation", dAsk.status === 409 && dAsk.json.needsConfirmation === true && dAsk.json.command === "docker compose -f docker-compose.yml restart", JSON.stringify(dAsk.json));
  const dOk = await post(dk, { action: "restart", confirmed: true });
  check("docker ask + confirmed → 202", dOk.status === 202);
  await waitJob(dOk.json.job.id, ["done", "failed"]);
  write(gate, "import sys; sys.exit(2)\n");
  check("docker gate deny → 403", (await post(dk, { action: "stop" })).status === 403);
  write(gate, "import sys; sys.exit(1)\n");

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

  check("reply on a finished run resumes its session → 202", (await post(`${runsUrl}/${rid}/reply`, { text: "use sqlite, thanks" })).status === 202);
  v = await poll((x) => x.status !== "running" && x.result && /^resumed:/.test(x.result.text));
  check("the reply reached the SAME session and the run ended again", v.status === "done" && v.result.text === "resumed:s1:use sqlite, thanks", JSON.stringify(v.result));
  check("the feed records what you said", v.events.some((e) => e.kind === "reply" && e.text === "use sqlite, thanks"));
  check("empty reply → 409", (await post(`${runsUrl}/${rid}/reply`, { text: "  " })).status === 409);

  const hang = await post(runsUrl, { worktree: proj, command: "cohorte-build", args: "hang" });
  check("a second run can start once the first ended", hang.status === 202);
  const hid = hang.json.run.id;
  check("reply while the command runs → 409", (await post(`${runsUrl}/${hid}/reply`, { text: "hi" })).status === 409);
  check("stop → 200", (await post(`${runsUrl}/${hid}/stop`, {})).status === 200);
  let hv;
  for (let i = 0; i < 60; i++) { hv = (await call(`${runsUrl}/${hid}?since=0`)).json; if (hv.status !== "running") break; await new Promise((r) => setTimeout(r, 100)); }
  check("a stopped run is marked stopped", hv.status === "stopped", hv.status);
  check("a run of another project is not reachable by id", (await call(`/api/projects/ffffffffff/runs/${rid}`)).status === 404);

  // run history survives a restart, and a stored run can still be replied to
  {
    const ui2 = create({ globalDir, version: "0.0.0-test", storePath });
    const l2 = await ui2.listen(0);
    const stored = ui2.runs.get(rid);
    check("a finished run is reloaded from disk after a restart", stored && stored.status === "done" && stored.sessionId === "s1" && stored.events.length > 3 && stored.result.ok, JSON.stringify(stored && { s: stored.status, sid: stored.sessionId }));
    const hv2 = ui2.runs.get(hid);
    check("a run that was still running when the process died comes back stopped", hv2 && hv2.status === "stopped", hv2 && hv2.status);
    await ui2.close();
  }
  }

  check("remove → 200", (await call(`/api/projects/${id}`, { method: "DELETE" })).status === 200);
  check("project is gone", (await call("/api/state")).json.projects.length === 0);
} finally {
  await ui.close();
  for (const t of tmps) rmSync(t, { recursive: true, force: true });
}

if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log("\nui: all checks passed");
