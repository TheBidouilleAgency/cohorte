#!/usr/bin/env node
// Installer + project-wiring tests (bin/cli.js, lib/install.js, lib/project.js).
//
// Every assertion here is a postcondition on what actually lands on disk, run through the
// real CLI in a scratch CLAUDE_CONFIG_DIR + HOME (never the developer's). Several are
// regressions that shipped in 2.x:
//   - install deleted any ~/.claude/commands/{review,build,spec,…}.md, ours or not;
//   - a settings.json that did not parse was replaced by a fresh one (model, env, permissions lost);
//   - any hook whose command ended in `gate.py` was treated as ours and removed;
//   - there was no uninstall, and nothing knew which files the install owned.
//
//   node scripts/test-install.mjs

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = fileURLToPath(new URL("..", import.meta.url));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const { profileJsonText, parseProfileBlock } = createRequire(import.meta.url)(join(root, "lib", "yaml.js"));
const CLI = join(root, "bin", "cli.js");
const WIN = process.platform === "win32";

let failures = 0;
const check = (name, cond, detail = "") => {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
};
const tmps = [];
const scratch = (p = "cohorte-install-") => { const d = mkdtempSync(join(tmpdir(), p)); tmps.push(d); return d; };
const write = (p, s) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, s); };
const read = (p) => readFileSync(p, "utf8");
const walk = (dir) => {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]);
};
const treeHash = (dir) => createHash("sha256").update(walk(dir).sort()
  .map((f) => `${relative(dir, f)}\0${read(f)}`).join("\0")).digest("hex");

