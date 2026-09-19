#!/usr/bin/env node
// Behavioural tests for core/workflows/*.js.
//
// The workflow runtime hands a script an async function body with agent() /
// parallel() / pipeline() / phase() / log() / args / budget injected. Nothing in
// a script touches the filesystem, so the whole orchestration is testable by
// injecting stub agents and asserting the returned verdict object.
//
// This exists because of one specific failure mode: agent() resolves to `null`
// when a subagent dies, and a dead reviewer produces zero findings — which is
// byte-identical to a clean surface. review.js scored that as SHIP over code no
// reviewer had read. A unit test is the only thing that catches it: the
// structural checks in validate-core.mjs cannot see verdict logic.
//
//   node scripts/test-workflows.mjs

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

let failures = 0;
const check = (name, cond, detail = "") => {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
};

const PROFILE = {
  name: "testproj",
  vcs: { default_branch: "main" },
  contract: { enabled: false, path: "packages/shared/src", ext: "ts", mechanism: "none" },
  commands: { typecheck: "tsc --noEmit", lint_quiet: "lint -q", test_quiet: "test --dot" },
  surfaces: [
    { key: "backend", path: "apps/api", agent: "backend", uses_design: false },
    { key: "frontend", path: "apps/web", agent: "frontend", uses_design: true },
  ],
};

const TOUCHED = [
  { key: "backend", diff: "specs/reports/f.backend.diff", files: ["apps/api/a.ts"] },
  { key: "frontend", diff: "specs/reports/f.frontend.diff", files: ["apps/web/b.tsx"] },
];

const finding = (over = {}) => ({
  severity: "HIGH", file: "apps/api/a.ts", line: 3, kind: "quality",
  problem: "p", fix: "f", ...over,
});

// Run one workflow script with a `reply(prompt, opts) => value` stub in place of
// every agent call, and an optional `wf(name, args)` stub in place of nested
// workflow() calls (loop.js runs the review workflow as a child). Returns
// { result, calls, prompts } — prompts keyed by label, for byte-identity asserts.
async function run(script, reply, args = { feature: "feat-x" }, wf, budgetStub) {
  const text = readFileSync(join(root, "core/workflows", script), "utf8")
    .replace(/^export const meta/m, "const meta");
  const calls = [];
  const prompts = {};
  const agent = async (prompt, opts = {}) => {
    calls.push(opts.label || "(unlabelled)");
    prompts[opts.label || "(unlabelled)"] = prompt;
    return reply(prompt, opts, calls);
  };
  // Mirrors the runtime's contract: a thunk that throws resolves to null, the
  // call itself never rejects.
  const parallel = thunks =>
    Promise.all(thunks.map(t => Promise.resolve().then(t).catch(() => null)));
  // Each item runs through every stage independently; a throwing stage drops
  // that item to null and skips its remaining stages.
  const pipeline = (items, ...stages) =>
    Promise.all(items.map(async (item, i) => {
      let v = item;
      for (const s of stages) {
        try { v = await s(v, item, i); } catch { return null; }
      }
      return v;
    }));
  const fn = new AsyncFunction(
    "agent", "parallel", "pipeline", "phase", "log", "args", "budget", "workflow", text);
  const result = await fn(
    agent, parallel, pipeline, () => {}, () => {}, args,
    budgetStub || { total: null, spent: () => 0, remaining: () => Infinity },
    wf || (async () => {}));
  return { result, calls, prompts };
}

// A budget stub whose spent() grows with every agent/workflow call — what the runtime's
// counter does — so token deltas in the scripts come out non-zero and orderable.
const tickingBudget = () => {
  let n = 0;
  return { total: null, spent: () => (n += 1000), remaining: () => Infinity };
};

// A reply table keyed by label prefix; the first matching prefix wins.
const replier = table => (prompt, opts) => {
  const label = opts.label || "";
  for (const [prefix, value] of table) {
    if (label === prefix || label.startsWith(prefix)) {
      return typeof value === "function" ? value(label) : value;
    }
  }
  return "ok";
};

const BASE_REVIEW = [
  ["profile", PROFILE],
  ["preflight", { pass: true }],
  ["stage-diff", { surfaces: TOUCHED }],
  ["stage-report", "done"],
];

