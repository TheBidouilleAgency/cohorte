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
for (const c of ["po", "lead", "build", "review", "fix", "verify", "ship", "learn", "acceptance", "product-map"])
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