// A sandbox: a fake HOME with its own ~/.claude. CLAUDE_CONFIG_DIR is what the CLI honours
// on every platform (HOME is ignored by os.homedir() on Windows); HOME is set too so `~`
// expansions in legacy hook commands resolve inside the sandbox.
function sandbox() {
  const home = scratch("cohorte-home-");
  return { home, g: join(home, ".claude") };
}
function cli(sb, ...args) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    env: { ...process.env, HOME: sb.home, USERPROFILE: sb.home, CLAUDE_CONFIG_DIR: sb.g,
      COHORTE_NO_VERSION_CHECK: "1", CI: "1" },
    input: "",
  });
  return { status: r.status, out: (r.stdout || "") + (r.stderr || "") };
}
function gitRepo() {
  const d = scratch("cohorte-proj-");
  const git = (...a) => spawnSync("git", ["-C", d, ...a], { encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.invalid");
  git("config", "user.name", "t");
  git("commit", "-q", "--allow-empty", "-m", "init");
  return { d, git };
}

const commands = readdirSync(join(root, "core/commands")).filter((f) => f.endsWith(".md"));
const fixedAgents = readdirSync(join(root, "core/agents")).filter((f) => f.endsWith(".md") && !f.endsWith(".template.md"));
const workflows = readdirSync(join(root, "core/workflows")).filter((f) => f.endsWith(".js"));
const templates = walk(join(root, "core/templates")).map((f) => relative(join(root, "core/templates"), f));
const shippedScripts = readdirSync(join(root, "scripts"))
  .filter((f, _, all) => f.endsWith(".sh") && !all.includes(`${f}.template`));

// ── A. fresh install ──────────────────────────────────────────────────────────
console.log("install — a fresh machine");
{
  const sb = sandbox();
  const r = cli(sb, "install");
  check("exits 0", r.status === 0, r.out);
  for (const f of commands) check(`commands/${f}`, existsSync(join(sb.g, "commands", f)));
  for (const f of fixedAgents) check(`agents/${f}`, existsSync(join(sb.g, "agents", f)));
  check("fixed agents are namespaced (cohorte-*)", fixedAgents.every((f) => f.startsWith("cohorte-")), fixedAgents.join(","));
  for (const f of workflows) check(`workflows/cohorte-${f}`, existsSync(join(sb.g, "workflows", `cohorte-${f}`)));
  for (const t of templates) check(`cohorte/templates/${t}`, existsSync(join(sb.g, "cohorte", "templates", t)));
  for (const f of ["VERSION", "SCHEMA.md", "PIPELINE.template.md", "cohorte.config.template.yaml",
    "implementer.template.md", "CHANGELOG.md"]) {
    check(`cohorte/pipeline/${f}`, existsSync(join(sb.g, "cohorte", "pipeline", f)));
  }
  const topics = readdirSync(join(root, "profile/schema")).filter((f) => f.endsWith(".md"));
  check("the schema topic files ship (one per section, indexed by SCHEMA.md)", topics.length > 10
    && topics.every((f) => read(join(sb.g, "cohorte/pipeline/schema", f)) === read(join(root, "profile/schema", f))), topics.join(","));
  check("a rendered command cites a schema topic file that is installed", (() => {
    const m = read(join(sb.g, "commands/cohorte-build.md")).match(/<core>\/pipeline\/schema\/([a-z0-9-]+\.md)/);
    return m && existsSync(join(sb.g, "cohorte/pipeline/schema", m[1]));
  })());
  check("VERSION is the package version", read(join(sb.g, "cohorte/pipeline/VERSION")).trim() === pkg.version);
  for (const s of shippedScripts) {
    const p = join(sb.g, "cohorte", "pipeline", "scripts", s);
    check(`shipped script ${s}`, existsSync(p));
    if (!WIN && existsSync(p)) check(`${s} is executable`, (statSync(p).mode & 0o111) !== 0);
  }
  check("per-project scripts ship as templates only",
    existsSync(join(sb.g, "cohorte/pipeline/scripts/new-feature.sh.template"))
      && !existsSync(join(sb.g, "cohorte/pipeline/scripts/new-feature.sh")));
  check("the gate and the project wiring lib ship in the core",
    existsSync(join(sb.g, "cohorte/hooks/gate.py")) && existsSync(join(sb.g, "cohorte/lib/project.js")));
  check("…with the parser sync needs for .claude/profile.json, next to it",
    read(join(sb.g, "cohorte/lib/yaml.js")) === read(join(root, "lib/yaml.js")));
  check("no bytecode cache rides along", !walk(sb.g).some((f) => /__pycache__|\.pyc$/.test(f)));
  check("the user config is seeded", existsSync(join(sb.g, "cohorte.config.yaml")));
  check("no settings.json is written machine-wide (the gate is per project)", !existsSync(join(sb.g, "settings.json")));
  // `Library/` is macOS's own Python bytecode cache (the CLI probes python3), not ours.
  check("nothing lands in HOME outside ~/.claude",
    readdirSync(sb.home).every((n) => n === ".claude" || n === "Library"), readdirSync(sb.home).join(","));
  check("nothing generic is written (no ~/.claude/templates, pipeline/, hooks/)",
    ["templates", "pipeline", "hooks"].every((d) => !existsSync(join(sb.g, d))));
  const manifest = JSON.parse(read(join(sb.g, "cohorte/manifest.json")));
  const installed = walk(sb.g).map((f) => relative(sb.g, f).split("\\").join("/"))
    .filter((f) => f !== "cohorte/manifest.json" && f !== "cohorte.config.yaml");
  check("the manifest lists exactly the installed files",
    JSON.stringify(Object.keys(manifest.files).sort()) === JSON.stringify(installed.sort()));
  const build = read(join(sb.g, "commands/cohorte-build.md"));
  check("a rendered command keeps its model pin", /^model: sonnet$/m.test(build));
  check("a rendered command resolves its tokens in a preamble", build.includes("> - `<core>` =") && build.includes("<sync>"));
  check("no capability conditional survives a render", !walk(sb.g).some((f) => /\.md$/.test(f) && read(f).includes("<!-- cohorte:")));
  check("the implementer template stays a template (no agent of that name)",
    !existsSync(join(sb.g, "agents/implementer.template.md")));

  // ── B. idempotence ──────────────────────────────────────────────────────────
  const before = treeHash(sb.g);
  const again = cli(sb, "update");
  check("update exits 0", again.status === 0, again.out);
  check("a second run writes nothing", /\(0 written/.test(again.out), again.out);
  check("…and leaves the tree byte-identical", treeHash(sb.g) === before);
}

// ── C. ownership ──────────────────────────────────────────────────────────────
console.log("install — never touches what it does not own");
{
  const sb = sandbox();
  const mine = {
    "commands/review.md": "my own review command\n",
    "commands/build.md": "my build notes\n",
    "agents/review.md": "---\nname: review\n---\nmy reviewer\n",
    "agents/helper.md": "mine\n",
    "templates/spec.template.md": "my template\n",
    "workflows/review.js": "export const meta = { name: 'mine' }\n",
  };
  for (const [rel, s] of Object.entries(mine)) write(join(sb.g, rel), s);
  const settings = { model: "opus", env: { A: "1" }, permissions: { allow: ["Bash(ls)"] },
    hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "python3 ~/tools/gate.py" }] }] } };
  write(join(sb.g, "settings.json"), JSON.stringify(settings, null, 2));
  const settingsBefore = read(join(sb.g, "settings.json"));
  check("install exits 0", cli(sb, "install").status === 0);
  for (const [rel, s] of Object.entries(mine)) check(`your ${rel} is untouched`, existsSync(join(sb.g, rel)) && read(join(sb.g, rel)) === s);
  check("settings.json (with another tool's gate.py hook) is byte-identical", read(join(sb.g, "settings.json")) === settingsBefore);

  // A file of OURS the user edited is backed up before being refreshed.
  const ours = join(sb.g, "commands/cohorte-build.md");
  writeFileSync(ours, read(ours) + "\nmy local tweak\n");
  const r = cli(sb, "update");
  check("an edited cohorte file is refreshed", !read(ours).includes("my local tweak"));
  const backups = walk(join(sb.g, "cohorte/backup")).filter((f) => f.endsWith("cohorte-build.md"));
  check("…after a backup of the edited copy", backups.length === 1 && read(backups[0]).includes("my local tweak"), r.out);
  check("…and the run says so", /differed from what cohorte installed/.test(r.out), r.out);
}

