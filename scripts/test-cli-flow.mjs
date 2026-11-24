#!/usr/bin/env node
// End-to-end test of the company flow from a terminal — the CLI verbs (bin/flow.js) against the stand-ins for
// `claude` and `gh`, WITH a cohorte ui instance running on the same state the whole time:
//
//   ticket create → take (worktree + lead → CP1) → checkpoint approve (freeze → build + decider → review → fix asks
//   a security question: no terminal ⇒ parked at CP2, exit 3) → autopilot --interactive (CP2 continue, the question
//   answered on stdin, the UI refused meanwhile: 409) → CP3 (stdin closed ⇒ exit 2) → checkpoint approve (ship → PR)
//   → merge → journal → acceptance note → accept ok
//
// After each verb the running UI is asked what it sees: a change made in the terminal is on the page.
//
//   node scripts/test-cli-flow.mjs        (needs ui/dist-server: npm run build:ui)

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import http from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { standIns } from "./ci/flow-standins.mjs";

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL("..", import.meta.url));
const registry = require(join(root, "lib/registry.js"));
const { create } = require(join(root, "ui/dist-server/server/server.js"));

if (process.platform === "win32") { console.log("cli flow: skipped on Windows (shebang stand-ins)"); process.exit(0); }

let failures = 0;
const check = (name, cond, detail = "") => {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (what, fn, ms = 20000) => {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) { last = await fn(); if (last) return last; await sleep(80); }
  check(`(timeout) ${what}`, false, JSON.stringify(last));
  return null;
};

const { home, globalDir, storePath, proj, ghState } = standIns("cohorte-cliflow-");
const env = { ...process.env, CLAUDE_CONFIG_DIR: globalDir, COHORTE_NO_VERSION_CHECK: "1" };
const cliPath = join(root, "bin", "cli.js");
/** One verb, to its end. stdin is a pipe (not a TTY) — what an agent's Bash call is: nothing is asked. */
const cli = (args, input = "", extra = {}) => {
  const r = spawnSync(process.execPath, [cliPath, ...args, "--project", proj], { env: { ...env, ...extra }, input, encoding: "utf8", timeout: 60000 });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { /* not --json */ }
  return { code: r.status, out: r.stdout, err: r.stderr, json };
};
/** The JSON result at the end of a terminal's output (stdout and stderr are one stream there). */
const lastJson = (t) => { const i = t.lastIndexOf('{\n  "'); try { return JSON.parse(i >= 0 ? t.slice(i) : t); } catch { return null; } };
// A person at a terminal: the verb runs on a pseudo-terminal (scripts/ci/pty-run.py), `input` typed into it.
const PTY = join(root, "scripts", "ci", "pty-run.py");
const termArgs = (args, e = env) => ["python3", [PTY, process.execPath, cliPath, ...args], { env: e }];
const term = (args, input = "", e = env) => {
  const r = spawnSync("python3", [PTY, process.execPath, cliPath, ...args, ...(args.includes("--project") ? [] : ["--project", proj])], { env: e, input, encoding: "utf8", timeout: 90000 });
  const out = (r.stdout || "").replace(/\r/g, "");
  return { code: r.status, out, err: out, json: lastJson(out) };
};

const ui = create({ globalDir, version: "0.0.0-test", storePath });
const l = await ui.listen(0);
const call = (path, { method = "GET", body } = {}) => new Promise((resolve, reject) => {
  const data = body === undefined ? null : JSON.stringify(body);
  const req = http.request({ host: "127.0.0.1", port: l.port, path, method, agent: false, headers: { Authorization: `Bearer ${l.token}`, ...(data ? { "Content-Type": "application/json" } : {}) } }, (res) => {
    let t = ""; res.on("data", (d) => { t += d; });
    res.on("end", () => { let json = null; try { json = JSON.parse(t); } catch { /* not json */ } resolve({ status: res.statusCode, json }); });
  });
  req.on("error", reject);
  if (data) req.write(data);
  req.end();
});
const post = (path, body = {}) => call(path, { method: "POST", body });
// the page's live channel: change notices
const notices = [];
const stream = http.get({ host: "127.0.0.1", port: l.port, path: "/api/stream", headers: { Authorization: `Bearer ${l.token}` } }, (res) => {
  res.on("data", (d) => { for (const m of String(d).matchAll(/^data: (.+)$/gm)) notices.push(...JSON.parse(m[1])); });
});

