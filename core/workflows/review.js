// cohorte — /cohorte-review as a deterministic workflow (opt-in; the conversational
// /cohorte-review command remains the default path and the fallback).
//
// Invoke with args = {feature: "<feature_id>"} (or the bare feature id string).
// Requires Claude Code >= 2.1.154 with workflows enabled — /cohorte-doctor reports this.
//
// Shape (profile/schema/workflows.md): phase 0 reads the profile through the
// profile-reader agent (scripts have no filesystem or shell), the deterministic
// preflight aborts while red (zero reviewers spawned), the diff is staged ONCE
// per touched surface, one reviewer runs per surface in parallel, an adversarial
// cross-check tries to refute every CRITICAL/security finding, and only the
// merged verdict comes back — the full report is staged to specs/reports/.
// Mechanical phases run on haiku; reviewers run the pinned `cohorte-review` agent (sonnet).

export const meta = {
  name: 'cohorte-review',
  description: 'Review a cohorte feature: preflight gate, one reviewer per touched surface, adversarial cross-check, merged verdict only',
  whenToUse: 'Only when the human explicitly asks for the review workflow of a cohorte feature. args = {feature: "<feature_id>"}.',
  phases: [
    { title: 'Profile', detail: 'PIPELINE.md → JSON via profile-reader', model: 'haiku' },
    { title: 'Preflight', detail: 'typecheck + lint + tests — abort while red', model: 'haiku' },
    { title: 'Stage', detail: 'feature-diff.sh: changed paths once, per-surface hunks to disk', model: 'haiku' },
    { title: 'Review', detail: 'one review agent per touched surface' },
    { title: 'Cross-check', detail: 'adversarial refutation of CRITICAL/security findings' },
    { title: 'Merge', detail: 'stage merged report + metrics; return the verdict', model: 'haiku' },
  ],
}

// The Workflow runtime hands `args` to a script verbatim, so a caller that passes a
// JSON-ENCODED STRING instead of a real object gets that string back here. The old
// `typeof args === 'string' ? args.trim()` then took the whole blob as the value — which
// is how a report landed on disk named `specs/reports/{"feature": "x"}.md`, and how
// maxRounds/smoke were silently dropped on the same run. Parse it back into the object
// it was meant to be; a bare slug stays valid shorthand.
const ARGS = (() => {
  if (typeof args === 'string') {
    const t = args.trim()
    if (t.startsWith('{')) {
      try { const o = JSON.parse(t); if (o && typeof o === 'object' && !Array.isArray(o)) return o } catch {}
    }
    return { feature: t, target: t }
  }
  return args && typeof args === 'object' ? args : {}
})()
// Approximate cost of this run from the runtime's own output-token counter — the one
// figure the conversational path cannot record (a lead cannot read a subagent's token
// count; profile/schema/metrics.md). Sampled at start, delta stamped into the metrics line.
const spentNow = () => {
  try {
    const v = (budget && typeof budget.spent === 'function') ? budget.spent() : 0
    return Number.isFinite(v) ? v : 0   // a NaN here would poison the metrics JSON downstream
  } catch { return 0 }
}
const spentStart = spentNow()

const isSlug = s => typeof s === 'string' && /^[A-Za-z0-9._-]+$/.test(s)
const feature = ARGS.feature
if (!feature) throw new Error('cohorte-review needs args = {feature: "<feature_id>"}')
if (!isSlug(feature)) {
  throw new Error(`cohorte-review got a feature id that is not a slug: ${JSON.stringify(feature)}. ` +
    'Pass args as a real object, e.g. {feature: "titlebar-project-switcher"} — not a JSON string.')
}

