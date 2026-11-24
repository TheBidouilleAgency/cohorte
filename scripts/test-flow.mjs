#!/usr/bin/env node
// End-to-end test of cohorte ui's company flow, against stand-ins for `claude` and `gh`:
//
//   PO conversation → draft ticket (Obsidian note + card) → CP0 → take → worktree → lead → plan → CP1 → frozen spec
//   → autopilot: build (a question the DECIDER settles) → review REVISE → fix (a security question it HANDS OVER)
//   → review SHIP → verify PASS → CP3 → ship → PR → merge → learn → acceptance note → CP4 → follow-up conversation
//
// The fake claude reads which command it was given from the `<command-name>` the flow puts first in every prompt,
// and writes the reports the real commands would write. Nothing here talks to a model.
//
//   node scripts/test-flow.mjs        (needs ui/dist-server: npm run build:ui)

import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL("..", import.meta.url));
const registry = require(join(root, "lib/registry.js"));
const { create } = require(join(root, "ui/dist-server/server/server.js"));

if (process.platform === "win32") { console.log("flow: skipped on Windows (shebang stand-ins)"); process.exit(0); }

let failures = 0;
const check = (name, cond, detail = "") => {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
};
const write = (p, s) => { mkdirSync(join(p, ".."), { recursive: true }); writeFileSync(p, s); };
const git = (cwd, ...a) => spawnSync("git", ["-C", cwd, ...a], { encoding: "utf8" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const home = realpathSync.native(mkdtempSync(join(tmpdir(), "cohorte-flow-")));
const globalDir = join(home, ".claude");
const storePath = join(home, ".claude.json");
const proj = join(home, "app");
const vault = join(home, "vault");
mkdirSync(proj); mkdirSync(vault);
git(proj, "init", "-q", "-b", "main");
write(join(proj, "PIPELINE.md"), "# app\n\n```yaml pipeline-profile\nname: app\nui_language: English\n```\n\n## Conventions\n\n### Shared\n\n- **SH-001** — copy in English\n");
write(join(proj, "specs", "_template.md"), "# template\n");
write(join(proj, ".gitignore"), "specs/reports/\n");
git(proj, "add", "-A");
git(proj, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
write(join(proj, ".claude", "profile.json"), JSON.stringify({ name: "app", ui_language: "English", vcs: { feature_branch_prefix: "feature/", default_branch: "main" } }));
writeFileSync(storePath, JSON.stringify({ projects: { [home]: { hasTrustDialogAccepted: true } } }));

// The installed commands: stubs — the flow only needs them to exist, the fake only reads <command-name> and ARGS.
for (const c of ["po", "lead", "build", "review", "fix", "verify", "ship", "learn", "acceptance", "product-map", "vision", "foundation", "scaffold", "init-pipeline"])
  write(join(globalDir, "commands", `cohorte-${c}.md`), `---\ndescription: stub ${c}\n---\nSTUB ${c} ARGS=$ARGUMENTS END\n`);

// ---- fake gh: one PR per branch, merged on `gh pr merge` ----
const bin = join(home, "bin");
const ghState = join(home, "gh-state.json");
writeFileSync(ghState, JSON.stringify({ state: "OPEN" }));
write(join(bin, "gh"), `#!/usr/bin/env node
const fs = require("fs"); const st = ${JSON.stringify(ghState)};
const a = process.argv.slice(2); const s = JSON.parse(fs.readFileSync(st, "utf8"));
if (a[0] === "--version") { console.log("gh version 9.9.9"); process.exit(0); }
if (a[0] === "pr" && a[1] === "list") { console.log(JSON.stringify([{ number: 7, state: s.state, url: "https://example.test/pr/7", title: "feat", isDraft: false, reviewDecision: null, statusCheckRollup: [{ conclusion: "SUCCESS", state: "SUCCESS", status: "COMPLETED" }] }])); process.exit(0); }
if (a[0] === "api" && a[1] === "user") { console.log(a.includes("--jq") ? "octo" : JSON.stringify({ login: "octo", id: 583231, name: "Octo Cat" })); process.exit(0); }
if (a[0] === "repo" && a[1] === "create") { require("child_process").spawnSync("git", ["remote", "add", "origin", "https://github.com/octo/" + a[2] + ".git"], { cwd: process.cwd() }); s.created = a; fs.writeFileSync(st, JSON.stringify(s)); console.log("created"); process.exit(0); }
if (a[0] === "pr" && a[1] === "merge") { s.state = "MERGED"; s.merged = a; fs.writeFileSync(st, JSON.stringify(s)); console.log("merged"); process.exit(0); }
process.exit(1);
`);
chmodSync(join(bin, "gh"), 0o755);
process.env.PATH = `${bin}:${process.env.PATH}`;

// ---- fake claude ----
const log = join(home, "claude-calls.jsonl");
const fake = join(home, "fake-claude.js");
writeFileSync(fake, `#!/usr/bin/env node
const fs = require("fs"), path = require("path");
const argv = process.argv.slice(2);
const opt = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ argv, cwd: process.cwd() }) + "\\n");

if (!argv.includes("--input-format")) {           // the decider: one prompt on stdin, one JSON result
  let buf = ""; process.stdin.on("data", (d) => { buf += d; });
  process.stdin.on("end", () => {
    const q = (buf.match(/^QUESTION.*$/m) || [""])[0];
    const first = (buf.match(/^OPTIONS:\\n- (.+?)(?: — .*)?$/m) || [])[1] || null;
    const vote = /security/i.test(q) ? { choice: first, category: "security", source: { kind: "none" } } : { choice: first, category: "visible", source: { kind: "spec", ref: "§5", quote: "zod everywhere" }, rationale: "the spec says zod" };
    out({ type: "result", subtype: "success", is_error: false, result: JSON.stringify(vote) });
  });
  return;
}

const sid = opt("--resume") || ("s" + Math.random().toString(16).slice(2, 10));
const rl = require("readline").createInterface({ input: process.stdin });
let pending = null;
const text = (t) => out({ type: "assistant", message: { content: [{ type: "text", text: t }] } });
const done = (t, cost = 0.01) => out({ type: "result", subtype: "success", is_error: false, result: t, total_cost_usd: cost, duration_ms: 5, num_turns: 1 });
const ask = (header, question, labels, then) => { pending = then; out({ type: "control_request", request_id: "q1", request: { subtype: "can_use_tool", tool_name: "AskUserQuestion", input: { questions: [{ question, header, multiSelect: false, options: labels.map((l) => ({ label: l, description: "" })) }] } } }); };
const W = (rel, s) => { const p = path.join(process.cwd(), rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); };
const R = (rel) => { try { return fs.readFileSync(path.join(process.cwd(), rel), "utf8"); } catch { return ""; } };
const spec = (id, status) => W("specs/" + id + ".md", "---\\nfeature_id: " + id + "\\ntitle: Export\\nstatus: " + status + "\\n---\\n## 9. DoD\\n- [x] C1 export works\\n- [ ] C2 a runtime check · runtime: smoke\\n");

rl.on("line", (line) => {
  const v = JSON.parse(line);
  if (v.type === "control_response") { const r = v.response.response; const f = pending; pending = null; if (f) f(r); return; }
  if (v.type !== "user") return;
  const prompt = v.message.content[0].text;
  out({ type: "system", subtype: "init", session_id: sid });
  const cmd = (prompt.match(/<command-name>\\/(cohorte-[a-z-]+)<\\/command-name>/) || [])[1];
  const id = (prompt.match(/ARGS=(\\S+)/) || [])[1];
  if (opt("--resume")) {                           // a reply in an existing conversation
    if (/for dentists/.test(prompt)) {
      text("Here is the vision.\\n\`\`\`cohorte-vision\\n" + JSON.stringify({ name: "Dentist", pitch: "Online booking for dentists.", users: ["the receptionist"], problem: "Phone all day.", firstVersion: ["a patient books a slot"], later: ["payments"] }) + "\\n\`\`\`\\n\`\`\`cohorte-ticket\\n" + JSON.stringify({ ref: "book", title: "Book an appointment online", criteria: ["a patient books"], priority: "high", size: "M" }) + "\\n\`\`\`\\n\`\`\`cohorte-ticket\\n" + JSON.stringify({ ref: "remind", title: "SMS reminder", priority: "medium" }) + "\\n\`\`\`");
      return done("vision");
    }
    if (/CP1 APPROVED/.test(prompt)) { const p = fs.readdirSync(path.join(process.cwd(), "specs")).find((f) => !f.startsWith("_") && f.endsWith(".md")); const fid = p.slice(0, -3); spec(fid, "frozen"); text("Frozen."); return done("frozen"); }
    if (/two tickets/.test(prompt)) {
      text("Revised.\\n\`\`\`cohorte-ticket\\n" + JSON.stringify({ ref: "csv", title: "Export appointments as CSV", need: "Revised need", criteria: ["C one", "C two"], priority: "high", size: "S" }) + "\\n\`\`\`\\n\`\`\`cohorte-ticket\\n" + JSON.stringify({ ref: "pdf", title: "Export as PDF", need: "Later", priority: "low" }) + "\\n\`\`\`");
      return done("revised");
    }
    text("ok: " + prompt.slice(0, 40)); return done("ok");
  }
  if (cmd === "cohorte-po") {
    if (/Feedback on the delivered/.test(prompt)) { text("Let us look at what is missing."); return done("follow-up"); }
    text("I understand you export by hand.\\n\`\`\`cohorte-ticket\\n" + JSON.stringify({ ref: "csv", title: "Export appointments as CSV", type: "feature", need: "The office exports by hand every week.", value: "2 hours a week", criteria: ["Given the list, when I export, then I get a CSV"], outOfScope: ["PDF"], priority: "medium", size: "M" }) + "\\n\`\`\`");
    return done("proposed");
  }
  if (cmd === "cohorte-lead") {
    spec(id, "draft");
    text("Here is the plan.\\n\`\`\`cohorte-plan\\n" + JSON.stringify({ summary: "An export endpoint and a button.", criteria: [{ id: "C1", text: "export works" }], contract: "GET /export.csv", surfaces: [{ key: "api", tasks: ["endpoint"] }], risks: [], assumptions: ["UTF-8"], questions: [], size: "M" }) + "\\n\`\`\`");
    return done("planned", 0.2);
  }
  if (cmd === "cohorte-build") {
    W("specs/reports/" + id + ".readiness.json", JSON.stringify({ verdict: "READY" }));
    if (!/Model routing: dispatch every implementer subagent with \`model: "sonnet"\`/.test(prompt)) { text("NO ROUTING LINE"); return done("no routing"); }
    return ask("visible", "Which validation library?", ["zod (Recommended)", "yup"], (r) => {
      W("specs/reports/" + id + ".build.json", JSON.stringify({ id, surfaces: { api: "ok" }, dead: [] }));
      W("specs/reports/" + id + ".notes.md", "## api · build\\n- assumed UTF-8 output\\n");
      text("built with " + JSON.stringify(r.updatedInput && r.updatedInput.answers)); done("built", 0.5);
    });
  }
  if (cmd === "cohorte-review") {
    const n = Number(R("specs/reports/.reviews") || "0") + 1; W("specs/reports/.reviews", String(n));
    if (n === 1) { W("specs/reports/" + id + ".verdict.json", JSON.stringify({ verdict: "REVISE", blocking: 1, severity: { CRITICAL: 1, HIGH: 0, MEDIUM: 0, LOW: 0 }, unreviewed: [] }));
      W("specs/reports/" + id + ".md", "# REVIEW REPORT\\nVerdict: REVISE\\n\\n## Findings\\n\\n- **[CRITICAL]** \`api/x.ts:3\` · spec-violation · wrong header → **Fix:** set it\\n\\n## Deferred\\n\\nNone.\\n"); }
    else { W("specs/reports/" + id + ".verdict.json", JSON.stringify({ verdict: "SHIP", blocking: 0, severity: { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 1 }, unreviewed: [] }));
      W("specs/reports/" + id + ".md", "# REVIEW REPORT\\nVerdict: SHIP\\n\\n## Findings\\n\\n- **[LOW]** \`api/x.ts:9\` · quality · naming → **Fix:** rename\\n\\n## Deferred\\n\\nNone.\\n"); }
    text("review " + n); return done("reviewed", 0.3);
  }
  if (cmd === "cohorte-fix") {
    return ask("security", "Should the export require the admin role?", ["Yes (Recommended)", "No"], (r) => { text("fixed: " + JSON.stringify(r.updatedInput && r.updatedInput.answers)); done("fixed", 0.2); });
  }
  if (cmd === "cohorte-verify") { W("specs/reports/" + id + ".verify.json", JSON.stringify({ verdict: "PASS" })); text("verified"); return done("verified", 0.05); }
  if (cmd === "cohorte-ship") {
    const st = (R("specs/" + id + ".md").match(/^status: (\\S+)/m) || [])[1];
    if (st === "shipped") { spec(id, "merged"); text("reconciled: merged"); return done("merged"); }
    if (!/APPROVED shipping at CP3/.test(prompt)) { text("no approval note"); return done("refused"); }
    spec(id, "shipped"); text("PR opened"); return done("shipped", 0.1);
  }
  if (cmd === "cohorte-learn") { text("2 entries"); return done("learned"); }
  if (cmd === "cohorte-acceptance") {
    text("Here is your note.\\n\`\`\`cohorte-acceptance\\n" + JSON.stringify({ summary: "You can now export appointments as a CSV file.", changes: ["An Export button on the list"], howToTest: ["Open the list, click Export: a CSV downloads"], outOfScope: ["PDF export"] }) + "\\n\`\`\`");
    return done("noted");
  }
  if (cmd === "cohorte-vision") { text("Who books today, and how?"); return done("asked"); }
  if (cmd === "cohorte-foundation") {
    const ok = /Installed on this machine/.test(prompt) && /START FROM THIS PROJECT/.test(prompt) && /SH-001/.test(prompt) && /THE VISION/.test(prompt) && /Book an appointment online/.test(prompt);
    text("Proposal.\\n\`\`\`cohorte-foundation\\n" + JSON.stringify({ summary: "One web app.", surfaces: [{ key: "web", path: "web", stack: "React", generate: "npm create vite@latest web -- --template react-ts", packageManager: "npm", test: "npm test", lint: "npm run lint", build: "npm run build" }], data: "none", devCommand: "npm run dev", conventions: ["copy in French"], questions: ok ? [] : ["MISSING CONTEXT"] }) + "\\n\`\`\`");
    return done("plan", 0.2);
  }
  if (cmd === "cohorte-scaffold") {
    const at = path.join(${JSON.stringify(home)}, "scaffold-attempts");
    const n = Number((() => { try { return fs.readFileSync(at, "utf8"); } catch { return "0"; } })()) + 1; fs.writeFileSync(at, String(n));
    if (!/Bash\\(npm:\\*\\)/.test(opt("--allowedTools") || "") || /Bash\\(rm:/.test(opt("--allowedTools") || "")) { text("WRONG ALLOWED TOOLS " + opt("--allowedTools")); return done("x"); }
    if (n === 1) { text("npm test failed.\\n\`\`\`cohorte-scaffold\\n" + JSON.stringify({ status: "failed", checks: [{ command: "npm test", ok: false, note: "1 failing" }], notes: "a test fails" }) + "\\n\`\`\`"); return done("failed"); }
    W("web/package.json", "{}"); W("README.md", "# dentist\\n");
    const g = (...a) => require("child_process").spawnSync("git", a, { cwd: process.cwd() });
    g("add", "-A"); g("commit", "-qm", "chore: walking skeleton");
    text("Skeleton ready.\\n\`\`\`cohorte-scaffold\\n" + JSON.stringify({ status: "ok", surfaces: [{ key: "web", path: "web", test: "npm test", ok: true }], devCommand: "npm run dev", checks: [{ command: "npm test", ok: true }] }) + "\\n\`\`\`");
    return done("ok", 0.4);
  }
  if (cmd === "cohorte-init-pipeline") {
    const name = path.basename(process.cwd());
    W("PIPELINE.md", "# " + name + "\\n\\n\`\`\`yaml pipeline-profile\\nname: " + name + "\\nvcs:\\n  host: none\\n  remote: none\\n  default_branch: main\\n\`\`\`\\n");
    W(".claude/pipeline.json", "{}"); W(".claude/profile.json", JSON.stringify({ name }));
    text(/APPROVED its foundations/.test(prompt) ? "Pipeline ready, from the plan." : "Pipeline ready."); return done("set up", 0.3);
  }
  if (cmd === "cohorte-product-map") { W("PRODUCT.md", "# app — what it does\\n"); text("mapped"); return done("mapped"); }
  text("unknown " + cmd); done("unknown");
});
rl.on("close", () => process.exit(0));
`);
chmodSync(fake, 0o755);
process.env.COHORTE_CLAUDE_BIN = fake;

const ui = create({ globalDir, version: "0.0.0-test", storePath });
const l = await ui.listen(0);
const call = (path, { method = "GET", body } = {}) => new Promise((resolve, reject) => {
  const data = body === undefined ? null : JSON.stringify(body);
  const req = http.request({ host: "127.0.0.1", port: l.port, path, method, headers: { Authorization: `Bearer ${l.token}`, ...(data ? { "Content-Type": "application/json" } : {}) } }, (res) => {
    let t = ""; res.on("data", (d) => { t += d; });
    res.on("end", () => { let json = null; try { json = JSON.parse(t); } catch { /* not json */ } resolve({ status: res.statusCode, json }); });
  });
  req.on("error", reject);
  if (data) req.write(data);
  req.end();
});
const post = (path, body = {}) => call(path, { method: "POST", body });
const until = async (what, fn, ms = 15000) => {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) { last = await fn(); if (last) return last; await sleep(80); }
  check(`(timeout) ${what}`, false, JSON.stringify(last));
  return null;
};

try {
  const reg = registry.add(globalDir, proj);
  const id = reg.project.id;
  const P = `/api/projects/${id}`;

  console.log("settings & tracker");
  {
    const s = (await call(`${P}/settings`)).json;
    check("defaults: balanced autonomy, opus for the PO, haiku for the decider's first vote", s.settings.autonomy === "balanced" && s.settings.models.po === "opus" && s.settings.models.decider === "haiku", JSON.stringify(s.settings));
    check("no config yet: tickets are local", s.tracker.kind === "local", JSON.stringify(s.tracker));
    check("a relative vault is refused", (await post(`${P}/tracker`, { vault: "vault" })).status === 400);
    const c = await post(`${P}/tracker`, { vault });
    check("connecting Obsidian creates the board (company layout)", c.status === 200 && c.json.created && c.json.tracker.kind === "obsidian", JSON.stringify(c.json));
    const board = readFileSync(join(vault, "app", "Tasks.md"), "utf8");
    check("the board has the company columns", board.includes("## To validate · business") && board.includes("## Acceptance"));
    const cfg = readFileSync(join(globalDir, "cohorte.config.yaml"), "utf8");
    check("the config points the project at its board", /vault_path: ".*vault"/.test(cfg) && /boards:\n\s+app:\n\s+board: "app\/Tasks.md"/.test(cfg) && /kanban:\n(?:.*\n)*?\s+enabled: true/.test(cfg), cfg);
    const saved = (await post(`${P}/settings`, { requester: "Marie", models: { review: "opus" } })).json;
    check("settings are saved (models merged per role)", saved.settings.requester === "Marie" && saved.settings.models.review === "opus" && saved.settings.models.build === "sonnet");
    await post(`${P}/settings`, { models: { review: "sonnet" } });
  }

  console.log("PO → draft ticket → CP0");
  let ticketId;
  {
    check("an empty request is refused", (await post(`${P}/po`, { text: " " })).status === 400);
    const r = await post(`${P}/po`, { text: "We export appointments by hand every week" });
    check("a PO conversation starts", r.status === 202 && r.json.run.meta.role === "po", JSON.stringify(r.json));
    await until("the fake claude started", async () => existsSync(log));
    const calls = readFileSync(log, "utf8").trim().split("\n").map((x) => JSON.parse(x));
    const po = calls[calls.length - 1];
    check("flow runs load only the project's MCP servers", po.argv.includes("--strict-mcp-config"));
    check("the PO runs read-only, on its model", po.argv.includes("--model") && po.argv[po.argv.indexOf("--model") + 1] === "opus" && /Bash/.test(po.argv[po.argv.indexOf("--disallowedTools") + 1]) && /Write/.test(po.argv[po.argv.indexOf("--disallowedTools") + 1]), JSON.stringify(po.argv));
    const t = await until("a draft ticket", async () => (await call(`${P}/tickets`)).json.tickets.find((x) => x.status === "validate"));
    ticketId = t && t.id;
    check("the proposal became a ticket to validate, with the requester", t && t.title === "Export appointments as CSV" && t.requester === "Marie" && t.criteria.length === 1, JSON.stringify(t));
    check("its note is in the vault", existsSync(join(vault, "app", "Tickets", `${ticketId}.md`)));
    const board = (await until("the card", async () => { const b = readFileSync(join(vault, "app", "Tasks.md"), "utf8"); return b.includes("#export-appointments-as-csv") ? b : null; })) || "";
    check("its card sits under To validate, linked to the note", /## To validate · business\n\n- \[ \] \[\[app\/Tickets\/export-appointments-as-csv\|Export appointments as CSV\]\]  #export-appointments-as-csv/.test(board), board);
    const inbox = (await call("/api/inbox")).json.items;
    check("the inbox shows CP0", inbox.some((i) => i.kind === "cp0" && i.ref === ticketId), JSON.stringify(inbox));
    // a revision with the same ref updates the draft; a new ref adds a second draft
    const runId = r.json.run.id;
    await until("the PO turn ended", async () => (await call(`${P}/runs/${runId}`)).json.status === "done");
    check("reply → 202", (await post(`${P}/runs/${runId}/reply`, { text: "make it two tickets please" })).status === 202);
    const two = await until("two drafts", async () => { const ts = (await call(`${P}/tickets`)).json.tickets; return ts.length === 2 ? ts : null; });
    const csv = two && two.find((x) => x.id === ticketId);
    check("the same ref revised the same ticket", csv && csv.need === "Revised need" && csv.criteria.length === 2 && csv.size === "S", JSON.stringify(csv));
    const conv = (await call(`${P}/tickets`)).json.conversations[0];
    check("the conversation lists the tickets it created", conv && Object.keys(conv.tickets).sort().join() === "csv,pdf", JSON.stringify(conv));
    check("a backlog ticket cannot be taken before CP0", (await post(`${P}/tickets/${ticketId}/take`, {})).status === 409);
    const v = await post(`${P}/tickets/${ticketId}/decide`, { action: "validate" });
    check("CP0: validate → backlog", v.status === 200 && v.json.ticket.status === "backlog");
    check("CP0 twice → 409", (await post(`${P}/tickets/${ticketId}/decide`, { action: "validate" })).status === 409);
    const pdf = two.find((x) => x.id !== ticketId);
    check("CP0: reject", (await post(`${P}/tickets/${pdf.id}/decide`, { action: "reject" })).json.ticket.status === "rejected");
    check("a tech ticket goes straight to the backlog", (await post(`${P}/tickets`, { title: "Upgrade the runtime", need: "EOL" })).json.ticket.status === "backlog");
  }

  console.log("take → lead → CP1");
  const F = () => `${P}/features/${ticketId}`;
  {
    const t = await post(`${P}/tickets/${ticketId}/take`, {});
    check("take → 202, a worktree is being created", t.status === 202 && t.json.feature.phase === "provisioning", JSON.stringify(t.json));
    check("taking it twice → 409", (await post(`${P}/tickets/${ticketId}/take`, {})).status === 409);
    const f = await until("CP1", async () => { const x = (await call(F())).json; return x.phase === "cp1" ? x : null; });
    check("the worktree is a sibling on feature/<id>", f && f.worktree === join(home, `app-${ticketId}`) && f.branch === `feature/${ticketId}`, JSON.stringify(f && { w: f.worktree, b: f.branch }));
    check("the lead posted a plan, CP1 is open", f && f.plan && f.plan.summary.includes("export endpoint") && f.checkpoint.kind === "cp1");
    check("the ticket moved to framing", (await call(`${P}/tickets/${ticketId}`)).json.ticket.status === "framing");
    const lead = readFileSync(log, "utf8").trim().split("\n").map((x) => JSON.parse(x)).find((c) => c.cwd === f.worktree);
    check("the lead runs in the worktree on its model", lead && lead.argv[lead.argv.indexOf("--model") + 1] === "opus");
    check("CP3 actions are refused at CP1", (await post(`${F()}/checkpoint`, { action: "correct", text: "x" })).status === 400);
    check("approve → 200", (await post(`${F()}/checkpoint`, { action: "approve" })).status === 200);
  }

  console.log("autopilot: build (decider) → review → fix (handed over) → review → verify → CP3");
  {
    const q = await until("the security question waits for the developer", async () => {
      const x = (await call(F())).json;
      if (!x.currentRunId) return null;
      const r = (await call(`${P}/runs/${x.currentRunId}`)).json;
      return r.meta.stage === "fix" && r.pending.length && !r.pending[0].deciding ? { x, r } : null;
    }, 30000);
    if (q) {
      const { x, r } = q;
      const dec = x.decisions.find((d) => d.by === "decider");
      const votes = readFileSync(log, "utf8").trim().split("\n").map((x) => JSON.parse(x)).filter((c) => !c.argv.includes("--input-format"));
      check("decider votes run bare: no tools, no MCP servers, no settings, haiku first", votes.length >= 3 && votes.every((c) => c.argv.includes("--strict-mcp-config") && c.argv[c.argv.indexOf("--tools") + 1] === "" && c.argv.includes("--setting-sources")) && votes[0].argv[votes[0].argv.indexOf("--model") + 1] === "haiku", JSON.stringify(votes[0] && votes[0].argv));
      check("the decider settled the build question from the spec", dec && dec.chosen === "zod (Recommended)" && dec.source.kind === "spec" && dec.agreement === 1, JSON.stringify(x.decisions));
      check("the stages ran on their models", x.stages.map((s) => `${s.stage}:${s.model}`).join() === "build:sonnet,review:sonnet,fix:sonnet", JSON.stringify(x.stages));
      check("the security question was handed over with the decider's reading", r.pending[0].advice && /security/.test(r.pending[0].advice.escalated), JSON.stringify(r.pending[0]));
      const inbox = (await call("/api/inbox")).json.items;
      check("the inbox shows the question, with its feature", inbox.some((i) => i.kind === "question" && i.feature === ticketId), JSON.stringify(inbox));
      check("answer → 200", (await post(`${P}/runs/${r.id}/respond`, { requestId: r.pending[0].requestId, behavior: "allow", answers: { "Should the export require the admin role?": ["Yes (Recommended)"] } })).status === 200);
    }
    const f = await until("CP3", async () => { const x = (await call(F())).json; return x.phase === "cp3" || x.phase === "cp2" ? x : null; }, 30000);
    check("CP3 opens once review and verify are clean", f && f.phase === "cp3", JSON.stringify(f && { phase: f.phase, cp: f.checkpoint, stages: f.stages.map((s) => s.stage + ":" + s.status) }));
    if (f) {
      check("the loop was build → review → fix → review → verify", f.stages.map((s) => s.stage).join() === "build,review,fix,review,verify", f.stages.map((s) => s.stage).join());
      check("your answer is recorded as yours", f.decisions.some((d) => d.by === "human" && d.chosen === "Yes (Recommended)"));
      check("CP3 shows the DoD, the assumptions and the review", f.dod.length === 2 && f.assumptions.includes("assumed UTF-8 output") && f.review && f.review.verdict === "SHIP", JSON.stringify({ dod: f.dod, a: f.assumptions, r: f.review && f.review.verdict }));
      check("decisions and corrections are mirrored for /cohorte-learn", /\[decider\] build · visible · Which validation library\? → \*\*zod \(Recommended\)\*\*/.test(readFileSync(join(f.worktree, "specs", "reports", `${ticketId}.decisions.md`), "utf8")));
      check("the card is under To validate · dev", !!(await until("the card under To validate · dev", async () => /## To validate · dev\n\n- \[ \] .*#export-appointments-as-csv/.test(readFileSync(join(vault, "app", "Tasks.md"), "utf8")))));
      const dec = f.decisions.find((d) => d.by === "decider");
      check("contest a decision → 200", (await post(`${F()}/decisions/${dec.id}/contest`, { note: "we use valibot" })).status === 200);
    }
    check("approve → shipping", (await post(`${F()}/checkpoint`, { action: "approve" })).json.feature.phase === "shipping");
  }

  console.log("PR → merge → learn → acceptance → CP4");
  {
    const f = await until("the PR", async () => { const x = (await call(F())).json; return x.phase === "pr" ? x : null; });
    check("the PR was found on the host", f && f.pr && f.pr.number === 7 && f.pr.checks === "success", JSON.stringify(f && f.pr));
    check("the ticket shows its PR", (await call(`${P}/tickets/${ticketId}`)).json.ticket.pr === "#7");
    check("merge → 202", (await post(`${F()}/merge`)).status === 202);
    const t = await until("acceptance", async () => { const x = (await call(`${P}/tickets/${ticketId}`)).json.ticket; return x.status === "acceptance" ? x : null; }, 20000);
    check("merged with the configured method", JSON.parse(readFileSync(ghState, "utf8")).merged.includes("--squash"));
    check("the acceptance note is in the ticket", t && t.acceptance && t.acceptance.summary.includes("export appointments") && t.acceptance.howToTest.length === 1, JSON.stringify(t && t.acceptance));
    check("…and in its note in the vault", readFileSync(join(vault, "app", "Tickets", `${ticketId}.md`), "utf8").includes("### How to test"));
    const f2 = (await call(F())).json;
    check("learn and acceptance ran after the merge, then the reconcile", f2.stages.map((s) => s.stage).slice(-4).join() === "ship,learn,acceptance,reconcile", f2.stages.map((s) => s.stage).join());
    check("the decider's confirmed choice is remembered (and the contested one)", (() => { const p = readFileSync(join(globalDir, "cohorte-ui", "prefs", `${id}.jsonl`), "utf8"); return /"kind":"contested"/.test(p) && /"kind":"answer"/.test(p); })());
    const inbox = (await call("/api/inbox")).json.items;
    check("the inbox shows CP4", inbox.some((i) => i.kind === "cp4" && i.ref === ticketId));
    check("not quite without a note → 400", (await post(`${P}/tickets/${ticketId}/acceptance`, { action: "not-quite" })).status === 400);
    const nq = await post(`${P}/tickets/${ticketId}/acceptance`, { action: "not-quite", text: "the dates are in the wrong format" });
    check("CP4 not quite: done, feedback kept, a follow-up PO conversation opens", nq.status === 200 && nq.json.ticket.status === "done" && nq.json.ticket.feedback.length === 1 && nq.json.run && nq.json.run.meta.ticketId === ticketId, JSON.stringify(nq.json));
    check("the feature is done", (await call(F())).json.phase === "done");
    const learning = (await call(`${P}/learning`)).json;
    check("learning stats count the decider's work", learning.decisions.byDecider === 1 && learning.decisions.contested === 1 && learning.stages.some((s) => s.stage === "build"), JSON.stringify(learning));
  }

  console.log("new project: idea → vision → foundations → skeleton → pipeline → code host");
  {
    // No identity anywhere — the machine of the incident: git would sign cohorte's commits <user>@<hostname>.
    const noGlobal = join(home, "gitconfig-empty"); writeFileSync(noGlobal, "");
    const saved = {};
    for (const k of ["GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL", "EMAIL", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM"]) { saved[k] = process.env[k]; delete process.env[k]; }
    process.env.GIT_CONFIG_GLOBAL = noGlobal; process.env.GIT_CONFIG_NOSYSTEM = "1";
    check("a bad folder name is refused", (await post("/api/founding", { mode: "idea", name: "../x", parent: home, brief: "x" })).status === 400);
    check("an idea needs a brief", (await post("/api/founding", { mode: "idea", name: "dentist", parent: home })).status === 400);
    mkdirSync(join(home, "taken")); writeFileSync(join(home, "taken", "f"), "x");
    check("a non-empty folder is refused", (await post("/api/founding", { mode: "stack", name: "taken", parent: home })).status === 409);
    const c = await post("/api/founding", { mode: "idea", name: "dentist", parent: home, brief: "Patients call all day to book", requester: "Dr. B", basedOn: id });
    check("New project → 201, a founding project, the PO talks first", c.status === 201 && c.json.project.founding === "vision" && c.json.founding.phase === "vision", JSON.stringify(c.json));
    const nid = c.json.project.id; const N = `/api/projects/${nid}`; const nroot = join(home, "dentist");
    check("the folder is a git repo on main", git(nroot, "symbolic-ref", "--short", "HEAD").stdout.trim() === "main");
    await until("the PO asked", async () => { const v = (await call(`${N}/founding`)).json; return v.stages[0] && v.stages[0].status === "done" ? v : null; });
    check("reply → 202", (await post(`${N}/founding/reply`, { text: "Receptionists, for dentists" })).status === 202);
    const cv = await until("the vision checkpoint", async () => { const v = (await call(`${N}/founding`)).json; return v.phase === "cp-vision" ? v : null; });
    check("the vision and its tickets are parsed", cv && cv.vision.pitch === "Online booking for dentists." && cv.tickets.length === 2, JSON.stringify(cv));
    check("the inbox shows it", (await call("/api/inbox")).json.items.some((i) => i.kind === "founding" && i.projectId === nid));
    check("approving the foundations now → 409", (await post(`${N}/founding/checkpoint`, { action: "retry" })).status === 409);
    const a = await post(`${N}/founding/checkpoint`, { action: "approve" });
    check("vision approved → the lead takes over", a.status === 200 && a.json.phase === "foundation", JSON.stringify(a.json));
    check("PRODUCT.md is written from the vision", readFileSync(join(nroot, "PRODUCT.md"), "utf8").includes("Online booking for dentists."));
    const cf = await until("the foundations checkpoint", async () => { const v = (await call(`${N}/founding`)).json; return v.phase === "cp-foundation" || (v.foundation && v.foundation.questions.length) ? v : null; });
    check("the lead got the vision, the machine, the other projects and the project to start from", cf && cf.phase === "cp-foundation", JSON.stringify(cf && cf.foundation));
    const lead = readFileSync(log, "utf8").trim().split("\n").map((x) => JSON.parse(x)).filter((x) => x.cwd === nroot);
    check("the vision runs read-only on the PO's model, the foundations on the lead's", lead[0].argv[lead[0].argv.indexOf("--model") + 1] === "opus" && /Write/.test(lead[0].argv[lead[0].argv.indexOf("--disallowedTools") + 1]));
    check("the view says the identity is missing", cf && cf.identity && cf.identity.status === "missing", JSON.stringify(cf && cf.identity));
    const blocked = await post(`${N}/founding/checkpoint`, { action: "approve" });
    check("no identity → approving the foundations is refused (nothing gets committed under <user>@<hostname>)", blocked.status === 409 && /git identity/.test(blocked.json.error) && (await call(`${N}/founding`)).json.phase === "cp-foundation", JSON.stringify(blocked.json));
    const idi = (await call(`${N}/founding/identity`)).json;
    check("the signed-in GitHub identity is proposed, with its no-reply address", idi.github && idi.github.name === "Octo Cat" && idi.github.email === "583231+octo@users.noreply.github.com" && idi.gh.authed, JSON.stringify(idi));
    check("a hostname email is refused", (await post(`${N}/founding/identity`, { source: "manual", name: "x", email: "x@Mac.lan" })).status === 400);
    const setId = await post(`${N}/founding/identity`, { source: "github" });
    check("use my GitHub identity → set, ok", setId.status === 200 && setId.json.identity.status === "ok" && setId.json.identity.email === "583231+octo@users.noreply.github.com", JSON.stringify(setId.json.identity));
    check("…in this repository only", git(nroot, "config", "--local", "user.email").stdout.trim() === "583231+octo@users.noreply.github.com" && readFileSync(noGlobal, "utf8") === "");
    check("approve the foundations → the skeleton", (await post(`${N}/founding/checkpoint`, { action: "approve" })).json.phase === "scaffold");
    const cs = await until("the skeleton fails once", async () => { const v = (await call(`${N}/founding`)).json; return v.phase === "cp-scaffold" ? v : null; });
    check("a failed skeleton opens its checkpoint, with the report", cs && /checks failed/.test(cs.error) && cs.scaffold && cs.scaffold.status === "failed", JSON.stringify(cs));
    const sc = readFileSync(log, "utf8").trim().split("\n").map((x) => JSON.parse(x)).filter((x) => x.cwd === nroot && x.argv.includes("--allowedTools"));
    check("the skeleton may run the plan's tools without asking — not a remover or a shell", sc.length && /Bash\(npm:\*\)/.test(sc[0].argv[sc[0].argv.indexOf("--allowedTools") + 1]) && !/Bash\((rm|sh|curl):/.test(sc[0].argv[sc[0].argv.indexOf("--allowedTools") + 1]), JSON.stringify(sc[0] && sc[0].argv));
    check("retry → 200", (await post(`${N}/founding/checkpoint`, { action: "retry" })).status === 200);
    const dn = await until("the project is ready", async () => { const v = (await call(`${N}/founding`)).json; return v.phase === "done" || v.phase === "cp-scaffold" ? v : null; }, 20000);
    check("skeleton → pipeline set-up → done", dn && dn.phase === "done", JSON.stringify(dn && { phase: dn.phase, error: dn.error, stages: dn.stages.map((x) => x.stage + ":" + x.status) }));
    const retry = readFileSync(log, "utf8").trim().split("\n").map((x) => JSON.parse(x)).filter((x) => x.cwd === nroot && x.argv.includes("--allowedTools") && /npm/.test(x.argv[x.argv.indexOf("--allowedTools") + 1]));
    check("the retry ran one model up", retry.length === 2 && retry[1].argv[retry[1].argv.indexOf("--model") + 1] === "opus", JSON.stringify(retry.map((x) => x.argv[x.argv.indexOf("--model") + 1])));
    const commits = git(nroot, "log", "--format=%s").stdout.trim().split("\n");
    check("two commits: the skeleton, then the pipeline", commits.join("|") === "chore: set up the cohorte pipeline|chore: walking skeleton", commits.join("|"));
    const authors = git(nroot, "log", "--format=%an <%ae>").stdout.trim().split("\n");
    check("both authored by the GitHub identity", authors.every((x) => x === "Octo Cat <583231+octo@users.noreply.github.com>"), authors.join("|"));
    const st = (await call("/api/state")).json.projects.find((p) => p.id === nid);
    check("no longer founding: an ordinary project", st && !st.founding, JSON.stringify(st));
    const tk = (await call(`${N}/tickets`)).json.tickets;
    check("the first version's tickets are in the backlog", tk.length === 2 && tk.every((t) => t.status === "backlog" && t.requester === "Dr. B"), JSON.stringify(tk));

    const r0 = (await call(`${N}/remote`)).json;
    check("no code host yet; gh is there and signed in", r0.origin === null && r0.gh.installed && r0.gh.authed && r0.gh.user === "octo", JSON.stringify(r0));
    check("a bad remote URL is refused", (await post(`${N}/remote`, { kind: "url", url: "file:///etc" })).status === 400);
    const rj = await post(`${N}/remote`, { kind: "github", name: "dentist", visibility: "private" });
    check("create on GitHub → 202 (a job)", rj.status === 202 && rj.json.job, JSON.stringify(rj.json));
    const r1 = await until("the remote", async () => { const x = (await call(`${N}/remote`)).json; return x.origin ? x : null; });
    check("origin is the new repository", r1 && r1.origin === "https://github.com/octo/dentist.git");
    check("gh created it private, from this folder, and pushed", JSON.parse(readFileSync(ghState, "utf8")).created.join(" ") === "repo create dentist --private --source . --remote origin --push");
    const md = readFileSync(join(nroot, "PIPELINE.md"), "utf8");
    check("the profile now points at it (so shipping opens PRs there), committed", /\n  host: github\n/.test(md) && /\n  remote: octo\/dentist\n/.test(md) && git(nroot, "log", "-1", "--format=%s").stdout.trim() === "chore: point the pipeline at octo/dentist", md);
    check("a second remote → 409", (await post(`${N}/remote`, { kind: "github", name: "x" })).status === 409);
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    for (const [k, v] of Object.entries({ GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" })) process.env[k] = v;
  }

  console.log("new project: an existing repository without cohorte");
  {
    const ex = join(home, "legacy");
    mkdirSync(ex); git(ex, "init", "-q", "-b", "main"); writeFileSync(join(ex, "index.js"), "1\n"); git(ex, "add", "-A"); git(ex, "commit", "-qm", "init");
    const add = await post("/api/projects", { path: ex });
    check("adding it says it does not use cohorte yet", add.status === 400 && add.json.notCohorte === true, JSON.stringify(add.json));
    const c = await post("/api/founding", { mode: "existing", path: ex });
    check("set it up from here → the pipeline set-up starts", c.status === 201 && c.json.founding.phase === "setup", JSON.stringify(c.json));
    const v = await until("ready", async () => { const x = (await call(`/api/projects/${c.json.project.id}/founding`)).json; return x.phase === "done" ? x : null; });
    check("done, nothing committed for you", v && /not committed/.test(v.warning) && git(ex, "log", "--format=%s").stdout.trim() === "init", JSON.stringify(v));
    // The set-up reads the core (templates, steps) but must never be able to edit it: no `--add-dir` (acceptEdits would
    // auto-accept edits there), only a Read rule for it.
    const runs = readFileSync(log, "utf8").trim().split("\n").map((x) => JSON.parse(x));
    const setup = runs.filter((x) => x.cwd === ex && x.argv.includes("--allowedTools"));
    const tools = setup.length ? setup[0].argv[setup[0].argv.indexOf("--allowedTools") + 1] : "";
    const core = join(globalDir, "cohorte").split("\\").join("/").replace(/^([A-Za-z]):/, (_, l) => "/" + l.toLowerCase());
    check("the set-up may read the core without asking — a Read rule, nothing that writes", setup.length && tools.includes(`Read(/${core}/**)`) && !/\b(Write|Edit)\(/.test(tools), tools);
    check("no run is ever given an extra working directory (--add-dir)", runs.every((x) => !x.argv.includes("--add-dir")), JSON.stringify(runs.filter((x) => x.argv.includes("--add-dir")).map((x) => x.argv)));
    check("a cohorte project cannot be set up twice", (await post("/api/founding", { mode: "existing", path: ex })).status === 409);
  }

  console.log("restart");
  {
    const ui2 = create({ globalDir, version: "0.0.0-test", storePath });
    const f = ui2.flow.features.get(id, ticketId);
    check("a feature survives a restart", f && f.phase === "done");
    await ui2.close();
  }
} finally {
  await ui.close();
  rmSync(home, { recursive: true, force: true });
}

if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log("\nflow: all checks passed");