// ── D. a broken settings.json aborts, untouched ───────────────────────────────
console.log("install — refuses to run on a settings.json it cannot parse");
{
  const sb = sandbox();
  const broken = '{\n  "model": "opus",\n  "permissions": {"allow": ["Bash(ls)"]},\n}\n';
  write(join(sb.g, "settings.json"), broken);
  const r = cli(sb, "install");
  check("exits non-zero", r.status === 1, r.out);
  check("names the file and says nothing was rewritten", /settings\.json is not valid JSON/.test(r.out), r.out);
  check("the file is byte-identical", read(join(sb.g, "settings.json")) === broken);
  check("nothing was installed", !existsSync(join(sb.g, "cohorte")) && !existsSync(join(sb.g, "commands")));
}

// ── D2. an install that fails half-way is rolled back ─────────────────────────
console.log("install — a failure half-way is rolled back");
{
  const sb = sandbox();
  check("first install exits 0", cli(sb, "install").status === 0);
  // An earlier file the update will rewrite (an edit of ours), then a path that cannot be
  // written later in the same run (a directory where cohorte-spec.md goes).
  const build = join(sb.g, "commands/cohorte-build.md");
  writeFileSync(build, "edited\n");
  const spec = join(sb.g, "commands/cohorte-spec.md");
  rmSync(spec);
  mkdirSync(spec);
  const r = cli(sb, "update");
  check("the failing update exits 1 and says it rolled back", r.status === 1 && /rolled back/.test(r.out), r.out);
  check("the file it had already rewritten is back as it was", read(build) === "edited\n");
  rmSync(spec, { recursive: true });
  const ok = cli(sb, "update");
  check("once the obstacle is gone, the update completes", ok.status === 0 && !read(build).startsWith("edited"), ok.out);
  check("…and the edited copy was backed up first",
    walk(join(sb.g, "cohorte/backup")).some((f) => f.endsWith("cohorte-build.md") && read(f) === "edited\n"));
}

// ── E. 2.x global install → 3.x ───────────────────────────────────────────────
console.log("update — migrates a 2.x global install");
{
  const sb = sandbox();
  const marker = "> **Runtime: Claude Code.** Generated by the cohorte adapter — do not edit this file;\n";
  write(join(sb.g, "pipeline/VERSION"), "2.10.2\n");
  write(join(sb.g, "pipeline/scripts/preflight.sh"), "#!/bin/sh\n");
  write(join(sb.g, "hooks/gate.py"), "# reads gate-config.json\n");
  write(join(sb.g, "templates/spec.template.md"), "2.x spec template\n");
  write(join(sb.g, "templates/steps/init-pipeline/01-detect-stack.md"), "x\n");
  write(join(sb.g, "workflows/review.js"), "export const meta = {\n  name: 'cohorte-review',\n}\n");
  write(join(sb.g, "agents/review.md"), `---\nname: review\n---\n${marker}`);
  write(join(sb.g, "agents/frontend.md"), `---\nname: frontend\ndescription: Dispatched by /cohorte-build.\n---\n${marker}`);
  write(join(sb.g, "commands/build.md"), "Read PIPELINE.md then dispatch implementers (1.x)\n");
  write(join(sb.g, "commands/cohorte-loop.md"), `---\ndescription: x\n---\n${marker}`);
  write(join(sb.g, "commands/cohorte-build.md"), `---\nmodel: sonnet\n---\n${marker}old body\n`);
  write(join(sb.g, "commands/notes.md"), "a command of mine\n");
  const gatePath = join(sb.g, "hooks", "gate.py");
  write(join(sb.g, "settings.json"), JSON.stringify({ model: "opus", hooks: { PreToolUse: [
    { matcher: "Bash|Task", hooks: [{ type: "command", command: `python3 "${gatePath}"` },
      { type: "command", command: "node ~/my-hook.js" }] },
    { matcher: "Bash", hooks: [{ type: "command", command: "python3 ~/tools/gate.py" }] },
  ] } }, null, 2));

  // Claude Code's project list: one 2.x global-mode repo (pointer, no 3.x gate), one unrelated.
  const p2x = scratch("cohorte-2x-proj-");
  write(join(p2x, ".claude/pipeline.json"), JSON.stringify({ pipeline: "cohorte", mode: "global" }));
  const other = scratch("cohorte-other-");
  write(join(sb.home, ".claude.json"), JSON.stringify({ projects: { [p2x]: {}, [other]: {} } }));
  const r = cli(sb, "update");
  check("exits 0", r.status === 0, r.out);
  check("warns that 2.x projects are ungated until synced, naming the known one",
    /NO gate until you wire them/.test(r.out) && r.out.includes(p2x) && !r.out.includes(other), r.out);
  const s = JSON.parse(read(join(sb.g, "settings.json")));
  const cmds = (s.hooks.PreToolUse || []).flatMap((g) => g.hooks.map((h) => h.command));
  check("the 2.x machine-wide gate registration is gone", !cmds.some((c) => c.includes(gatePath)), JSON.stringify(cmds));
  check("a hook sharing its matcher group survives", cmds.includes("node ~/my-hook.js"));
  check("another tool's gate.py hook survives", cmds.includes("python3 ~/tools/gate.py"));
  check("unrelated settings survive", s.model === "opus");
  // The safety property: every hook still registered points at a file that exists, so no
  // registration can make python exit 2 (= "block") on every Bash call.
  check("no registered hook points at a 2.x path that was moved",
    !cmds.some((c) => /\.claude[\\/]hooks[\\/]gate\.py/.test(c)));
  for (const rel of ["pipeline/VERSION", "hooks/gate.py", "templates/spec.template.md", "workflows/review.js",
    "agents/review.md", "commands/build.md", "commands/cohorte-loop.md"]) {
    check(`2.x ${rel} moved out`, !existsSync(join(sb.g, rel)));
  }
  const backup = walk(join(sb.g, "cohorte/legacy-backup"));
  check("…into cohorte/legacy-backup", backup.some((f) => f.endsWith("hooks/gate.py") || f.endsWith("hooks\\gate.py")), backup.length);
  check("a 2.x cohorte-build.md is refreshed without a needless backup",
    !read(join(sb.g, "commands/cohorte-build.md")).includes("old body") && !existsSync(join(sb.g, "cohorte/backup")));
  check("your own command survives", read(join(sb.g, "commands/notes.md")) === "a command of mine\n");
  check("a 2.x surface agent is left in place (live projects use it)…", existsSync(join(sb.g, "agents/frontend.md")));
  check("…and reported", /frontend\.md/.test(r.out) && /cohorte-update-pipeline/.test(r.out), r.out);
  check("the new core is in place", read(join(sb.g, "cohorte/pipeline/VERSION")).trim() === pkg.version);
}