try {
  const id = registry.add(globalDir, proj).project.id;
  const P = `/api/projects/${id}`;
  const T = "export-appointments-as-csv";

  console.log("ticket");
  {
    const need = join(home, "need.md");
    writeFileSync(need, "The office exports appointments by hand every week.\n");
    const refused = cli(["ticket", "create", "--title", "Export appointments as CSV", "--type", "feature", "--json"]);
    check("straight to the backlog (no CP0) is a person's decision: refused from a pipe, exit 5, with the command to type", refused.code === 5 && /type it yourself in a terminal/.test(refused.err), `${refused.code} ${refused.err}`);
    const c = term(["ticket", "create", "--title", "Export appointments as CSV", "--body-file", need, "--criteria", "a CSV downloads", "--type", "feature", "--json"], "yes\n");
    check("ticket create at a terminal (yes) → backlog, id from the title", c.code === 0 && c.json?.ticket.id === T && c.json.ticket.status === "backlog" && c.json.ticket.type === "feature", c.err || c.out);
    const seen = (await call(`${P}/tickets`)).json.tickets.find((t) => t.id === T);
    check("the running UI lists it, with the body as the need", seen && /by hand every week/.test(seen.need) && seen.criteria[0] === "a CSV downloads", JSON.stringify(seen));
    const ls = cli(["ticket", "list", "--json"]);
    check("ticket list --json", ls.code === 0 && ls.json.tickets.some((t) => t.id === T), ls.err);
    const sh = cli(["ticket", "show", T]);
    check("ticket show (human)", sh.code === 0 && sh.out.includes("Export appointments as CSV") && sh.out.includes("C1 a CSV downloads"), sh.out + sh.err);
    check("ticket show of an unknown id → exit 1", cli(["ticket", "show", "nope"]).code === 1);
    const page = (await post(`${P}/tickets`, { title: "Upgrade the runtime", need: "EOL" })).json.ticket;
    check("ticket move from a pipe → refused (exit 5)", cli(["ticket", "move", page.id, "rejected"]).code === 5);
    check("…a `no` at the terminal does nothing", term(["ticket", "move", page.id, "rejected"], "no\n").code === 5 && (await call(`${P}/tickets/${page.id}`)).json.ticket.status === "backlog");
    const mv = term(["ticket", "move", page.id, "rejected", "--json"], "yes\n");
    check("a ticket filed on the page is moved from the terminal", mv.code === 0 && mv.json.ticket.status === "rejected", mv.err);
    check("…and the page sees the move", (await call(`${P}/tickets/${page.id}`)).json.ticket.status === "rejected");
    check("a bad status is refused", cli(["ticket", "move", page.id, "nowhere"]).code === 1);
    const asAgent = { COHORTE_RUN_ID: "deadbeef", COHORTE_RUN_PROJECT: id };
    check("an agent of a cohorte run may read (ticket list)", cli(["ticket", "list", "--json"], "", asAgent).code === 0);
    const ag = cli(["ticket", "create", "--title", "Sneaky", "--status", "validate"], "", asAgent);
    check("…but never move the flow (exit 5)", ag.code === 5 && /agent of a cohorte run/.test(ag.err), ag.err);
  }

  console.log("take → lead → CP1");
  {
    check("the UI has no feature yet", (await call(`${P}/features/${T}`)).status === 404);
    await sleep(1700); // one watch period: the page has seen the project as it was
    const before = notices.length;
    const t = cli(["take", T, "--json"]);
    const f = t.json?.feature;
    check("take → exit 2: CP1 waits for the developer", t.code === 2 && t.json.rest.waiting === "cp1", `${t.code} ${t.err}`);
    check("the worktree is a sibling on feature/<id>, the feature id is the ticket id", f && f.id === T && f.worktree === join(home, `app-${T}`) && f.branch === `feature/${T}` && existsSync(f.worktree), JSON.stringify(f && { id: f.id, w: f.worktree }));
    check("the lead's plan is on the record, and its words were printed", f && f.plan && f.plan.summary.includes("export endpoint") && /lead: Here is the plan/.test(t.err), t.err.slice(0, 400));
    check("nothing in flight: the lease is released", f && !f.driver);
    const seen = (await call(`${P}/features/${T}`)).json;
    check("the running UI shows the feature at CP1", seen && seen.phase === "cp1" && seen.checkpoint.kind === "cp1", JSON.stringify(seen && seen.phase));
    check("the UI can reach the lead run the CLI started", (await call(`${P}/runs/${f.leadRunId}`)).json?.meta?.role === "lead");
    check("the ticket moved to framing", (await call(`${P}/tickets/${T}`)).json.ticket.status === "framing");
    await until("the page got a change notice", async () => notices.slice(before).some((n) => n.type === "flow" && n.projectId === id));
    check("taking it twice → error", cli(["take", T]).code === 1);
  }

  console.log("checkpoint approve → autopilot until a question nobody can answer here");
  {
    check("CP1 approve from a pipe needs the developer's own words (--note)", cli(["checkpoint", T, "approve"]).code === 1);
    check("…and an agent of a run may not relay it", cli(["checkpoint", T, "approve", "--note", "ok"], "", { COHORTE_RUN_ID: "x" }).code === 5);
    const a = cli(["checkpoint", T, "approve", "--note", "Looks right, go", "--json"]);
    check("exit 3: a question was parked", a.code === 3 && a.json?.rest.waiting === "question", `${a.code} ${a.err.slice(-600)}`);
    check("one line per stage start and end", /▶ build · sonnet/.test(a.err) && /✓ build · done/.test(a.err) && /✓ review · done/.test(a.err) && /▶ fix/.test(a.err), a.err);
    check("the decider settled the build question (printed)", /decider: Which validation library\? → zod \(Recommended\)/.test(a.err), a.err);
    const f = a.json?.feature;
    check("parked at CP2, the question in the reason, the fix stage stopped", f && f.phase === "cp2" && /admin role/.test(f.checkpoint.reason) && f.stages.at(-1).stage === "fix" && f.stages.at(-1).status === "stopped", JSON.stringify(f && { p: f.phase, c: f.checkpoint, s: f.stages.at(-1) }));
    check("the spec was frozen by the lead", /status: frozen/.test(readFileSync(join(f.worktree, "specs", `${T}.md`), "utf8")));
    check("the relayed approval is on the record, as relayed, in the developer's words", f?.decisions.some((d) => d.by === "remote" && d.header === "checkpoint" && d.chosen === "approve" && /Looks right, go/.test(d.rationale)), JSON.stringify(f?.decisions));
    const seen = (await call(`${P}/features/${T}`)).json;
    check("the UI (which had it at CP1) now shows CP2", seen.phase === "cp2" && seen.decisions.some((d) => d.by === "decider"), seen.phase);
    check("the UI's inbox shows the CP2", (await call("/api/inbox")).json.items.some((i) => i.kind === "cp2" && i.ref === T));
  }

  console.log("autopilot at a terminal: CP2, the question, CP3 — the UI refused meanwhile");
  {
    const [cmd, cargs, copts] = termArgs(["autopilot", T, "--json", "--project", proj]);
    const child = spawn(cmd, cargs, { ...copts, stdio: ["pipe", "pipe", "pipe"] });
    let err = ""; let out = "";
    child.stdout.on("data", (d) => { const t = String(d).replace(/\r/g, ""); err += t; out += t; });
    const exited = new Promise((r) => child.on("close", r));
    await until("the CP2 prompt", async () => /CP2 · .*\n[\s\S]*continue \| correct \| reframe \| abandon/.test(err));
    child.stdin.write("continue\n");
    await until("the security question, asked here", async () => /\? \[fix\] security · Should the export require the admin role\?/.test(err));
    check("its options and the decider's reading are shown", /1\) Yes \(Recommended\)/.test(err) && /handed to you/.test(err), err.slice(-500));
    const seen = (await call(`${P}/features/${T}`)).json;
    check("while the fix runs, the UI sees the feature leased to the terminal", seen.phase === "autopilot" && seen.driver && seen.driver.by === "cli", JSON.stringify(seen.driver));
    const ab = await post(`${P}/features/${T}/checkpoint`, { action: "abandon" });
    check("…and refuses to move it (409)", ab.status === 409 && /terminal/.test(ab.json.error), JSON.stringify(ab));
    check("…the lead too", (await post(`${P}/features/${T}/lead`, { text: "hi" })).status === 409);
    child.stdin.write("1\n");
    await until("the CP3 prompt", async () => /CP3 · review and verification are clean/.test(err));
    check("CP3 lists what was decided on the developer's behalf", /decided on your behalf[\s\S]*Which validation library\? → zod/.test(err), err.slice(-600));
    child.stdin.end(); // no answer: the verb stops there
    const code = await exited;
    const res = lastJson(out);
    check("stdin closed at CP3 → exit 2, resting at cp3", code === 2 && res?.rest.waiting === "cp3", `${code} ${out.slice(0, 200)}`);
    check("the human answer is a decision on the record", res?.feature.decisions.some((d) => d.by === "human" && d.chosen === "Yes (Recommended)"));
    check("review then verify ran after the fix", /✓ review · done[\s\S]*✓ verify · done/.test(err.slice(err.indexOf("admin role"))), err.slice(-800));
    const ui3 = (await call(`${P}/features/${T}`)).json;
    check("the UI shows CP3, nothing in flight", ui3.phase === "cp3" && !ui3.driver, JSON.stringify({ p: ui3.phase, d: ui3.driver }));
    check("the ticket waits in To validate · dev", (await call(`${P}/tickets/${T}`)).json.ticket.status === "checkpoint");
  }

  console.log("CP3 approve → PR → merge → acceptance → accept");
  {
    const no = cli(["checkpoint", T, "approve", "--json"]);
    check("shipping (CP3 approve) from a pipe → refused, exit 5", no.code === 5 && /person's decision/.test(no.err), `${no.code} ${no.err}`);
    const s = term(["checkpoint", T, "approve", "--json"], "yes\n");
    check("ship → PR open: exit 0", s.code === 0 && s.json?.rest.waiting === "pr" && s.json.feature.pr?.number === 7, `${s.code} ${s.err.slice(-400)}`);
    check("the UI shows the PR", (await call(`${P}/features/${T}`)).json.phase === "pr" && (await call(`${P}/tickets/${T}`)).json.ticket.pr === "#7");
    check("merge from a pipe → refused", cli(["merge", T]).code === 5);
    const m = term(["merge", T, "--json"], "yes\n");
    check("merge → journal → acceptance note: exit 0, waiting on the business", m.code === 0 && m.json?.rest.waiting === "acceptance", `${m.code} ${m.err.slice(-400)}`);
    check("the note is on the ticket", m.json?.ticket.status === "acceptance" && /export appointments as a CSV/.test(m.json.ticket.acceptance?.summary || ""), JSON.stringify(m.json?.ticket));
    check("the learn and acceptance stages ran", ["learn", "acceptance"].every((x) => m.json?.feature.stages.some((st) => st.stage === x && st.status === "done")));
    check("the UI's inbox shows CP4", (await call("/api/inbox")).json.items.some((i) => i.kind === "cp4" && i.ref === T));
    check("accept takes ok or not-quite", cli(["accept", T, "maybe"]).code === 1);
    check("CP4 from a pipe (a skill, an agent) → refused", cli(["accept", T, "ok"]).code === 5);
    const a = term(["accept", T, "ok", "--note", "works", "--json"], "yes\n");
    check("accept ok → done", a.code === 0 && a.json?.ticket.status === "done" && a.json.ticket.feedback.some((x) => /accepted · works/.test(x)), a.err);
    const ui4 = (await call(`${P}/features/${T}`)).json;
    check("the UI shows the feature done", ui4.phase === "done", ui4.phase);
  }

  console.log("the other way: the page's state in the terminal");
  {
    const t = (await post(`${P}/tickets`, { title: "Filed on the page", need: "x" })).json.ticket;
    const ls = cli(["ticket", "list", "--status", "backlog", "--json"]);
    check("a ticket filed on the page is listed by the CLI", ls.json?.tickets.some((x) => x.id === t.id));
    check("help lists the flow verbs", /cohorte autopilot <ticket>/.test(spawnSync(process.execPath, [cliPath, "--help"], { env, encoding: "utf8" }).stdout));
    const v = cli(["ticket", "create", "--title", "Remind patients", "--status", "validate", "--need", "No-shows cost an hour a day", "--value", "1 h/day",
      "--criteria", "a reminder goes out the day before", "--out-of-scope", "SMS", "--priority", "high", "--size", "S", "--requester", "Marie", "--json"]);
    check("ticket create --status validate: the PO's way, CP0 still applies", v.code === 0 && v.json?.ticket.status === "validate" && v.json.ticket.value === "1 h/day"
      && v.json.ticket.outOfScope[0] === "SMS" && v.json.ticket.priority === "high" && v.json.ticket.requester === "Marie", v.err || v.out);
    check("…the page's inbox shows the CP0", (await call("/api/inbox")).json.items.some((i) => i.kind === "cp0" && i.ref === v.json?.ticket.id));
    check("…and the requester validates it on the page", (await post(`${P}/tickets/${v.json?.ticket.id}/decide`, { action: "validate" })).json.ticket.status === "backlog");
  }

  console.log("--detach: a background drive, its question answered from the page");
  {
    const S = "second-export";
    term(["ticket", "create", "--title", "Second export", "--type", "feature"], "yes\n");
    const tk = cli(["take", S, "--json"]);
    check("take → CP1", tk.code === 2);
    // verify will ask a permission: a detached drive cannot grant one, and nothing from elsewhere may
    writeFileSync(join(tk.json.feature.worktree, "specs", "reports", ".ask-permission"), "");
    const t0 = Date.now();
    const d = cli(["checkpoint", S, "approve", "--detach", "--note", "approved, go", "--json"]);
    check("checkpoint approve --detach returns at once, with its pid and log", d.code === 0 && d.json?.detached?.pid && existsSync(d.json.detached.log) && Date.now() - t0 < 15000, `${d.code} ${d.out} ${d.err}`);
    const log = d.json?.detached?.log;
    const item = await until("the handed-over question is in the page's inbox", async () => (await call("/api/inbox")).json.items.find((i) => i.kind === "question" && i.feature === S), 30000);
    const run = item && (await call(`${P}/runs/${item.ref}`)).json;
    const q = run?.pending?.[0];
    check("the page sees the parked question of a run another process drives", q && q.kind === "question" && /admin role/.test(q.questions[0].question) && !q.deciding, JSON.stringify(run?.pending));
    const st = cli(["autopilot", S, "--status", "--json"]);
    check("autopilot --status: the question it waits for, the drive running", st.code === 0 && st.json?.waiting.length === 1 && st.json.drive?.running === true, st.out.slice(0, 300));
    const r = q && await post(`${P}/runs/${item.ref}/respond`, { requestId: q.requestId, behavior: "allow", answers: { [q.questions[0].question]: ["Yes (Recommended)"] } });
    check("the page answers it", r && r.status === 200, JSON.stringify(r?.json));
    const f2 = await until("verify's permission ask parks the detached drive at CP2", async () => { const f = (await call(`${P}/features/${S}`)).json; return f.phase === "cp2" && !f.driver ? f : null; }, 30000);
    check("…the ask in the reason, never granted from elsewhere", f2 && /permission/.test(f2.checkpoint.reason) && /docker compose up -d/.test(f2.checkpoint.reason) && f2.stages.at(-1).stage === "verify" && f2.stages.at(-1).status === "stopped", JSON.stringify(f2 && { c: f2.checkpoint, s: f2.stages.at(-1) }));
    check("the page's answer is on the record as remote — not as the developer's own", f2 && f2.decisions.some((x) => x.by === "remote" && x.chosen === "Yes (Recommended)") && !f2.decisions.some((x) => x.by === "human" && x.chosen === "Yes (Recommended)"), JSON.stringify(f2?.decisions));
    const text = log ? readFileSync(log, "utf8") : "";
    check("its log has the stages, the wait and the stop", /▶ build/.test(text) && /\? waiting for an answer \(fix\)/.test(text) && /! verify asks to run Bash/.test(text), text.slice(-800));
    rmSync(join(f2.worktree, "specs", "reports", ".ask-permission"));
    const c2 = cli(["checkpoint", S, "continue", "--note", "the docker ask is fine now", "--json"]);
    check("CP2 continue, relayed with a note → verify reruns → CP3", c2.code === 2 && c2.json?.rest.waiting === "cp3", `${c2.code} ${c2.err.slice(-400)}`);
    const cp3 = term(["autopilot", S], "");
    check("CP3, at a terminal, lists the remote answer among what was decided on the developer's behalf", cp3.code === 2 && /decided on your behalf[\s\S]*admin role\? → Yes \(Recommended\) \(answered from elsewhere\)/.test(cp3.out), cp3.out.slice(-600));
    writeFileSync(ghState, JSON.stringify({ state: "OPEN" })); // the first feature's merge left the fake PR merged
    check("CP3 approve --detach from a pipe → refused", cli(["checkpoint", S, "approve", "--detach"]).code === 5);
    const sh = term(["checkpoint", S, "approve", "--detach", "--json"], "yes\n");
    check("CP3 approve --detach at a terminal: the yes travels to the background drive", sh.code === 0, `${sh.code} ${sh.out.slice(-400)}`);
    const fo = cli(["autopilot", S, "--follow", "--json"]);
    check("autopilot --follow prints the drive until it ends, then where it rests", fo.code === 0 && fo.json?.rest.waiting === "pr" && /▶ ship/.test(fo.out + fo.err), `${fo.code} ${JSON.stringify(fo.json?.rest)} ${fo.err.slice(-600)}`);
  }

  console.log("adopt: work from a plain Claude Code session joins the flow");
  {
    const wt = join(home, "app-plain-spec");
    spawnSync("git", ["-C", proj, "worktree", "add", "-q", "-b", "feature/plain-spec", wt]);
    writeFileSync(join(wt, "specs", "plain-spec.md"), "---\nfeature_id: plain-spec\ntitle: Plain spec\nstatus: frozen\n---\n## 9. DoD\n- [ ] C1 works\n");
    writeFileSync(join(proj, "specs", "draft-one.md"), "---\nfeature_id: draft-one\ntitle: Draft one\nstatus: draft\n---\n");
    const ls = cli(["ticket", "list", "--json"]);
    const a = ls.json?.adoptable || [];
    check("ticket list shows the specs no feature follows (the worktree's)", a.some((x) => x.id === "plain-spec" && x.worktree === wt && x.status === "frozen") && a.some((x) => x.id === "draft-one"), JSON.stringify(a));
    check("…and so does the page", ((await call(`${P}/tickets`)).json.adoptable || []).some((x) => x.id === "plain-spec"));
    check("a draft is not adopted", cli(["adopt", "draft-one"]).code === 1);
    const ad = cli(["adopt", "plain-spec", "--json"]);
    check("adopt a frozen spec → CP2, continue builds it", ad.code === 2 && ad.json?.feature.phase === "cp2" && /continue runs build next/.test(ad.json.feature.checkpoint.reason) && ad.json.feature.worktree === wt, `${ad.code} ${ad.err} ${JSON.stringify(ad.json?.feature?.checkpoint)}`);
    check("…its ticket is created with the same id", ad.json?.ticket?.id === "plain-spec" && ad.json.ticket.status === "building", JSON.stringify(ad.json?.ticket));
    check("…the page shows the feature", (await call(`${P}/features/plain-spec`)).json.phase === "cp2");
    check("adopting it twice → error", cli(["adopt", "plain-spec"]).code === 1);
    // a frozen spec in the main checkout only: refused — the stages would run (and commit) on the default branch
    writeFileSync(join(proj, "specs", "main-only.md"), "---\nfeature_id: main-only\ntitle: Main only\nstatus: frozen\n---\n");
    const mo = cli(["adopt", "main-only"]);
    check("a spec only in the main checkout is not adopted (never on the default branch)", mo.code === 1 && /main checkout/.test(mo.err), mo.err);
    // reviewed and verified in a plain session, in its worktree: the page adopts it, straight to CP3
    const pw = join(home, "app-page-spec");
    spawnSync("git", ["-C", proj, "worktree", "add", "-q", "-b", "feature/page-spec", pw]);
    const R = (n, v) => writeFileSync(join(pw, "specs", "reports", n), JSON.stringify(v));
    mkdirSync(join(pw, "specs", "reports"), { recursive: true });
    writeFileSync(join(pw, "specs", "page-spec.md"), "---\nfeature_id: page-spec\ntitle: Page spec\nstatus: frozen\n---\n## 9. DoD\n- [x] C1 works\n");
    R("page-spec.readiness.json", { verdict: "READY" }); R("page-spec.build.json", { id: "page-spec", surfaces: { api: "ok" }, dead: [] });
    R("page-spec.verdict.json", { verdict: "SHIP", blocking: 0, severity: { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 }, unreviewed: [] }); R("page-spec.verify.json", { verdict: "PASS" });
    const pa = await post(`${P}/adopt`, { id: "page-spec" });
    check("the page's Adopt on a reviewed + verified spec → CP3", pa.status === 200 && pa.json.feature.phase === "cp3" && pa.json.feature.worktree === pw, JSON.stringify(pa.json));
    check("…and the CLI sees it", cli(["ticket", "show", "page-spec", "--json"]).json?.feature?.phase === "cp3");
  }

  console.log("/cohorte-lead in a plain session: take --no-lead, the session freezes, checkpoint approve");
  {
    const L = "session-led";
    term(["ticket", "create", "--title", "Session led", "--type", "feature"], "yes\n");
    const t = cli(["take", L, "--no-lead", "--json"]);
    const wt = t.json?.feature?.worktree;
    check("take --no-lead: the worktree and the record, no lead run, exit 0", t.code === 0 && t.json.feature.phase === "framing" && !t.json.feature.leadRunId && wt && existsSync(wt), `${t.code} ${t.err}`);
    writeFileSync(join(wt, "specs", `${L}.md`), `---\nfeature_id: ${L}\ntitle: Session led\nstatus: draft\n---\n`);
    check("approve on a draft is refused", cli(["checkpoint", L, "approve", "--note", "go"]).code === 1);
    writeFileSync(join(wt, "specs", `${L}.md`), `---\nfeature_id: ${L}\ntitle: Session led\nstatus: frozen\n---\n## 9. DoD\n- [x] C1 works\n`);
    const a = cli(["checkpoint", L, "approve", "--note", "the developer said: approved", "--json"]);
    check("approve on the frozen spec starts the autopilot (here: parked at the fix question)", a.code === 3 && /▶ build/.test(a.err) && a.json?.feature.phase === "cp2", `${a.code} ${a.err.slice(-400)}`);
  }

  console.log("take-over: a stuck lease");
  {
    // a lease whose holder is gone: the pid of a live process, but not the one that took it (a reboot reused it)
    const leaseDir = join(globalDir, "cohorte-ui", "leases", id);
    mkdirSync(leaseDir, { recursive: true });
    writeFileSync(join(leaseDir, "plain-spec.lock"), JSON.stringify({ pid: process.pid, start: 1000, by: "cli", at: "2020-01-01T00:00:00Z", token: "x" }));
    check("a lease whose pid now names another process is stale: the page may act", (await post(`${P}/features/plain-spec/checkpoint`, { action: "reframe", text: "x" })).status !== 409);
    const sleeper = spawn("sleep", ["30"], { stdio: "ignore" });
    const startOf = require(join(root, "ui/dist-server/server/proc.js")).startOf;
    await sleep(300);
    writeFileSync(join(leaseDir, "plain-spec.lock"), JSON.stringify({ pid: sleeper.pid, start: startOf(sleeper.pid), by: "cli", at: new Date().toISOString(), token: "y" }));
    const held = await post(`${P}/features/plain-spec/checkpoint`, { action: "continue" });
    check("a live holder (pid AND start time match) keeps it: 409", held.status === 409 && /take-over/.test(held.json.error), JSON.stringify(held));
    check("take-over from a pipe → refused", cli(["take-over", "plain-spec"]).code === 5);
    const to = term(["take-over", "plain-spec", "--json"], "yes\n");
    check("take-over at a terminal clears it", to.code === 0 && to.json?.was?.pid === sleeper.pid && !existsSync(join(leaseDir, "plain-spec.lock")), to.out.slice(-300));
    sleeper.kill();
  }

  console.log("new-project: the Founding chain from a terminal");
  {
    const noGlobal = join(home, "gitconfig-empty"); writeFileSync(noGlobal, "");
    const e2 = { ...env, GIT_CONFIG_GLOBAL: noGlobal, GIT_CONFIG_NOSYSTEM: "1" };
    for (const k of ["GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL", "EMAIL"]) delete e2[k];
    const answers = ["reply Receptionists, for dentists", "approve", "github", "approve", "retry", ""].join("\n");
    const n = term(["new-project", "--idea", "Patients call all day to book", "--name", "dentist", "--parent", home, "--based-on", proj, "--json", "--project", proj], answers, e2);
    const res = n.json;
    const nroot = join(home, "dentist");
    check("idea → vision (a reply) → approve → foundations → identity (github) → approve → skeleton (retry) → set-up → done", n.code === 0 && res?.founding.phase === "done", `${n.code} ${n.out.slice(-1200)}`);
    check("the PO's and the lead's words were printed, the checkpoints asked", /vision: Who books today/.test(n.out) && /■ cp-vision/.test(n.out) && /git identity/.test(n.out) && /■ cp-scaffold/.test(n.out), n.out.slice(-1500));
    check("cohorte committed under the GitHub identity, in that repo only", spawnSync("git", ["-C", nroot, "log", "--format=%an <%ae>"], { env: e2, encoding: "utf8" }).stdout.trim().split("\n").every((x) => x === "Octo Cat <583231+octo@users.noreply.github.com>"));
    const nt = spawnSync(process.execPath, [cliPath, "ticket", "list", "--project", nroot, "--json"], { env: e2, encoding: "utf8" });
    check("the first version's tickets are in its backlog", nt.status === 0 && JSON.parse(nt.stdout).tickets.filter((x) => x.status === "backlog").length === 2, nt.stdout.slice(0, 300) + nt.stderr);
    check("the page lists it as an ordinary project", (await call("/api/state")).json.projects.some((x) => x.root === nroot && !x.founding));
  }
} catch (e) {
  failures++;
  console.error(e);
} finally {
  stream.destroy();
  await ui.close();
  try { rmSync(home, { recursive: true, force: true }); } catch { /* temp */ }
}

if (failures) { console.error(`\ncli flow: ${failures} check(s) failed`); process.exit(1); }
console.log("\ncli flow: all checks passed");