// The profile-reader returns through a StructuredOutput tool call, and a haiku agent
// intermittently nests the whole profile as a JSON *string* under a single wrapper field
// ({"output": "{\"surfaces\": …}"}) instead of putting the profile's keys at the top level.
// The schema here used to be {type:'object', additionalProperties:true} — no declared
// properties, no required keys — so that wrapper validated cleanly and every field then read
// as undefined: `surfaces` fell back to [], parallel([]) dispatched zero agents, the
// dead-agent guard had no surfaces to find missing, and the run reported a verdict having
// done nothing. On the surface it is indistinguishable from a clean run with an empty diff.
// Declaring the shape gives the tool layer something to validate and the agent something to
// aim at; unwrapProfile() salvages a wrapped return that still gets through; and the
// zero-surface abort below makes the silent-success path impossible either way.
// See also the structured-output section of core/agents/cohorte-profile-reader.md.
const PROFILE = {
  type: 'object', additionalProperties: true,
  properties: {
    error: { type: 'string', description: 'set ONLY when PIPELINE.md is missing or unparseable' },
    surfaces: {
      type: 'array',
      description: "one entry per surface, at the TOP LEVEL of this object — never a JSON string",
      items: {
        type: 'object', required: ['key'], additionalProperties: true,
        properties: { key: { type: 'string' }, path: { type: 'string' }, agent: { type: 'string' } },
      },
    },
  },
}

// Salvage a profile handed back as JSON text rather than as an object — either the whole
// return, or nested under a single wrapper field. Anything already shaped like a profile
// (has `surfaces`, or is the documented `{error}` failure shape) passes through untouched.
const unwrapProfile = p => {
  if (typeof p === 'string') { try { return JSON.parse(p) } catch { return null } }
  if (!p || typeof p !== 'object') return null
  if (Array.isArray(p.surfaces) || p.error) return p
  for (const v of Object.values(p)) {
    if (typeof v !== 'string') continue
    try {
      const inner = JSON.parse(v)
      if (inner && typeof inner === 'object' && !Array.isArray(inner)) return inner
    } catch {}
  }
  return p
}

const PREFLIGHT = {
  type: 'object', required: ['pass'], additionalProperties: false,
  properties: {
    pass: { type: 'boolean' },
    epoch: { type: 'integer', description: 'the `date +%s` printed at the START of the Bash call — the run\'s wall-clock origin' },
    tail: { type: 'string', description: 'on failure: the raw last lines the script printed' },
  },
}

const STAGE = {
  type: 'object', required: ['surfaces'], additionalProperties: false,
  properties: {
    error: { type: 'string', description: 'set ONLY when feature-diff.sh is absent or exited non-zero: its stderr line' },
    surfaces: {
      type: 'array',
      items: {
        type: 'object', required: ['key', 'diff', 'files'], additionalProperties: false,
        properties: {
          key: { type: 'string' },
          diff: { type: 'string', description: 'path of the staged .diff file' },
          files: { type: 'array', items: { type: 'string' }, description: 'changed files (from --numstat)' },
        },
      },
    },
  },
}

const FINDING = {
  type: 'object', required: ['severity', 'file', 'line', 'kind', 'problem', 'fix'],
  additionalProperties: false,
  properties: {
    severity: { enum: ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] },
    file: { type: 'string' }, line: { type: 'integer' },
    kind: { enum: ['spec-violation', 'quality', 'security', 'complexity'] },
    problem: { type: 'string', description: 'one line, no code excerpts' },
    fix: { type: 'string', description: 'one concrete change, one line' },
  },
}

// A DEFERRED finding is real but out of this feature's scope (pre-existing code the
// diff never touched). It carries its own out-of-scope reason, counts in no severity
// row, is never cross-checked, and can never move the verdict — it is routed to
// specs/refactor-backlog.md so /cohorte-refactor owns it. See core/agents/cohorte-review.md §Deferred.
const DEFERRED = {
  type: 'object', required: ['severity', 'file', 'line', 'kind', 'problem', 'fix', 'outOfScope'],
  additionalProperties: false,
  properties: {
    severity: { enum: ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] },
    file: { type: 'string' }, line: { type: 'integer' },
    kind: { enum: ['quality', 'security', 'rule', 'complexity'] },
    problem: { type: 'string', description: 'one line, no code excerpts' },
    fix: { type: 'string', description: 'one concrete change, one line' },
    outOfScope: { type: 'string', description: 'one line: why this feature does not own it' },
  },
}