console.log("review.js");
{
  const { result } = await run("review.js", replier([
    ["review:", { verdict: "SHIP", findings: [] }], ...BASE_REVIEW,
  ]));
  check("clean run ⇒ SHIP", result.verdict === "SHIP", `got ${result.verdict}`);
  check("clean run ⇒ no unreviewed surfaces", (result.unreviewedSurfaces || []).length === 0);
  check("clean run ⇒ next is /cohorte-ship", String(result.next).startsWith("/cohorte-ship"), result.next);
}
{
  // THE regression: every reviewer dies ⇒ zero findings ⇒ must NOT read as SHIP.
  const { result } = await run("review.js", replier([
    ["review:", null], ...BASE_REVIEW,
  ]));
  check("all reviewers dead ⇒ not SHIP", result.verdict !== "SHIP", `got ${result.verdict}`);
  check("all reviewers dead ⇒ both surfaces reported unreviewed",
    (result.unreviewedSurfaces || []).join(",") === "backend,frontend",
    JSON.stringify(result.unreviewedSurfaces));
  check("all reviewers dead ⇒ next says re-run",
    /re-run the review/.test(result.next), result.next);
}
{
  // One dead reviewer must not be masked by the other surface coming back clean.
  const { result } = await run("review.js", replier([
    ["review:backend", null],
    ["review:", { verdict: "SHIP", findings: [] }],
    ...BASE_REVIEW,
  ]));
  check("one reviewer dead ⇒ not SHIP", result.verdict !== "SHIP", `got ${result.verdict}`);
  check("one reviewer dead ⇒ names only that surface",
    (result.unreviewedSurfaces || []).join(",") === "backend", JSON.stringify(result.unreviewedSurfaces));
}
{
  // A SHIP carrying HIGH findings is a real verdict, but it is not "go ship it":
  // the conversational /cohorte-review routes any surviving HIGH to /cohorte-fix.
  const { result } = await run("review.js", replier([
    ["review:", { verdict: "SHIP", findings: [finding()] }], ...BASE_REVIEW,
  ]));
  check("SHIP + HIGH findings ⇒ verdict still SHIP", result.verdict === "SHIP");
  check("SHIP + HIGH findings ⇒ next routes to /cohorte-fix, not /cohorte-ship",
    String(result.next).startsWith("/cohorte-fix"), result.next);
}
{
  const { result } = await run("review.js", replier([
    ["review:", { verdict: "SHIP", findings: [finding({ severity: "LOW" })] }], ...BASE_REVIEW,
  ]));
  check("SHIP + only LOW ⇒ next is /cohorte-ship", String(result.next).startsWith("/cohorte-ship"), result.next);
}
{
  // Deferred findings are real but out of the feature's scope: they must be
  // counted and routed to the backlog, yet move NEITHER the verdict nor `clean`.
  // Both halves matter — a deferred item that blocks costs a fix loop it was
  // deferred out of, and one that is dropped is the leak the section exists to close.
  const deferred = [{
    severity: "HIGH", file: "apps/api/legacy.ts", line: 9, kind: "quality",
    problem: "p", fix: "f", outOfScope: "predates this feature; diff never touched it",
  }];
  let stagePrompt = "";
  const { result, calls } = await run("review.js", (prompt, opts) => {
    const label = opts.label || "";
    if (label.startsWith("review:")) return { verdict: "SHIP", findings: [], deferred };
    if (label === "stage-report") { stagePrompt = prompt; return "done"; }
    return replier(BASE_REVIEW)(prompt, opts);
  });
  check("deferred-only ⇒ verdict still SHIP", result.verdict === "SHIP", `got ${result.verdict}`);
  check("deferred-only ⇒ next is /cohorte-ship (not a fix loop)",
    String(result.next).startsWith("/cohorte-ship"), result.next);
  check("deferred are counted (both surfaces)", result.deferred === 2, `got ${result.deferred}`);
  check("deferred stay out of the severity counts",
    Object.values(result.counts).every(n => n === 0), JSON.stringify(result.counts));
  check("deferred are routed to the refactor backlog",
    /refactor-backlog\.md/.test(stagePrompt) && /deferred:feat-x/.test(stagePrompt),
    stagePrompt.slice(0, 200));
  check("deferred are never cross-checked (no verify agent spawned)",
    !calls.some(c => c.startsWith("verify:")) && result.refutedByCrossCheck === 0,
    calls.join(","));
}
{
  const { result } = await run("review.js", replier([
    ["preflight", { pass: false, tail: "boom" }], ...BASE_REVIEW,
  ]));
  check("red preflight ⇒ ABORTED", result.verdict === "ABORTED", `got ${result.verdict}`);
}
{
  const { calls } = await run("review.js", replier([
    ["preflight", { pass: false, tail: "boom" }], ...BASE_REVIEW,
  ]));
  check("red preflight ⇒ zero reviewers spawned",
    !calls.some(c => c.startsWith("review:")), calls.join(","));
}

// ── args normalisation ───────────────────────────────────────────────────────
// The runtime passes `args` through verbatim, so a caller that JSON-encodes it
// hands the script a string. That string used to become the feature id itself —
// which is how a report was written to `specs/reports/{"feature": "x"}.md`.
console.log("args");
{
  const { result } = await run("review.js", replier([
    ["review:", { verdict: "SHIP", findings: [] }], ...BASE_REVIEW,
  ]), JSON.stringify({ feature: "feat-x" }));
  check("review: a JSON-encoded args string is parsed, not used as the id",
    result.verdict === "SHIP", `got ${result.verdict}`);
}
{
  let threw = "";
  try {
    await run("review.js", replier([...BASE_REVIEW]), { feature: '{"feature": "feat-x"}' });
  } catch (e) { threw = e.message; }
  check("review: a non-slug feature id throws before anything is written",
    /not a slug/.test(threw), threw || "(did not throw)");
}
{
  let threw = "";
  try {
    await run("review.js", replier([...BASE_REVIEW]), { feature: "../../etc/passwd" });
  } catch (e) { threw = e.message; }
  check("review: a path-shaped feature id is rejected",
    /not a slug/.test(threw), threw || "(did not throw)");
}

