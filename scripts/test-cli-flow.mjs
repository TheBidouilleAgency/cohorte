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
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

const { home, globalDir, storePath, proj } = standIns("cohorte-cliflow-");
const env = { ...process.env, CLAUDE_CONFIG_DIR: globalDir, COHORTE_NO_VERSION_CHECK: "1" };
const cliPath = join(root, "bin", "cli.js");
/** One verb, to its end. stdin is a pipe (not a TTY): nothing is asked unless --interactive. */
const cli = (args, input = "") => {
  const r = spawnSync(process.execPath, [cliPath, ...args, "--project", proj], { env, input, encoding: "utf8", timeout: 60000 });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { /* not --json */ }
  return { code: r.status, out: r.stdout, err: r.stderr, json };
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
    const c = cli(["ticket", "create", "--title", "Export appointments as CSV", "--body-file", need, "--criteria", "a CSV downloads", "--type", "feature", "--json"]);
    check("ticket create → backlog, id from the title", c.code === 0 && c.json?.ticket.id === T && c.json.ticket.status === "backlog" && c.json.ticket.type === "feature", c.err || c.out);
    const seen = (await call(`${P}/tickets`)).json.tickets.find((t) => t.id === T);
    check("the running UI lists it, with the body as the need", seen && /by hand every week/.test(seen.need) && seen.criteria[0] === "a CSV downloads", JSON.stringify(seen));
    const ls = cli(["ticket", "list", "--json"]);
    check("ticket list --json", ls.code === 0 && ls.json.tickets.some((t) => t.id === T), ls.err);
    const sh = cli(["ticket", "show", T]);
    check("ticket show (human)", sh.code === 0 && sh.out.includes("Export appointments as CSV") && sh.out.includes("C1 a CSV downloads"), sh.out + sh.err);
    check("ticket show of an unknown id → exit 1", cli(["ticket", "show", "nope"]).code === 1);
    const page = (await post(`${P}/tickets`, { title: "Upgrade the runtime", need: "EOL" })).json.ticket;
    const mv = cli(["ticket", "move", page.id, "rejected", "--json"]);
    check("a ticket filed on the page is moved from the terminal", mv.code === 0 && mv.json.ticket.status === "rejected", mv.err);
    check("…and the page sees the move", (await call(`${P}/tickets/${page.id}`)).json.ticket.status === "rejected");
    check("a bad status is refused", cli(["ticket", "move", page.id, "nowhere"]).code === 1);
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
    const a = cli(["checkpoint", T, "approve", "--json"]);
    check("exit 3: a question was parked", a.code === 3 && a.json?.rest.waiting === "question", `${a.code} ${a.err.slice(-600)}`);
    check("one line per stage start and end", /▶ build · sonnet/.test(a.err) && /✓ build · done/.test(a.err) && /✓ review · done/.test(a.err) && /▶ fix/.test(a.err), a.err);
    check("the decider settled the build question (printed)", /decider: Which validation library\? → zod \(Recommended\)/.test(a.err), a.err);
    const f = a.json?.feature;
    check("parked at CP2, the question in the reason, the fix stage stopped", f && f.phase === "cp2" && /admin role/.test(f.checkpoint.reason) && f.stages.at(-1).stage === "fix" && f.stages.at(-1).status === "stopped", JSON.stringify(f && { p: f.phase, c: f.checkpoint, s: f.stages.at(-1) }));
    check("the spec was frozen by the lead", /status: frozen/.test(readFileSync(join(f.worktree, "specs", `${T}.md`), "utf8")));
    const seen = (await call(`${P}/features/${T}`)).json;
    check("the UI (which had it at CP1) now shows CP2", seen.phase === "cp2" && seen.decisions.some((d) => d.by === "decider"), seen.phase);
    check("the UI's inbox shows the CP2", (await call("/api/inbox")).json.items.some((i) => i.kind === "cp2" && i.ref === T));
  }

  console.log("autopilot --interactive: CP2, the question, CP3 — the UI refused meanwhile");
  {
    const child = spawn(process.execPath, [cliPath, "autopilot", T, "--interactive", "--json", "--project", proj], { env, stdio: ["pipe", "pipe", "pipe"] });
    let err = ""; let out = "";
    child.stderr.on("data", (d) => { err += d; });
    child.stdout.on("data", (d) => { out += d; });
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
    let res = null; try { res = JSON.parse(out); } catch { /* checked below */ }
    check("stdin closed at CP3 → exit 2, resting at cp3", code === 2 && res?.rest.waiting === "cp3", `${code} ${out.slice(0, 200)}`);
    check("the human answer is a decision on the record", res?.feature.decisions.some((d) => d.by === "human" && d.chosen === "Yes (Recommended)"));
    check("review then verify ran after the fix", /✓ review · done[\s\S]*✓ verify · done/.test(err.slice(err.indexOf("admin role"))), err.slice(-800));
    const ui3 = (await call(`${P}/features/${T}`)).json;
    check("the UI shows CP3, nothing in flight", ui3.phase === "cp3" && !ui3.driver, JSON.stringify({ p: ui3.phase, d: ui3.driver }));
    check("the ticket waits in To validate · dev", (await call(`${P}/tickets/${T}`)).json.ticket.status === "checkpoint");
  }

  console.log("CP3 approve → PR → merge → acceptance → accept");
  {
    const s = cli(["checkpoint", T, "approve", "--json"]);
    check("ship → PR open: exit 0", s.code === 0 && s.json?.rest.waiting === "pr" && s.json.feature.pr?.number === 7, `${s.code} ${s.err.slice(-400)}`);
    check("the UI shows the PR", (await call(`${P}/features/${T}`)).json.phase === "pr" && (await call(`${P}/tickets/${T}`)).json.ticket.pr === "#7");
    const m = cli(["merge", T, "--json"]);
    check("merge → journal → acceptance note: exit 0, waiting on the business", m.code === 0 && m.json?.rest.waiting === "acceptance", `${m.code} ${m.err.slice(-400)}`);
    check("the note is on the ticket", m.json?.ticket.status === "acceptance" && /export appointments as a CSV/.test(m.json.ticket.acceptance?.summary || ""), JSON.stringify(m.json?.ticket));
    check("the learn and acceptance stages ran", ["learn", "acceptance"].every((x) => m.json?.feature.stages.some((st) => st.stage === x && st.status === "done")));
    check("the UI's inbox shows CP4", (await call("/api/inbox")).json.items.some((i) => i.kind === "cp4" && i.ref === T));
    check("accept takes ok or not-quite", cli(["accept", T, "maybe"]).code === 1);
    const a = cli(["accept", T, "ok", "--note", "works", "--json"]);
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