const REPORT = {
  type: 'object', required: ['verdict', 'findings'], additionalProperties: false,
  properties: {
    verdict: { enum: ['SHIP', 'REVISE', 'BLOCK'] },
    findings: { type: 'array', maxItems: 20, items: FINDING },
    deferred: { type: 'array', maxItems: 10, items: DEFERRED },
    overflow: { type: 'integer', description: 'findings beyond the 20-item cap, if any' },
    notes: { type: 'string', description: 'RBAC / mobile-first assessment only, when the profile enables them' },
  },
}

const VERDICT = {
  type: 'object', required: ['refuted', 'reason'], additionalProperties: false,
  properties: {
    refuted: { type: 'boolean' },
    reason: { type: 'string', description: 'one line: why the finding does or does not hold' },
  },
}

// ── Phase 0 — profile ────────────────────────────────────────────────────────
phase('Profile')
const profile = unwrapProfile(await agent(
  'Return this project\'s profile (the `yaml pipeline-profile` block — `.claude/profile.json`, else PIPELINE.md) as JSON, per your instructions.',
  { agentType: 'cohorte-profile-reader', label: 'profile', schema: PROFILE, effort: 'low' },
))
if (!profile || profile.error) {
  return { verdict: 'ABORTED', aborted: 'profile', reason: `profile unreadable: ${(profile && profile.error) || 'profile-reader returned nothing'}` }
}
const cmds = profile.commands || {}
const base = (profile.vcs && profile.vcs.default_branch) || 'main'
const surfaces = Array.isArray(profile.surfaces) ? profile.surfaces : []
// A profile with no surfaces cannot do this workflow's work, and every later
// guard compares against `surfaces` — an empty list makes them all vacuously
// pass. Fail loudly here instead of finishing with nothing done.
if (!surfaces.length) {
  return { verdict: 'ABORTED', aborted: 'profile', reason: 'profile has no surfaces — nothing would be reviewed. the `yaml pipeline-profile` block in PIPELINE.md is empty or unparseable, or the profile-reader mis-returned; run /cohorte-doctor' }
}
const quiet = (q, full) => (q && !String(q).startsWith('<') ? q : full ? `${full} 2>&1 | tail -40` : '')
const checks = [cmds.typecheck, quiet(cmds.lint_quiet, cmds.lint), quiet(cmds.test_quiet, cmds.test)]
  .filter(c => c && !String(c).startsWith('<'))

// ── Phase 1 — deterministic preflight (abort while red, zero reviewers) ─────
phase('Preflight')
const pre = await agent(
  `Run the cohorte deterministic pre-flight for feature ${feature} in ONE Bash call, starting it with ` +
  '`date +%s` (return that number as `epoch` — the run\'s wall-clock origin for the metrics line):\n' +
  `<core>/pipeline/scripts/preflight.sh specs/reports/${feature}.preflight.txt ` +
  checks.map(c => JSON.stringify(c)).join(' ') + '\n' +
  '(<core> = "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/cohorte". ' +
  'Script absent: run the quoted commands yourself, each appended to the same report file, stopping at the first failure.) ' +
  'Return pass=true only on a fully green run. On failure set pass=false, put the raw last 40 lines of the report ' +
  'in `tail` — verbatim, no summarizing — and in the same Bash call write the degraded machine verdict the ' +
  `conversational /cohorte-review §0 writes, so an automated driver gets a diagnosis rather than silence: ` +
  `printf '{"id":"${feature}","phase":"review","ts":"%s","aborted":"preflight","verdict":"BLOCK","blocking":null}' ` +
  `"$(date -u +%Y-%m-%dT%H:%M:%SZ)" > specs/reports/${feature}.verdict.json`,
  { model: 'haiku', label: 'preflight', schema: PREFLIGHT, effort: 'low' },
)
if (!pre || !pre.pass) {
  return {
    verdict: 'ABORTED', aborted: 'preflight',
    reason: 'preflight red — fix the mechanical failures (or run /cohorte-fix) before any review; no reviewer was spawned',
    failures: (pre && pre.tail) || 'preflight agent returned nothing',
  }
}