// ── Phase 0 profile handling ─────────────────────────────────────────────────
// A haiku profile-reader intermittently returns the profile as a JSON *string*
// under a wrapper field instead of at the top level. The old schema accepted that
// wrapper, so `surfaces` read as undefined ⇒ [] ⇒ parallel([]) ⇒ zero agents
// dispatched — and because every later guard compares against `surfaces`, an
// empty list made them all vacuously pass: a run reported a verdict having done
// nothing, indistinguishable from a clean run with an empty diff. Two properties
// are pinned per workflow: a wrapped return is recovered, an empty one aborts.
console.log("profile phase");
const WRAPPED = { output: JSON.stringify(PROFILE) };
const EMPTY_PROFILE = { ...PROFILE, surfaces: [] };
{
  const { result } = await run("review.js", replier([
    ["profile", WRAPPED],
    ["review:", { verdict: "SHIP", findings: [] }], ...BASE_REVIEW,
  ]));
  check("review: a string-wrapped profile is unwrapped, not silently empty",
    result.verdict === "SHIP", `got ${result.verdict}`);
}
{
  const { result, calls } = await run("review.js", replier([["profile", EMPTY_PROFILE], ...BASE_REVIEW]));
  check("review: no surfaces ⇒ ABORTED, not a verdict",
    result.verdict === "ABORTED", `got ${result.verdict}`);
  check("review: no surfaces ⇒ zero reviewers spawned",
    !calls.some(c => c.startsWith("review:")), calls.join(","));
}
{
  const { result } = await run("audit.js", replier([
    ["profile", EMPTY_PROFILE], ["gates", { failures: [] }], ["write-backlog", "done"],
  ]), {});
  check("audit: no surfaces ⇒ error, not an empty backlog",
    /no surfaces/.test(result.error || ""), JSON.stringify(result));
}
{
  const { result } = await run("refactor.js", replier([
    ["profile", EMPTY_PROFILE], ["read-backlog", { domains: [] }],
  ]), { domains: "all" });
  check("refactor: no surfaces ⇒ error, not a no-op success",
    /no surfaces/.test(result.error || ""), JSON.stringify(result));
}