// ── F. files retired between versions ─────────────────────────────────────────
console.log("update — retires files the previous version installed");
{
  const sb = sandbox();
  cli(sb, "install");
  const mpath = join(sb.g, "cohorte/manifest.json");
  const m = JSON.parse(read(mpath));
  const sha = (s) => createHash("sha256").update(s).digest("hex");
  write(join(sb.g, "cohorte/pipeline/scripts/retired.sh"), "old\n");
  write(join(sb.g, "commands/cohorte-retired.md"), "old\n");
  m.files["cohorte/pipeline/scripts/retired.sh"] = sha("old\n");
  m.files["commands/cohorte-retired.md"] = sha("something else\n"); // = modified since install
  writeFileSync(mpath, JSON.stringify(m));
  const r = cli(sb, "update");
  check("an unmodified retired file is removed", !existsSync(join(sb.g, "cohorte/pipeline/scripts/retired.sh")), r.out);
  check("a modified retired file is kept", existsSync(join(sb.g, "commands/cohorte-retired.md")));
  check("…and reported", /kept commands\/cohorte-retired\.md/.test(r.out), r.out);
}

// ── G. uninstall ──────────────────────────────────────────────────────────────
console.log("uninstall — removes exactly what install wrote");
{
  const sb = sandbox();
  write(join(sb.g, "commands/notes.md"), "mine\n");
  write(join(sb.g, "settings.json"), '{"model":"opus"}\n');
  cli(sb, "install");
  const edited = join(sb.g, "commands/cohorte-spec.md");
  writeFileSync(edited, read(edited) + "\nmine\n");
  const r = cli(sb, "uninstall");
  check("exits 0", r.status === 0, r.out);
  const left = walk(sb.g).map((f) => relative(sb.g, f).split("\\").join("/")).sort();
  check("only your files, your config and your edited copy remain",
    JSON.stringify(left) === JSON.stringify(["cohorte.config.yaml", "commands/cohorte-spec.md", "commands/notes.md", "settings.json"]),
    left.join(", "));
  check("…and the edited copy is reported", /kept commands\/cohorte-spec\.md/.test(r.out), r.out);
  const p = cli(sb, "uninstall", "--purge");
  check("--purge also removes the config", p.status === 0 && !existsSync(join(sb.g, "cohorte.config.yaml")));
}