// ── Phase 2 — stage the diff once ────────────────────────────────────────────
phase('Stage')
const surfaceList = surfaces.map(s => `${s.key} → ${s.path}`).join(' · ') || '(none declared)'
// Every diff goes through feature-diff.sh (profile/schema/feature-diff.md): a throwaway index so
// UNTRACKED files are reviewed (feature work is uncommitted until ship — a bare `git diff`
// dropped every new module, and an adds-only feature staged an empty diff that scored SHIP),
// against the MERGE-BASE with the default branch (its tip blamed the feature for every file
// main gained since). The human's real index is never touched.
const FD = `<core>/pipeline/scripts/feature-diff.sh --default ${base}`
const staged = await agent(
  `Stage the review inputs for cohorte feature ${feature}. Surfaces: ${surfaceList}. ` +
  '(<core> = "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/cohorte".) Never use a bare `git diff` — it misses untracked files.\n' +
  `1. ONE call: ${FD} --numstat > specs/reports/${feature}.stat.txt — never print it. Non-zero exit or script ` +
  'absent ⇒ return `error` with its stderr line and an empty surfaces array, and do nothing else.\n' +
  '2. Group the changed paths (3rd tab-separated column) by surface path prefix with one awk; paths under no surface are the `shared` remainder — attach them to the most relevant surface.\n' +
  `3. Per surface that has changed paths (ONLY those): ${FD} --patch -- <surface.path> [<remainder paths>] > specs/reports/${feature}.<key>.diff\n` +
  '4. Return the touched surfaces with their staged diff path and changed-file list. No changed paths at all ⇒ return an empty surfaces array.',
  { model: 'haiku', label: 'stage-diff', schema: STAGE, effort: 'low' },
)
// A DEAD staging agent returns null, which is not the same fact as "the diff is
// empty" — conflating them handed back verdict SHIP ("nothing to review") for a
// feature nobody had looked at. Distinguish them.
if (!staged) {
  return {
    verdict: 'ABORTED', aborted: 'stage-diff',
    reason: 'the diff-staging agent died — no reviewer was spawned and nothing was reviewed',
    next: `re-run the review workflow, or /cohorte-review ${feature} conversationally`,
  }
}
// Every abort after the preflight overwrites verdict.json too: a stale SHIP left on disk from
// an earlier round is exactly what /cohorte-ship (and a driver) would read.
const writeAborted = why => agent(
  `Write EXACTLY this to specs/reports/${feature}.verdict.json (overwrite), substituting <ISO now> ` +
  'with `date -u +%Y-%m-%dT%H:%M:%SZ`, then return the single word done:\n' +
  JSON.stringify({ id: feature, phase: 'review', ts: '<ISO now>', aborted: why, verdict: 'BLOCK', blocking: null }),
  { model: 'haiku', label: 'stage-verdict', effort: 'low' },
)
if (staged.error) {
  await writeAborted('stage-diff')
  return {
    verdict: 'ABORTED', aborted: 'stage-diff',
    reason: `feature-diff.sh failed — no diff, no reviewer: ${staged.error}`,
    next: 'fix the cause (exit 3 = the default branch / merge-base cannot be resolved; script absent = run `cohorte update`), then re-run the review',
  }
}
const touched = staged.surfaces || []
if (!touched.length) {
  // An empty diff reviewed NOTHING, so it certifies nothing. It used to score SHIP — and an
  // adds-only feature (before untracked files were diffed) reached /cohorte-ship on it. It is
  // an abort, and the aborted verdict overwrites any stale verdict.json a driver or ship reads.
  await writeAborted('empty-diff')
  return {
    verdict: 'ABORTED', aborted: 'empty-diff',
    reason: `the diff against the merge-base with ${base} is empty (untracked files included) — nothing was reviewed`,
    next: 'nothing to review: check the branch (was the feature built here, in this worktree?) — no verdict, no freshness stamp',
  }
}
log(`Touched surfaces: ${touched.map(s => s.key).join(', ')}`)

