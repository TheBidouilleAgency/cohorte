// Stand-ins for `claude` and `gh`, and a throw-away project wired for the company flow — shared by the flow suites
// (test-flow.mjs drives them through the HTTP server, test-cli-flow.mjs through the CLI verbs).
//
// The fake claude reads which command it was given from the `<command-name>` the flow puts first in every prompt,
// and writes the reports the real commands would write. Nothing here talks to a model. Shebang scripts: POSIX only.

import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const write = (p, s) => { mkdirSync(join(p, ".."), { recursive: true }); writeFileSync(p, s); };
const git = (cwd, ...a) => spawnSync("git", ["-C", cwd, ...a], { encoding: "utf8" });

/** Builds the sandbox under a fresh temp home and points PATH (gh) and COHORTE_CLAUDE_BIN (claude) at the fakes. */
export function standIns(prefix = "cohorte-flow-") {
const home = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
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
  return { home, globalDir, storePath, proj, vault, bin, ghState, log, fake };
}