// ── H. sync — one project ─────────────────────────────────────────────────────
console.log("sync — wires one project");
{
  const sb = sandbox();
  cli(sb, "install");
  const { d, git } = gitRepo();
  write(join(d, ".claude/settings.json"), JSON.stringify({ permissions: { allow: ["Bash(npm test:*)"] },
    hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "node my-lint.js" }] }] } }, null, 2));
  const r = cli(sb, "sync", d);
  check("exits 0", r.status === 0, r.out);
  check("the gate is copied into the repo",
    read(join(d, ".claude/hooks/cohorte-gate.py")) === read(join(root, "core/hooks/gate.py")));
  const s = JSON.parse(read(join(d, ".claude/settings.json")));
  const groups = s.hooks.PreToolUse;
  const gateGroups = groups.filter((g) => g.hooks.some((h) => h.command.includes("cohorte-gate.py")));
  check("registered for Bash|Task|Agent and Write|Edit|MultiEdit|NotebookEdit",
    JSON.stringify(gateGroups.map((g) => g.matcher)) === JSON.stringify(["Bash|Task|Agent", "Write|Edit|MultiEdit|NotebookEdit"]));
  check("project-relative, fail-closed command",
    gateGroups.every((g) => g.hooks[0].command === 'python3 "$CLAUDE_PROJECT_DIR/.claude/hooks/cohorte-gate.py"'
      && g.hooks[0].onFailure === "block"));
  check("your hook and permissions are kept",
    groups.some((g) => g.hooks.some((h) => h.command === "node my-lint.js")) && s.permissions.allow.includes("Bash(npm test:*)"));
  const ptr = JSON.parse(read(join(d, ".claude/pipeline.json")));
  check("pointer names the core version, no mode", ptr.core_version === pkg.version && !("mode" in ptr));
  const ignore = read(join(d, ".gitignore"));
  check(".gitignore covers the local artifacts",
    [".claude/preflight.ok", ".claude/pipeline-metrics.jsonl", "specs/reports/"].every((l) => ignore.includes(l)));
  check("specs/_template.md is seeded", existsSync(join(d, "specs/_template.md")));
  check("no PIPELINE.md ⇒ no .claude/profile.json, and sync says so",
    !existsSync(join(d, ".claude/profile.json")) && /profile\.json not written/.test(r.out), r.out);
  const again = cli(sb, "sync", d);
  check("a second sync changes nothing", /already in sync/.test(again.out), again.out);

  // The copied gate actually runs: an ordinary command in a project with no gate config.
  const py = WIN ? "py" : "python3";
  const g = spawnSync(py, [join(d, ".claude/hooks/cohorte-gate.py")], {
    input: JSON.stringify({ tool_name: "Bash", tool_input: { command: "ls" }, cwd: d, hook_event_name: "PreToolUse" }),
    env: { ...process.env, CLAUDE_PROJECT_DIR: d }, encoding: "utf8",
  });
  check("the committed gate runs and lets `ls` through", g.status === 0 && !/deny/.test(g.stdout || ""), (g.stderr || "") + (g.stdout || ""));

  // What Claude Code actually runs is the STRING in settings.json, through a shell, with
  // CLAUDE_PROJECT_DIR set and the payload on stdin — from whatever cwd the session is in.
  // With onFailure: block, a crash on any payload shape would block every call of that kind.
  if (!WIN) {
    const spaced = join(scratch("cohorte-sp-"), "with space", "proj");
    mkdirSync(spaced, { recursive: true });
    spawnSync("git", ["-C", spaced, "init", "-q", "-b", "main"]);
    cli(sb, "sync", spaced);
    write(join(spaced, ".claude/gate-config.json"), JSON.stringify({ deny: ["git push --force"] }));
    const reg = Object.fromEntries(JSON.parse(read(join(spaced, ".claude/settings.json"))).hooks.PreToolUse
      .map((g) => [g.matcher, g.hooks[0].command]));
    const hook = (matcher, tool_name, tool_input) => {
      const r = spawnSync("sh", ["-c", reg[matcher]], {
        input: JSON.stringify({ tool_name, tool_input, cwd: tmpdir(), hook_event_name: "PreToolUse", permission_mode: "default" }),
        env: { ...process.env, CLAUDE_PROJECT_DIR: spaced }, cwd: tmpdir(), encoding: "utf8",
      });
      const out = (r.stdout || "").trim();
      return { status: r.status, decision: out ? JSON.parse(out).hookSpecificOutput.permissionDecision : "allow", err: r.stderr };
    };
    const cases = [
      ["Bash|Task|Agent", "Bash", { command: "ls" }, "allow"],
      ["Bash|Task|Agent", "Bash", { command: "git push --force" }, "deny"],
      ["Bash|Task|Agent", "Agent", { subagent_type: "backend", prompt: "x" }, "allow"],
      ["Write|Edit|MultiEdit|NotebookEdit", "Write", { file_path: join(spaced, "src/a.ts"), content: "x" }, "allow"],
      ["Write|Edit|MultiEdit|NotebookEdit", "MultiEdit", { file_path: join(spaced, "src/a.ts"), edits: [{ old_string: "a", new_string: "b" }] }, "allow"],
      ["Write|Edit|MultiEdit|NotebookEdit", "Edit", { file_path: join(spaced, ".claude/gate-config.json"), old_string: "a", new_string: "b" }, "ask"],
    ];
    for (const [m, tool, input, want] of cases) {
      const r = hook(m, tool, input);
      check(`registered command, path with a space, foreign cwd: ${tool} ${want}`,
        r.status === 0 && r.decision === want, `rc=${r.status} ${r.decision} ${r.err}`);
    }
  }

  // Broken settings: abort, untouched.
  const broken = '{"hooks": {,}}';
  writeFileSync(join(d, ".claude/settings.json"), broken);
  const b = cli(sb, "sync", d);
  check("an invalid project settings.json aborts the sync", b.status === 1 && /not valid JSON/.test(b.out), b.out);
  check("…and is left byte-identical", read(join(d, ".claude/settings.json")) === broken);
  git("status");
}