// ── Phases 3+4 — review each surface, cross-check its hard findings ─────────
// pipeline(): a fast surface's cross-check starts while a slow one still reviews.
const reviewPrompt = s =>
  'Review one feature surface against its frozen spec, per your agent instructions (read the staged ' +
  'diff FIRST; open a full source file only when a finding demands it; capped shape — max 20 findings, ' +
  'one line each, no code excerpts). Put anything real but OUT of this feature\'s scope in `deferred` ' +
  '(max 10, each with its out-of-scope reason) per your §Deferred rules — never in `findings`. — Variable slots: ' +
  `feature ${feature} · scope: the ${s.key} surface only · spec: specs/${feature}.md · ` +
  `staged diff: ${s.diff} · changed files: ${s.files.join(', ')}`
// profile/schema/dead-agents.md, the same rule as the build: a silent reviewer is retried ONCE,
// byte-identical (the staged diff is already on disk — the retry costs one agent); only a
// surface silent twice is `unreviewed`.
const reviewOnce = (s, label) =>
  agent(reviewPrompt(s), { agentType: 'cohorte-review', label, phase: 'Review', schema: REPORT })
const reviewed = await pipeline(
  touched,
  async s => {
    const r = await reviewOnce(s, `review:${s.key}`)
    if (r != null) return r
    log(`${s.key}: reviewer died — one byte-identical retry`)
    return reviewOnce(s, `review:${s.key}#retry`)
  },
  async (report, s) => {
    if (!report) return null
    const hard = report.findings.filter(f => f.severity === 'CRITICAL' || f.kind === 'security')
    const rest = report.findings.filter(f => !hard.includes(f))
    // Deferred items skip the cross-check entirely: refuting one would spend an agent
    // to argue about something that cannot affect the verdict either way.
    const deferred = report.deferred || []
    if (!hard.length) return { key: s.key, report, kept: rest, refuted: [], deferred }
    const votes = await parallel(hard.map(f => () => agent(
      'Adversarially verify ONE review finding — your job is to REFUTE it if you can. Read the staged ' +
      'diff and the exact file:line; refuted=true when the code, a guard, a test, or the spec shows the ' +
      'finding does not hold. Uncertain ⇒ refuted=false (a real CRITICAL must not die on doubt). — ' +
      `Finding: [${f.severity}/${f.kind}] ${f.file}:${f.line} — ${f.problem} (proposed fix: ${f.fix}). ` +
      `Feature ${feature} · spec: specs/${feature}.md · staged diff: ${s.diff}`,
      { agentType: 'cohorte-review', label: `verify:${s.key}`, phase: 'Cross-check', schema: VERDICT },
    ).then(v => ({ f, refuted: !!(v && v.refuted), reason: v ? v.reason : 'verifier died — kept' }))))
    const checkedVotes = votes.filter(Boolean)
    return {
      key: s.key,
      report,
      kept: rest.concat(checkedVotes.filter(v => !v.refuted).map(v => v.f)),
      refuted: checkedVotes.filter(v => v.refuted).map(v => ({ ...v.f, reason: v.reason })),
      deferred,
    }
  },
)