// ── the dead-agent family, swept across every terminal/staging agent ─────────
// `agent()` returns null when a subagent dies. Any call whose result is turned
// into a CLAIM (a verdict, a path, "it is on disk") must distinguish "died" from
// "succeeded with nothing to say". This block is the sweep.
console.log("dead-agent sweep");
{
  const { result } = await run("review.js", replier([
    ["stage-diff", null], ...BASE_REVIEW,
  ]));
  check("review: dead diff-stager ⇒ ABORTED, not 'SHIP — nothing to review'",
    result.verdict === "ABORTED", `got ${result.verdict}: ${result.reason}`);
}
{
  const { result } = await run("review.js", replier([
    ["stage-report", null],
    ["review:", { verdict: "SHIP", findings: [] }], ...BASE_REVIEW,
  ]));
  check("review: dead report-stager ⇒ reportStaged false", result.reportStaged === false);
  check("review: dead report-stager ⇒ report path not claimed",
    !/^specs\//.test(String(result.report)), result.report);
  check("review: dead report-stager ⇒ next says nothing was written",
    /NEVER written/.test(result.next), result.next);
}
{
  const { result } = await run("audit.js", replier([
    ["profile", PROFILE], ["gates", { failures: [] }],
    ["audit:backend", null],
    ["audit:", { items: [] }], ["write-backlog", "done"],
  ]), {});
  check("audit: dead auditor ⇒ the domain is listed as NOT audited",
    (result.notAudited || []).join(",") === "backend", JSON.stringify(result.notAudited));
  check("audit: dead auditor ⇒ next tells you to re-audit it",
    /re-audit backend/.test(result.next), result.next);
}
{
  const { result } = await run("audit.js", replier([
    ["profile", PROFILE], ["gates", { failures: [] }],
    ["audit:", { items: [] }], ["write-backlog", null],
  ]), {});
  check("audit: dead backlog writer ⇒ path not claimed",
    !/^specs\//.test(String(result.backlog)), result.backlog);
}
{
  const { result } = await run("refactor.js", replier([
    ["profile", PROFILE], ["read-backlog", null],
  ]), { domains: "all" });
  check("refactor: dead backlog reader ⇒ says it died, not 'no open items'",
    /agent died/.test(String(result.error)), result.error);
}
{
  const items = ["- [ ] a", "- [ ] b", "- [ ] c", "- [ ] d", "- [ ] e"];
  const { result } = await run("refactor.js", replier([
    ["profile", PROFILE],
    ["read-backlog", { domains: [{ key: "backend", items }] }],
    ["verify:", { cleared: items, remaining: [], gatesGreen: true }],
    ["reverify:", { cleared: items, remaining: [], gatesGreen: true }],
    ["tick-backlog", null],
    ["refactor:", "handoff"],
  ]), { domains: "all" });
  check("refactor: dead ticker ⇒ backlogTicked false", result.backlogTicked === false);
  check("refactor: dead ticker ⇒ next warns the backlog still shows them open",
    /NOT ticked/.test(result.next), result.next);
}

// ── audit.js / refactor.js — smoke-level: they must return, not throw ────────
console.log("audit.js / refactor.js");
{
  const { result } = await run("audit.js", replier([
    ["profile", PROFILE],
    ["gates", { failures: [] }],
    ["audit:", { items: [{ severity: "HIGH", file: "apps/api/a.ts", line: 1, kind: "tdd", fix: "add a test" }] }],
    ["write-backlog", "done"],
  ]), {});
  check("audit returns a backlog path", result.backlog === "specs/refactor-backlog.md", JSON.stringify(result));
  check("audit counts every domain (surfaces + shared)",
    Object.keys(result.domains || {}).join(",") === "backend,frontend,shared", JSON.stringify(result.domains));
}
{
  const { result } = await run("refactor.js", replier([
    ["profile", PROFILE],
    ["read-backlog", { domains: [{ key: "backend", items: ["- [ ] a", "- [ ] b"] }] }],
  ]), { domains: "all" });
  check("refactor skips a domain below the item threshold",
    result.skipped && result.skipped.backend === 2, JSON.stringify(result));
}

// ── review.js — the machine verdict contract the loop reduces on ─────────────
console.log("review.js verdict contract");
{
  const { result } = await run("review.js", replier([
    ["preflight", { pass: false, tail: "boom" }], ...BASE_REVIEW,
  ]));
  check("red preflight ⇒ aborted: 'preflight' (what a driver branches on)",
    result.aborted === "preflight", JSON.stringify(result.aborted));
}
{
  // The empty-diff SHIP certified nothing (no review, no stamp) — its `next` must not
  // read as "run /cohorte-ship", which would point a driver at a gate that refuses.
  const { result } = await run("review.js", replier([
    ["stage-diff", { surfaces: [] }], ...BASE_REVIEW,
  ]));
  check("empty-diff SHIP ⇒ next warns nothing was reviewed, never '/cohorte-ship'",
    result.verdict === "SHIP" && !String(result.next).startsWith("/cohorte-ship") && /no review|nothing to ship/i.test(result.next),
    result.next);
}
{
  // blocking = CRITICAL + security counted once; blocking_items = identity, not wording:
  // surface | file WITHOUT :line | first 8 words of the problem, lowercased, collapsed.
  const crit = finding({ severity: "CRITICAL", file: "apps/api/a.ts:41",
    problem: "Missing auth-check on POST /orders endpoint here now" });
  let stagePrompt = "";
  const { result } = await run("review.js", (prompt, opts) => {
    const label = opts.label || "";
    if (label.startsWith("verify:")) return { refuted: false, reason: "holds" };
    if (label.startsWith("review:backend")) return { verdict: "REVISE", findings: [crit] };
    if (label.startsWith("review:")) return { verdict: "SHIP", findings: [] };
    if (label === "stage-report") { stagePrompt = prompt; return "done"; }
    return replier(BASE_REVIEW)(prompt, opts);
  });
  check("blocking counts CRITICAL+security, each once", result.blocking === 1, `got ${result.blocking}`);
  check("blockingItems: surface|file-no-line|8-word normalized problem",
    (result.blockingItems || [])[0] === "backend|apps/api/a.ts|missing auth check on post orders endpoint here",
    JSON.stringify(result.blockingItems));
  check("verdict.json is staged, fingerprint computed in Bash (sha256), never by hand",
    /verdict\.json/.test(stagePrompt) && /sha256sum/.test(stagePrompt), stagePrompt.slice(0, 200));
}
{
  // The cross-check exists so a refuted CRITICAL cannot force a fix loop — and so an
  // unrefuted one still does. Both directions, plus security ⇒ BLOCK.
  const crit = finding({ severity: "CRITICAL" });
  const withVerify = refuted => (prompt, opts) => {
    const label = opts.label || "";
    if (label.startsWith("verify:")) return { refuted, reason: refuted ? "a guard covers it" : "holds" };
    if (label.startsWith("review:backend")) return { verdict: "REVISE", findings: [crit] };
    if (label.startsWith("review:")) return { verdict: "SHIP", findings: [] };
    return replier(BASE_REVIEW)(prompt, opts);
  };
  const kept = await run("review.js", withVerify(false));
  check("unrefuted CRITICAL ⇒ REVISE, cross-check ran",
    kept.result.verdict === "REVISE" && kept.calls.some(c => c.startsWith("verify:")),
    JSON.stringify([kept.result.verdict, kept.result.blocking]));
  const refutedRun = await run("review.js", withVerify(true));
  check("refuted CRITICAL ⇒ SHIP, not a fix loop",
    refutedRun.result.verdict === "SHIP" && refutedRun.result.refutedByCrossCheck === 1 && refutedRun.result.blocking === 0,
    JSON.stringify([refutedRun.result.verdict, refutedRun.result.refutedByCrossCheck]));
  const sec = await run("review.js", (prompt, opts) => {
    const label = opts.label || "";
    if (label.startsWith("verify:")) return { refuted: false, reason: "holds" };
    if (label.startsWith("review:backend")) return { verdict: "REVISE", findings: [finding({ severity: "HIGH", kind: "security" })] };
    if (label.startsWith("review:")) return { verdict: "SHIP", findings: [] };
    return replier(BASE_REVIEW)(prompt, opts);
  });
  check("surviving security finding ⇒ BLOCK, counted blocking",
    sec.result.verdict === "BLOCK" && sec.result.blocking === 1,
    JSON.stringify([sec.result.verdict, sec.result.blocking]));
  // A dead cross-check verifier must KEEP the finding (a real CRITICAL must not die
  // on a transport error), never silently drop it.
  const deadVerify = await run("review.js", (prompt, opts) => {
    const label = opts.label || "";
    if (label.startsWith("verify:")) return null;
    if (label.startsWith("review:backend")) return { verdict: "REVISE", findings: [crit] };
    if (label.startsWith("review:")) return { verdict: "SHIP", findings: [] };
    return replier(BASE_REVIEW)(prompt, opts);
  });
  check("dead verifier ⇒ the CRITICAL is kept, verdict REVISE",
    deadVerify.result.verdict === "REVISE" && deadVerify.result.blocking === 1,
    JSON.stringify([deadVerify.result.verdict, deadVerify.result.blocking]));
}

// ── refactor.js — args scoping + the retry round's cleared accumulation ──────
console.log("refactor.js retry & args");
{
  // Bare-string shorthand names a DOMAIN — it must never widen to 'all' (that
  // dispatched code-editing implementers on every big domain).
  let backlogPrompt = "";
  await run("refactor.js", (prompt, opts) => {
    const label = opts.label || "";
    if (label === "profile") return PROFILE;
    if (label === "read-backlog") { backlogPrompt = prompt; return { domains: [] }; }
    return "ok";
  }, "backend");
  check("bare-string args scope to that domain, not 'all'",
    /Requested domains: backend/.test(backlogPrompt) && !/Requested domains: all/.test(backlogPrompt),
    backlogPrompt.slice(-140));
}
{
  // The re-verify covers only the retried items; round 1's verified clears must
  // survive the merge or the backlog un-ticks finished work.
  const items = ["- [ ] a", "- [ ] b", "- [ ] c", "- [ ] d", "- [ ] e"];
  let tickPrompt = "";
  const { result } = await run("refactor.js", (prompt, opts) => {
    const label = opts.label || "";
    if (label === "profile") return PROFILE;
    if (label === "read-backlog") return { domains: [{ key: "backend", items }] };
    if (label === "verify:backend") return { cleared: items.slice(0, 3), remaining: items.slice(3), gatesGreen: true };
    if (label === "reverify:backend") return { cleared: items.slice(3), remaining: [], gatesGreen: true };
    if (label === "tick-backlog") { tickPrompt = prompt; return "done"; }
    return "handoff";
  }, { domains: "all" });
  check("retry round keeps round-1 clears (5/5, not 2/5)",
    result.domains.backend.cleared === 5 && result.domains.backend.remaining === 0,
    JSON.stringify(result.domains));
  check("all five cleared items reach the ticker", items.every(i => tickPrompt.includes(i)),
    tickPrompt.slice(0, 160));
}
{
  // A dead re-verifier loses only the retry round's claim: round 1's clears stay
  // cleared, the retried items stay open — never reset to all-five-open.
  const items = ["- [ ] a", "- [ ] b", "- [ ] c", "- [ ] d", "- [ ] e"];
  const { result } = await run("refactor.js", (prompt, opts) => {
    const label = opts.label || "";
    if (label === "profile") return PROFILE;
    if (label === "read-backlog") return { domains: [{ key: "backend", items }] };
    if (label === "verify:backend") return { cleared: items.slice(0, 3), remaining: items.slice(3), gatesGreen: true };
    if (label === "reverify:backend") return null;
    if (label === "tick-backlog") return "done";
    return "handoff";
  }, { domains: "all" });
  check("dead re-verifier ⇒ round-1 clears kept, retried items open",
    result.domains.backend.cleared === 3 && result.domains.backend.remaining === 2,
    JSON.stringify(result.domains));
}
{
  // Gates red with everything cleared: the retry must NOT re-open verified items —
  // with a dead re-verifier the same lines once sat in `cleared` AND `remaining`
  // (ticked off the backlog while reported open).
  const items = ["- [ ] a", "- [ ] b", "- [ ] c", "- [ ] d", "- [ ] e"];
  const { result } = await run("refactor.js", (prompt, opts) => {
    const label = opts.label || "";
    if (label === "profile") return PROFILE;
    if (label === "read-backlog") return { domains: [{ key: "backend", items }] };
    if (label === "verify:backend") return { cleared: items, remaining: [], gatesGreen: false, failures: "lint red" };
    if (label === "reverify:backend") return null;
    if (label === "tick-backlog") return "done";
    return "handoff";
  }, { domains: "all" });
  check("gates-red + all cleared + dead re-verifier ⇒ no cleared/remaining overlap",
    result.domains.backend.cleared === 5 && result.domains.backend.remaining === 0,
    JSON.stringify(result.domains));
}

// ── loop.js — build → review → [fix → review]*, unattended ──────────────────
// The reducer's facts come from stubs, but the DECISIONS under test (freshness,
// precondition gates, exit ordering, treading water) all live in script code —
// which is exactly why they live there and not in an agent prompt.
console.log("loop.js");

const loopFacts = (over = {}) => ({
  now: { epoch: 1000000, iso: "2026-08-22T00:00:00Z" },
  spec: { exists: true, status: "frozen", kind: "", mtimeEpoch: 500, designFiles: [] },
  readiness: { exists: true, mtimeEpoch: 600, verdict: "READY", gaps: [], surfaces: ["backend", "frontend"] },
  contractFile: { exists: true },
  build: { exists: false },
  loop: { exists: false },
  ...over,
});
const FRESH_BUILD = { exists: true, mtimeEpoch: 600, dead: [] };
const loopReply = (facts, over = {}) => (prompt, opts) => {
  const label = opts.label || "";
  if (label === "profile") return over.profile || PROFILE;
  if (label === "preconditions") return facts;
  if (label.startsWith("state:") || label === "close") return "done 1000001";
  if (label.startsWith("ingest:")) return "ingest" in over ? over.ingest
    : { items: [{ line: "- [ ] CRITICAL · apps/api/a.ts:3 · quality · f", file: "apps/api/a.ts" }] };
  if (label.startsWith("tick:")) return "done";
  if (label.startsWith("build") || label.startsWith("fix")) {
    return "impl" in over ? over.impl : "handoff\n## Remediation addressed\n- apps/api/a.ts:3 — fixed";
  }
  return "ok";
};
const reviewOf = over => ({
  verdict: "REVISE", blocking: 1, blockingItems: ["backend|apps/api/a.ts|p"],
  unreviewedSurfaces: [], deferred: 0, ...over,
});
const SHIP_CLEAN = { verdict: "SHIP", blocking: 0, blockingItems: [], unreviewedSurfaces: [], deferred: 0, next: "/cohorte-ship feat-x (DoD ticked + freshness stamped)" };

{
  // THE ordering regression: a dead reviewer's zero findings must not read as ship.
  // unreviewed is checked BEFORE blocking — the other way round ships unread code.
  const wf = async () => reviewOf({ blocking: 0, unreviewedSurfaces: ["backend"] });
  const { result } = await run("loop.js", loopReply(loopFacts({ build: FRESH_BUILD })), { feature: "feat-x" }, wf);
  check("unreviewed + blocking 0 ⇒ abort/unreviewed, NOT ship",
    result.outcome === "abort" && result.reason === "unreviewed", JSON.stringify([result.outcome, result.reason]));
}
{
  // Same blocking identity two consecutive rounds ⇒ treading water at round 2,
  // not burned down to maxRounds.
  const wf = async () => reviewOf();
  const { result, calls } = await run("loop.js", loopReply(loopFacts({ build: FRESH_BUILD })), { feature: "feat-x" }, wf);
  check("identical fingerprint twice ⇒ abort/treading-water", result.reason === "treading-water", result.reason);
  check("…at round 2, not maxRounds", result.rounds === 2, `rounds ${result.rounds}`);
  check("…after exactly one fix round", calls.filter(c => c.startsWith("fix:")).length === 1,
    calls.filter(c => c.startsWith("fix")).join(","));
}
{
  // NOT-READY is the one outcome more passes cannot fix — and a precondition that
  // aborts AFTER spawning has not aborted: only profile + preconditions may run.
  const facts = loopFacts({ readiness: { exists: true, mtimeEpoch: 600, verdict: "NOT-READY", gaps: ["contract|POST /x|no shape"], surfaces: ["backend"] } });
  const { result, calls } = await run("loop.js", loopReply(facts), { feature: "feat-x" }, async () => SHIP_CLEAN);
  check("NOT-READY ⇒ abort/precondition with the gaps verbatim",
    result.reason === "precondition" && (result.gaps || []).length === 1, JSON.stringify(result));
  check("NOT-READY ⇒ zero dispatches (profile + facts only)",
    calls.join(",") === "profile,preconditions", calls.join(","));
}
{
  // readiness older than the spec describes a spec that no longer exists ⇒ absent.
  const facts = loopFacts({ readiness: { exists: true, mtimeEpoch: 400, verdict: "READY", gaps: [], surfaces: ["backend"] } });
  const { result, calls } = await run("loop.js", loopReply(facts), { feature: "feat-x" }, async () => SHIP_CLEAN);
  check("stale readiness.json ⇒ treated as absent ⇒ abort/precondition",
    result.reason === "precondition" && /older than the spec/.test(result.detail), JSON.stringify(result.detail));
  check("stale readiness ⇒ zero dispatches", calls.join(",") === "profile,preconditions", calls.join(","));
}
{
  // A blocking finding on the contract file is /cohorte-fix §1's lead-only step.
  const CPROFILE = { ...PROFILE, contract: { enabled: true, path: "packages/shared/src", ext: "ts", mechanism: "shared-types-zod" } };
  const wf = async () => reviewOf({ blockingItems: ["backend|packages/shared/src/feat-x.ts|response shape wrong"] });
  const { result, calls } = await run("loop.js",
    loopReply(loopFacts({ build: FRESH_BUILD }), { profile: CPROFILE }), { feature: "feat-x" }, wf);
  check("blocking finding on the contract file ⇒ abort/contract-change",
    result.reason === "contract-change", result.reason);
  check("contract-change ⇒ no fix round dispatched", !calls.some(c => c.startsWith("fix")), calls.join(","));
}
{
  // Dead build implementers: retried ONCE, byte-identical, then abort — never "ok".
  const { result, calls, prompts } = await run("loop.js",
    loopReply(loopFacts(), { impl: null }), { feature: "feat-x" }, async () => SHIP_CLEAN);
  check("dead implementers ⇒ abort/dead-implementers", result.reason === "dead-implementers", result.reason);
  check("each dead surface retried exactly once",
    calls.filter(c => c === "build:backend").length === 1 && calls.filter(c => c === "build-retry:backend").length === 1,
    calls.join(","));
  check("the retry is byte-identical to the dispatch",
    prompts["build:backend"] === prompts["build-retry:backend"]);
}
{
  // Deferred findings never cost a round: 9 deferred + 0 blocking ships in one.
  const wf = async () => ({ ...SHIP_CLEAN, deferred: 9 });
  const { result } = await run("loop.js", loopReply(loopFacts({ build: FRESH_BUILD })), { feature: "feat-x" }, wf);
  check("deferred 9 + blocking 0 ⇒ ship in one round",
    result.outcome === "ship" && result.rounds === 1 && result.deferred === 9, JSON.stringify(result));
}
{
  // The degraded preflight verdict has no unreviewed/blocking keys — the reducer
  // must branch on `aborted`, not crash on a missing field.
  const wf = async () => ({ verdict: "ABORTED", aborted: "preflight", reason: "preflight red" });
  const { result } = await run("loop.js", loopReply(loopFacts({ build: FRESH_BUILD })), { feature: "feat-x" }, wf);
  check("child preflight abort ⇒ abort/preflight (no crash on the degraded shape)",
    result.outcome === "abort" && result.reason === "preflight", JSON.stringify([result.outcome, result.reason]));
}
{
  // A fresh build.json with no dead surfaces means the work is on disk — entering
  // after a conversational /cohorte-build must not rebuild it.
  const { result, calls } = await run("loop.js",
    loopReply(loopFacts({ build: FRESH_BUILD })), { feature: "feat-x" }, async () => SHIP_CLEAN);
  check("fresh build.json ⇒ build phase skipped", !calls.some(c => c.startsWith("build")), calls.join(","));
  check("…and the run still ships", result.outcome === "ship", result.outcome);
  // …and a STALE build.json builds: the work on disk predates the spec.
  const stale = await run("loop.js",
    loopReply(loopFacts({ build: { exists: true, mtimeEpoch: 400, dead: [] } })), { feature: "feat-x" }, async () => SHIP_CLEAN);
  check("stale build.json ⇒ build phase runs", stale.calls.some(c => c.startsWith("build:")), stale.calls.join(","));
}
{
  // Resume: an unfinished, fresh loop.json restores round + the treading-water key,
  // so a run killed mid-round costs a re-review, not a restart.
  const prev = JSON.stringify({ id: "feat-x", round: 3, lastItems: ["backend|apps/api/a.ts|p"], history: [{ round: 1, blocking: 3 }, { round: 2, blocking: 1 }] });
  const facts = loopFacts({ build: FRESH_BUILD, loop: { exists: true, mtimeEpoch: 700, raw: prev } });
  const wf = async () => reviewOf();
  const { result, calls } = await run("loop.js", loopReply(facts), { feature: "feat-x" }, wf);
  check("resume: same items as the resumed round ⇒ treading-water immediately",
    result.reason === "treading-water" && !calls.some(c => c.startsWith("fix")), JSON.stringify([result.reason, result.rounds]));
  check("resume: history carries the prior rounds", result.rounds === 3, `rounds ${result.rounds}`);
  // A FINISHED loop.json (outcome set) must not resume — fresh run from round 1.
  const done = JSON.stringify({ id: "feat-x", round: 4, outcome: "abort", lastItems: ["backend|apps/api/a.ts|p"], history: [] });
  const r2 = await run("loop.js",
    loopReply(loopFacts({ build: FRESH_BUILD, loop: { exists: true, mtimeEpoch: 700, raw: done } })),
    { feature: "feat-x" }, wf);
  check("a finished loop.json does not resume (round 1, fix dispatched)",
    r2.calls.some(c => c.startsWith("fix:")), r2.calls.join(","));
}
{
  // The loop EDITS the spec as it runs (status stamps, Remediation appends), so on
  // resume the spec's mtime is NEWER than readiness.json — freshness must be measured
  // against the baseline stored in loop.json, or the loop's own footprint aborts its
  // own resume with "readiness is older than the spec".
  const prev = JSON.stringify({ id: "feat-x", round: 2, specMtime: 500, lastItems: ["backend|apps/api/old.ts|p"], history: [{ round: 1, blocking: 3 }] });
  const facts = loopFacts({
    spec: { exists: true, status: "in-progress", kind: "", mtimeEpoch: 900, designFiles: [] },
    build: FRESH_BUILD,
    loop: { exists: true, mtimeEpoch: 700, raw: prev },
  });
  const { result } = await run("loop.js", loopReply(facts), { feature: "feat-x" }, async () => SHIP_CLEAN);
  check("resume survives the loop's own spec writes (baseline mtime, not current)",
    result.outcome === "ship", JSON.stringify([result.outcome, result.reason, result.detail]));
  check("resume keeps only rounds before the resumed one (no double count)",
    result.rounds === 2, `rounds ${result.rounds}`);
}
{
  // A real verdict whose report never landed on disk: the fix round would ingest the
  // PREVIOUS round's report. Resumable give-up, never a fix round on stale findings.
  const wf = async () => reviewOf({ reportStaged: false });
  const { result, calls } = await run("loop.js", loopReply(loopFacts({ build: FRESH_BUILD })), { feature: "feat-x" }, wf);
  check("blocking verdict + unstaged report ⇒ abort/report-not-staged, no fix round",
    result.reason === "report-not-staged" && !calls.some(c => c.startsWith("fix")),
    JSON.stringify([result.reason, calls.filter(c => c.startsWith("fix"))]));
}
{
  // Ordinary surface code can live UNDER contract.path (a `shared` surface at the
  // contract package) — only the feature's contract FILE is the lead-only abort.
  const CPROFILE = { ...PROFILE, contract: { enabled: true, path: "packages/shared/src", ext: "ts", mechanism: "shared-types-zod" } };
  const wf = async () => reviewOf({ blockingItems: ["backend|packages/shared/src/utils.ts|helper broken"] });
  const { result, calls } = await run("loop.js",
    loopReply(loopFacts({ build: FRESH_BUILD }), { profile: CPROFILE }), { feature: "feat-x" }, wf);
  check("a finding elsewhere under contract.path is NOT contract-change",
    result.reason !== "contract-change" && calls.some(c => c.startsWith("fix:")),
    JSON.stringify([result.reason, calls.filter(c => c.startsWith("fix"))]));
}
{
  // A dead fix implementer still gets its metrics line — an incomplete batch is the
  // batch worth recording — written BEFORE the abort.
  const wf = async () => reviewOf();
  const { result, prompts } = await run("loop.js",
    loopReply(loopFacts({ build: FRESH_BUILD }), { impl: null }), { feature: "feat-x" }, wf);
  check("dead fix implementer ⇒ abort, with the fix metrics written first (\"dead\")",
    result.reason === "dead-implementers" && /"backend":"dead"/.test(prompts["state:fixed-1"] || ""),
    JSON.stringify([result.reason, (prompts["state:fixed-1"] || "").slice(-120)]));
}
{
  // maxRounds is the last net: distinct findings each round burn down to it.
  let n = 0;
  const wf = async () => reviewOf({ blockingItems: [`backend|apps/api/f${++n}.ts|p`] });
  const { result } = await run("loop.js", loopReply(loopFacts({ build: FRESH_BUILD })),
    { feature: "feat-x", maxRounds: 2 }, wf);
  check("maxRounds reached with distinct findings ⇒ abort/max-rounds at that round",
    result.reason === "max-rounds" && result.rounds === 2, JSON.stringify([result.reason, result.rounds]));
}
{
  // A ship with surviving HIGH/MEDIUM has NO freshness stamp — the loop must relay
  // review's routing (which says /cohorte-fix), not print "/cohorte-ship".
  const wf = async () => ({ ...SHIP_CLEAN, next: "/cohorte-fix feat-x — SHIP verdict, but 2 finding(s) above LOW survived; park them in specs/refactor-backlog.md instead if you deliberately defer them" });
  const { result } = await run("loop.js", loopReply(loopFacts({ build: FRESH_BUILD })), { feature: "feat-x" }, wf);
  check("ship with HIGH leftovers ⇒ next relays review's /cohorte-fix routing",
    String(result.next).startsWith("/cohorte-fix"), result.next);
}
{
  // Dead ingest = no Remediation items were appended; dispatching blind would
  // re-build surfaces with no instructions. Abort, resumable at this round.
  const wf = async () => reviewOf();
  const { result } = await run("loop.js",
    loopReply(loopFacts({ build: FRESH_BUILD }), { ingest: null }), { feature: "feat-x" }, wf);
  check("dead ingest agent ⇒ abort/ingest-died, items never invented",
    result.reason === "ingest-died", result.reason);
}
{
  // Token accounting: the run's history and metrics lines carry approximate output
  // tokens from budget.spent() — the figure the conversational path cannot record.
  const wf = async () => reviewOf();
  const { result, prompts } = await run("loop.js", loopReply(loopFacts()),
    { feature: "feat-x" }, wf, tickingBudget());
  check("loop: history rounds carry a tokens figure",
    result.history.length > 0 && result.history.every(h => typeof h.tokens === "number" && h.tokens > 0),
    JSON.stringify(result.history));
  check("loop: build metrics line carries tokens",
    /"phase":"build".*"tokens":[1-9]/.test(prompts["state:built"] || ""),
    (prompts["state:built"] || "").slice(-200));
  check("loop: the run total is returned", typeof result.tokens === "number" && result.tokens > 0,
    String(result.tokens));
  let stagePrompt = "";
  await run("review.js", (prompt, opts) => {
    if (opts.label === "stage-report") { stagePrompt = prompt; return "done"; }
    return replier([["review:", { verdict: "SHIP", findings: [] }], ...BASE_REVIEW])(prompt, opts);
  }, { feature: "feat-x" }, undefined, tickingBudget());
  check("review: metrics line carries tokens",
    /"phase":"review".*"tokens":[1-9]/.test(stagePrompt), stagePrompt.slice(-200));
}
{
  // workflow() unavailable (no runtime / review.js not installed) ⇒ explicit refusal,
  // never a conversational fallback.
  const wf = async () => { throw new Error("unknown workflow: cohorte-review"); };
  const { result } = await run("loop.js", loopReply(loopFacts({ build: FRESH_BUILD })), { feature: "feat-x" }, wf);
  check("review workflow unavailable ⇒ abort/review-workflow-unavailable",
    result.reason === "review-workflow-unavailable", result.reason);
}

console.log("");
if (failures) { console.error(`test-workflows: ${failures} failure(s)`); process.exit(1); }
console.log("test-workflows: OK");