// ── H1. sync — .claude/profile.json, through the INSTALLED project.js ─────────
// `<sync>` in every prompt is `node <core>/lib/project.js sync .` — the copy the installer wrote,
// not the source tree — so this block runs exactly that file.
console.log("sync — writes .claude/profile.json (the installed <sync>)");
{
  const sb = sandbox();
  cli(sb, "install");
  const { d, git } = gitRepo();
  const installedSync = (...a) => {
    const r = spawnSync(process.execPath, [join(sb.g, "cohorte/lib/project.js"), "sync", d, ...a], {
      encoding: "utf8", env: { ...process.env, HOME: sb.home, USERPROFILE: sb.home, CLAUDE_CONFIG_DIR: sb.g },
    });
    return { status: r.status, out: (r.stdout || "") + (r.stderr || "") };
  };
  const md = (surfaces) => "# Profile\n\n```yaml pipeline-profile\nname: demo\nvcs:\n  default_branch: main\n"
    + "surfaces:\n" + surfaces.map((k) => `  - key: ${k}\n    path: apps/${k}\n    agent: ${k}\n    tools: [Read, Edit]\n`).join("")
    + "gate:\n  deny: [\"rm -rf /\"]  # never\n```\n\n## Conventions\n\nprose\n";
  write(join(d, "PIPELINE.md"), md(["web"]));
  let r = installedSync();
  const pj = join(d, ".claude/profile.json");
  check("installed project.js exits 0", r.status === 0, r.out);
  check("writes .claude/profile.json = the parsed machine block",
    existsSync(pj) && JSON.stringify(JSON.parse(read(pj))) === JSON.stringify(parseProfileBlock(read(join(d, "PIPELINE.md")))), r.out);
  check("…byte-identical to the shared serializer doctor compares with", read(pj) === profileJsonText(read(join(d, "PIPELINE.md"))));
  check("…and asks for it to be committed", /Commit .*\.claude\/profile\.json/.test(r.out), r.out);
  check("profile.json is not gitignored (it is committed)", (() => {
    const c = spawnSync("git", ["-C", d, "check-ignore", "-q", ".claude/profile.json"]);
    return c.status === 1;
  })());
  check("a second sync is a no-op", /already in sync/.test(installedSync().out));
  const pjCheck = () => {
    const out = cli(sb, "doctor", d, "--json").out;
    try { return JSON.parse(out).checks.find((c) => c.id === "profile-json") || {}; } catch { return { detail: out }; }
  };
  let pc = pjCheck();
  check("doctor: fresh but uncommitted ⇒ warn naming the commit", pc.status === "warn" && /not committed/.test(pc.detail), JSON.stringify(pc));
  git("add", ".claude/profile.json"); git("commit", "-q", "-m", "profile");
  pc = pjCheck();
  check("doctor: committed and matching ⇒ ok", pc.status === "ok", JSON.stringify(pc));

  writeFileSync(join(d, "PIPELINE.md"), read(join(d, "PIPELINE.md")).replace("prose", "more prose"));
  check("a prose-only edit changes nothing", /already in sync/.test(installedSync().out));

  writeFileSync(join(d, "PIPELINE.md"), md(["web", "api"]));
  pc = pjCheck();
  check("doctor: machine block edited, not re-synced ⇒ warn, fix is cohorte sync",
    pc.status === "warn" && /sync/.test(pc.fix || ""), JSON.stringify(pc));
  r = installedSync();
  check("a machine-block edit regenerates it (a new surface reaches the agents)",
    /updated \.claude\/profile\.json/.test(r.out) && JSON.parse(read(pj)).surfaces.map((s) => s.key).join() === "web,api", r.out);

  const good = read(pj);
  writeFileSync(join(d, "PIPELINE.md"), "# no block any more\n");
  r = installedSync();
  check("an unparseable PIPELINE.md writes nothing, says so, keeps the old file",
    r.status === 0 && /no parseable/.test(r.out) && /may be stale/.test(r.out) && read(pj) === good, r.out);

  // The lazy require: a core missing yaml.js still wires the gate.
  rmSync(join(sb.g, "cohorte/lib/yaml.js"));
  writeFileSync(join(d, "PIPELINE.md"), md(["web"]));
  r = installedSync();
  check("yaml.js missing ⇒ the gate is still wired, profile.json skipped with a reason",
    r.status === 0 && /yaml\.js missing/.test(r.out) && existsSync(join(d, ".claude/hooks/cohorte-gate.py")), r.out);

  const u = cli(sb, "uninstall", "--project", d);
  check("uninstall --project removes .claude/profile.json", u.status === 0 && !existsSync(pj), u.out);
  git("status");
}