const results = reviewed.filter(Boolean)
// A reviewer that DIED returns null — and a dead reviewer produces zero findings,
// which is byte-identical to a clean surface. Left unchecked, "every reviewer
// crashed" scores SHIP: the strongest possible verdict from the weakest possible
// evidence. Name the unreviewed surfaces and refuse to certify them.
const unreviewed = touched.filter(s => !results.some(r => r.key === s.key)).map(s => s.key)
if (unreviewed.length) log(`Reviewer died on: ${unreviewed.join(', ')} — those surfaces are NOT reviewed`)
const kept = results.flatMap(r => r.kept.map(f => ({ ...f, surface: r.key })))
const refuted = results.flatMap(r => r.refuted.map(f => ({ ...f, surface: r.key })))
// Deferred findings are deliberately kept OUT of `counts`, out of `verdict` and out
// of `clean`: they belong to /cohorte-refactor, not to this feature's fix loop.
const deferredAll = results.flatMap(r => (r.deferred || []).map(f => ({ ...f, surface: r.key })))
const counts = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 }
for (const f of kept) counts[f.severity] = (counts[f.severity] || 0) + 1
// blocking = CRITICAL + security findings, each counted once — the conversational
// /cohorte-review §3's contract restated as a number, so blocking == 0 ⟺ verdict SHIP.
// blocking_items carry the finding's IDENTITY, not its wording: surface | file without
// `:line` (a fix that inserts lines shifts every line below it — a line-bearing identity
// would change every pass and drift detection would never fire) | the problem's first 8
// words, lowercased, runs of non-alphanumerics collapsed. Sorted, so two rounds with the
// same findings compare equal however the reviewers ordered them.
const blockingFindings = kept.filter(f => f.severity === 'CRITICAL' || f.kind === 'security')
const normProblem = p => String(p).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').slice(0, 8).join(' ')
const blockingItems = [...new Set(blockingFindings.map(f =>
  `${f.surface}|${String(f.file).replace(/:\d+$/, '')}|${normProblem(f.problem)}`))].sort()
// THE verdict rule (core/agents/cohorte-review.md §Severity & verdict), applied to the
// findings that SURVIVED the cross-check — never "the worst verdict a reviewer returned"
// (a refuted CRITICAL must not force a fix loop): any security ⇒ BLOCK, else any CRITICAL
// ⇒ REVISE, else SHIP — and never SHIP while a surface went unreviewed (absence of
// evidence is not evidence of absence). Per-surface verdicts use the same rule.
const verdictOf = (fs, missing) => fs.some(f => f.kind === 'security') ? 'BLOCK'
  : fs.some(f => f.severity === 'CRITICAL') ? 'REVISE'
    : missing ? 'REVISE' : 'SHIP'
const verdict = verdictOf(kept, unreviewed.length > 0)
// Only a SHIP whose leftovers are all LOW is a clean bill of health. The
// conversational /cohorte-review routes any surviving CRITICAL/HIGH/security to /cohorte-fix, so
// this path must not answer "/cohorte-ship" on a SHIP that still carries HIGH findings.
const clean = verdict === 'SHIP' && kept.every(f => f.severity === 'LOW')

// ── Phase 5 — stage the merged report; only the verdict leaves the workflow ──
phase('Merge')
const findingLine = f =>
  `- [${f.severity}] \`${f.file}:${f.line}\` · ${f.kind} · ${f.problem} → **Fix:** ${f.fix}`