// ── H1b. sync — exec-form registration (gate.hook_form: exec, for Windows teams) ──
console.log("sync — exec-form hook registration");
{
  const sb = sandbox();
  cli(sb, "install");
  const { d } = gitRepo();
  write(join(d, "PIPELINE.md"), "```yaml pipeline-profile\nname: x\ngate:\n  hook_form: exec\n```\n");
  check("sync exits 0", cli(sb, "sync", d).status === 0);
  const groups = () => JSON.parse(read(join(d, ".claude/settings.json"))).hooks.PreToolUse
    .filter((g) => g.hooks.some((h) => (h.args || []).join(" ").includes("cohorte-gate.py") || String(h.command).includes("cohorte-gate.py")));
  const h = groups()[0].hooks[0];
  check("exec form: python3 + args with ${CLAUDE_PROJECT_DIR}, fail-closed",
    h.command === "python3" && h.args[0] === "${CLAUDE_PROJECT_DIR}/.claude/hooks/cohorte-gate.py" && h.onFailure === "block", JSON.stringify(h));
  cli(sb, "sync", d);
  check("a second sync keeps exactly two groups (no duplicate)", groups().length === 2, groups().length);
  write(join(d, "PIPELINE.md"), "```yaml pipeline-profile\nname: x\n```\n");
  cli(sb, "sync", d);
  check("back to the default ⇒ the exec entries are replaced by shell ones, not added to",
    groups().length === 2 && groups().every((g) => !g.hooks[0].args), JSON.stringify(groups()));
  write(join(d, "PIPELINE.md"), "```yaml pipeline-profile\nname: x\ngate:\n  hook_form: exec\n```\n");
  cli(sb, "sync", d);
  const doc = cli(sb, "doctor", d);
  const gateLine = (doc.out.split("\n").find((l) => /Gate hook/.test(l)) || "");
  check("doctor recognizes the exec-form registration (only 'not committed' left in a fresh repo)",
    /Gate hook/.test(gateLine) && !/not registered|does not cover|2\.x/.test(gateLine), gateLine);
  // As Claude Code runs it: substitute the placeholder, no shell.
  const e = groups()[0].hooks[0];
  const r = spawnSync(e.command === "python3" && WIN ? "py" : e.command, e.args.map((a) => a.replace("${CLAUDE_PROJECT_DIR}", d)), {
    input: JSON.stringify({ tool_name: "Bash", tool_input: { command: "ls" }, cwd: d, hook_event_name: "PreToolUse" }),
    env: { ...process.env, CLAUDE_PROJECT_DIR: d }, encoding: "utf8" });
  check("the exec-form command runs the committed gate", r.status === 0, r.stderr);
}

console.log("doctor — folder trust (project allow rules are ignored under claude -p until trusted)");
{
  const sb = sandbox();
  cli(sb, "install");
  const { d } = gitRepo();
  write(join(d, "PIPELINE.md"), "```yaml pipeline-profile\nname: x\n```\n");
  cli(sb, "sync", d);
  const trust = () => JSON.parse(cli(sb, "doctor", d, "--json").out).checks.find((c) => c.id === "trust");
  check("no user store ⇒ skip", trust().status === "skip", JSON.stringify(trust()));
  const store = join(sb.g, ".claude.json");
  write(store, JSON.stringify({ projects: { [d]: { hasTrustDialogAccepted: false } } }));
  const untrusted = trust();
  check("untrusted ⇒ warn, naming -p and the fix", untrusted.status === "warn" && /claude -p/.test(untrusted.detail) && /trust dialog/.test(untrusted.fix || ""), JSON.stringify(untrusted));
  write(store, JSON.stringify({ projects: { [dirname(d)]: { hasTrustDialogAccepted: true } } }));
  const parent = trust();
  check("a trusted parent folder counts", parent.status === "ok" && /through/.test(parent.detail), JSON.stringify(parent));
}