const reportBody = [
  '# REVIEW REPORT', `feature_id: ${feature} · merged by cohorte-review workflow`, '',
  '| Severity | Count |', '| -------- | ----- |',
  ...['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'].map(s => `| ${s} | ${counts[s] || 0} |`), '',
  `Verdict: ${verdict}`, '', '## Findings', '',
  kept.length ? kept.map(findingLine).join('\n') : 'None.',
  '', '## Deferred', '',
  deferredAll.length
    ? deferredAll.map(f => `${findingLine(f)} · out of scope: ${f.outOfScope} · deferred:${feature}`).join('\n')
    : 'None.',
  ...(unreviewed.length ? ['', '## NOT reviewed (reviewer died — no verdict on these)', '',
    unreviewed.map(k => `- \`${k}\` — re-run /cohorte-review ${feature} (or the review workflow)`).join('\n')] : []),
  ...(refuted.length ? ['', '## Refuted by cross-check (no action needed)', '',
    refuted.map(f => `- ${f.file}:${f.line} · ${f.problem} — refuted: ${f.reason}`).join('\n')] : []),
].join('\n')
// The machine-readable verdict the conversational /cohorte-review §3 guarantees — the
// ONLY contract between the pipeline and an automated driver (the loop workflow), which
// parses no prose. Composed HERE so the staging agent substitutes two tokens and can
// invent nothing; the sha256 fingerprint is computed in its Bash (scripts have no crypto).
const verdictJson = JSON.stringify({
  id: feature, phase: 'review', ts: '<ISO now>', verdict,
  findings: kept.length, blocking: blockingFindings.length,
  security: kept.filter(f => f.kind === 'security').length,
  deferred: deferredAll.length, unreviewed,
  severity: counts,
  // Per-surface verdicts AFTER the cross-check, by the same rule — the reviewer's own
  // pre-cross-check verdict once marked a surface REVISE over a refuted CRITICAL.
  surfaces: Object.fromEntries(results.map(r => [r.key, {
    verdict: verdictOf(r.kept, false), findings: r.kept.length,
    blocking: r.kept.filter(f => f.severity === 'CRITICAL' || f.kind === 'security').length,
  }])),
  blocking_items: blockingItems, fingerprint: '<FP>',
})
const staging = await agent(
  `Stage a cohorte review report and its metrics, mechanically ` +
  '(<core> = "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/cohorte"):\n' +
  `1. Write EXACTLY this content to specs/reports/${feature}.md (overwrite):\n<<<REPORT\n${reportBody}\nREPORT\n` +
  `2. Write EXACTLY this to specs/reports/${feature}.verdict.json (overwrite), substituting <ISO now> with ` +
  '`date -u +%Y-%m-%dT%H:%M:%SZ` and <FP> with the fingerprint — computed in Bash, never by hand: ' +
  (blockingItems.length
    // POSIX-escape embedded quotes ('\'') rather than stripping them: a stripped quote
    // makes the fingerprint disagree with the blocking_items in the same file, and with
    // a conversational re-run computing it per the §3 contract.
    ? `printf '%s\\n' ${blockingItems.map(i => `'${i.replace(/'/g, "'\\''")}'`).join(' ')} | LC_ALL=C sort | sha256sum | cut -c1-16 ` +
      '(`shasum -a 256` then first 16 hex chars where there is no sha256sum):\n'
    : 'the blocking list is empty, so <FP> is the empty string "":\n') +
  `${verdictJson}\n` +
  // Per-surface verdicts (not the merged one stamped on every row — one BLOCK used to
  // mark ALL surfaces failed), and dead reviewers logged as "dead"
  // per profile/schema/dead-agents.md — an incomplete batch is the batch worth recording.
  `3. Append one line to $(dirname "$(git rev-parse --git-common-dir)")/.claude/pipeline-metrics.jsonl: ` +
  // seconds: the clock lives in Bash (scripts have none) — elapsed since the preflight's
  // `date +%s`. No epoch came back ⇒ the field is OMITTED, never a made-up 0.
  `{"ts":"<ISO now>","feature":"${feature}","phase":"review",${
    Number.isInteger(pre.epoch) && pre.epoch > 0 ? `"seconds":$(($(date +%s)-${pre.epoch})),` : ''
  }"tokens":${Math.max(0, spentNow() - spentStart)},"surfaces":{${
    results.map(r => `"${r.key}":"${verdictOf(r.kept, false)}:${r.kept.length}"`)
      .concat(unreviewed.map(k => `"${k}":"dead"`)).join(',')}}}\n` +
  // Deferred findings must land in the backlog on EVERY verdict — parked only on a
  // SHIP is parked nowhere the rest of the time, which is the leak this closes.
  (deferredAll.length
    ? `4. Route the deferred findings to specs/refactor-backlog.md (create it if absent): for each line below, ` +
      `insert it directly under the \`## <domain>\` heading named in its prefix with one awk pass (heading absent ⇒ ` +
      `append a new \`## <domain>\` block at the end with \`>>\`; a bare \`>>\` under another domain's heading files it ` +
      `in the wrong section) — never by reading the file back and rewriting it, and skip any whose file path + first words already appear there (grep -F first, ` +
      `they may be left from a prior round or an /cohorte-audit):\n` +
      deferredAll.map(f =>
        `${f.surface}||- [ ] ${f.severity} · ${f.file}:${f.line} · ${f.kind} · ${f.fix} · deferred:${feature}`).join('\n') +
      '\n'
    : '') +
  // Stamp + tick only when nothing above LOW survived: the conversational /cohorte-review
  // keeps the stamp only for LOW findings, and a SHIP verdict here can still carry
  // HIGH/MEDIUM ones — certifying those for /cohorte-ship would ship known defects. A dead
  // reviewer already forced the verdict off SHIP, so `clean` covers that too.
  (clean
    ? `5. Stamp the freshness gate in specs/${feature}.md's front-matter, exactly as the conversational /cohorte-review §3 does ` +
      `(so /cohorte-ship can prove the reviewed code is what ships): BASE=$(${FD} --base-only); set reviewed_base: $BASE and ` +
      'reviewed_digest: $(<core>/pipeline/scripts/feature-diff.sh --base $BASE --digest) — never a bare git diff (it misses untracked files). ' +
      '6. Tick the spec DoD boxes this run verified (spec conformance + copy language — review SHIP; tests/lint/typecheck — green preflight); leave the rest unticked.\n'
    : '') +
  'Return the single word: done.',
  { model: 'haiku', label: 'stage-report', effort: 'low' },
)

// The staging agent writes the report, the metrics line, and (when clean) the
// freshness stamp + DoD ticks. If it died, none of that is on disk — returning
// `report: <path>` and "/cohorte-ship" would point the human at a file that does not
// exist and certify a stamp that was never written.
const staged_ok = staging != null && /done/i.test(String(staging))

return {
  verdict,
  counts,
  blocking: blockingFindings.length, // CRITICAL + security, each once — 0 ⟺ SHIP; what a driver reduces on
  blockingItems,                     // the sorted identity list behind verdict.json's fingerprint
  deferred: deferredAll.length,     // parked in the backlog for /cohorte-refactor — never blocking
  refutedByCrossCheck: refuted.length,
  reportStaged: staged_ok,
  unreviewedSurfaces: unreviewed,   // reviewers that died — these carry NO verdict
  criticals: kept.filter(f => f.severity === 'CRITICAL' || f.kind === 'security')
    .map(f => `[${f.surface}] ${f.file}:${f.line} — ${f.problem}`),
  report: staged_ok ? `specs/reports/${feature}.md` : '(NOT written — the staging agent died)',
  next: !staged_ok
    ? `the report/metrics/freshness stamp were NEVER written (staging agent died) — the verdict above is real, but nothing is on disk: re-run the review workflow, or /cohorte-review ${feature}`
    : unreviewed.length
      ? `re-run the review — no reviewer completed on: ${unreviewed.join(', ')}`
      : clean
        ? `/cohorte-ship ${feature} (DoD ticked + freshness stamped)`
        : verdict === 'SHIP'
        ? `/cohorte-fix ${feature} — SHIP verdict, but ${kept.length} finding(s) above LOW survived; park them in specs/refactor-backlog.md instead if you deliberately defer them`
        : `/cohorte-fix ${feature}`,
}