// ── H2. sync — a 2.x bundled repo ─────────────────────────────────────────────
console.log("sync — migrates a 2.x bundled repo");
{
  const sb = sandbox();
  cli(sb, "install");
  const { d, git } = gitRepo();
  const marker = "> **Runtime: Claude Code.** Generated by the cohorte adapter — do not edit this file;\n";
  write(join(d, ".claude/pipeline/VERSION"), "2.10.2\n");
  write(join(d, ".claude/pipeline/SCHEMA.md"), "schema\n");
  write(join(d, ".claude/hooks/gate.py"), "# gate\n");
  write(join(d, ".claude/commands/cohorte-build.md"), `---\n---\n${marker}`);
  write(join(d, ".claude/agents/review.md"), `---\nname: review\n---\n${marker}`);
  write(join(d, ".claude/agents/backend.md"), `---\nname: backend\n---\n${marker}surface agent`);
  write(join(d, ".claude/templates/spec.template.md"), "2.x\n");
  write(join(d, ".claude/settings.json"), JSON.stringify({
    permissions: { allow: ["Bash(.claude/pipeline/scripts/:*)", "Bash(~/.claude/pipeline/scripts/:*)", "Bash(git status:*)"] },
    hooks: { PreToolUse: [{ matcher: "Bash|Task", hooks: [{ type: "command", command: "python3 .claude/hooks/gate.py" }] }] },
  }));
  write(join(d, ".claude/pipeline.json"), JSON.stringify({ pipeline: "cohorte", mode: "bundled", core_version: "2.10.2" }));
  git("add", "-A"); git("commit", "-q", "-m", "2.x");
  write(join(d, ".claude/pipeline/local-only.md"), "untracked\n");
  const r = cli(sb, "sync", d);
  check("exits 0", r.status === 0, r.out);
  for (const rel of [".claude/pipeline", ".claude/hooks/gate.py", ".claude/commands", ".claude/agents/review.md", ".claude/templates"]) {
    check(`2.x ${rel} is gone from the repo`, !existsSync(join(d, rel)));
  }
  check("the surface agent stays", existsSync(join(d, ".claude/agents/backend.md")));
  check("an untracked 2.x file is moved to a backup, not deleted",
    walk(join(d, ".claude/cohorte-legacy-backup")).some((f) => f.endsWith("local-only.md")));
  const s = JSON.parse(read(join(d, ".claude/settings.json")));
  const cmds = s.hooks.PreToolUse.flatMap((g) => g.hooks.map((h) => h.command));
  check("the 2.x registration is replaced, not duplicated", cmds.length === 2 && cmds.every((c) => c.includes("cohorte-gate.py")), JSON.stringify(cmds));
  const allow = s.permissions.allow;
  check("pipeline-script permissions follow the new core (old paths gone, no duplicates)",
    allow.includes("Bash(~/.claude/cohorte/pipeline/scripts/:*)") && !allow.some((r) => /\.claude\/pipeline\/scripts/.test(r))
      && new Set(allow).size === allow.length, JSON.stringify(allow));
  check("sync writes the pipeline's own allow rules (no command has to Edit settings.json for them)",
    ["Bash(git switch:*)", "Bash(date:*)", "Bash(git rev-parse:*)"].every((r) => allow.includes(r)), JSON.stringify(allow));
  check("the pointer loses its 2.x mode", !("mode" in JSON.parse(read(join(d, ".claude/pipeline.json")))));

  // ── I. uninstall --project ──
  const u = cli(sb, "uninstall", "--project", d);
  check("uninstall --project exits 0", u.status === 0, u.out);
  const s2 = JSON.parse(read(join(d, ".claude/settings.json")));
  check("removes the gate, its registration and the pointer",
    !existsSync(join(d, ".claude/hooks/cohorte-gate.py")) && !existsSync(join(d, ".claude/pipeline.json")) && !s2.hooks);
  check("keeps the project's own files", existsSync(join(d, ".claude/agents/backend.md")) && /backend|\.claude\/agents/.test(u.out), u.out);
}

// ── J. CLI contract ───────────────────────────────────────────────────────────
console.log("cli — 3.x flags");
{
  const sb = sandbox();
  check("`install <path>` is refused with the sync hint", (() => { const r = cli(sb, "install", "."); return r.status === 2 && /cohorte sync/.test(r.out); })());
  check("--runtime=codex is refused (Claude Code only)", (() => { const r = cli(sb, "install", "--runtime=codex"); return r.status === 2 && /Claude Code only/.test(r.out); })());
  check("--global and --runtime=claude are accepted (2.x muscle memory)", cli(sb, "install", "--global", "--runtime=claude").status === 0);
  check("version prints the package version", cli(sb, "version").out.trim() === pkg.version);
}

for (const d of tmps) { try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
console.log("");
if (failures) { console.error(`test-install: ${failures} failure(s)`); process.exit(1); }
console.log("test-install: OK");
