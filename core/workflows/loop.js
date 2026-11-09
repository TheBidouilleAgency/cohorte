// cohorte — /cohorte-loop: build → review → [fix → review]* for ONE feature, unattended.
//
// WORKFLOW-ONLY, on purpose: there is no core/commands/cohorte-loop.md and there must never
// be one (validate-core.mjs enforces it). If the Workflow runtime is unavailable, this
// refuses explicitly rather than degrading to a conversational loop — a lead re-reasoning
// the fan-out every round at session-model prices, which is the exact cost this script
// exists to avoid, silently becoming the default on every runtime that is not Claude Code.
//
// Invoke with args = {feature: "<feature_id>", maxRounds?: 1..10} (or the bare id string).
// Requires Claude Code >= 2.1.154 with workflows enabled — /cohorte-doctor reports this.
//
// The human's part happens BEFORE this runs, and the loop verifies it rather than working
// around it: /cohorte-spec froze the spec; /cohorte-build ran once — §1.5 reconciled the
// surfaces, §2 authored the contract (lead-only, the single sync channel), §1.6 wrote
// readiness.json. Three decisions stay human and abort the loop when they come up mid-run:
// a surface the profile does not own (§1.5 reconcile), a contract that must change
// (/cohorte-fix §1's lead-only step), and a NOT-READY spec (more passes cannot fix it).
//
// State is a reducer over files on disk — readiness.json + build.json (build's),
// verdict.json (review's), and loop.json (this script's own) — nothing lives in script
// memory between rounds. Re-invoking on the same feature resumes from loop.json; every
// file older than the spec's mtime is treated as absent (v2's killer was reading a missing
// file as an empty one; the mirror-image bug is reading an old file as a current one).
//
// NOTE for unattended runs: workflow subagents run in acceptEdits whatever the session
// mode, so hooks/gate.py is the only brake on file edits for the whole run (SCHEMA.md
// §Preflight) — and in bypassPermissions its asks escalate to hard denies.

export const meta = {
  name: 'cohorte-loop',
  description: 'Run one feature unattended: build (if not already on disk), review, then fix→review rounds until zero blocking findings, treading water, or maxRounds',
  whenToUse: 'Only when the human explicitly asks to loop a cohorte feature. Preconditions: frozen spec, fresh readiness.json (from /cohorte-build §1.6), contract on disk. args = {feature: "<feature_id>", maxRounds?: 1..10}.',
  phases: [
    { title: 'Profile', detail: 'PIPELINE.md → JSON via profile-reader', model: 'haiku' },
    { title: 'Preconditions', detail: 'raw facts from disk — every gate decided in script', model: 'haiku' },
    { title: 'Build', detail: 'one implementer per surface, parallel (skipped on a fresh build.json)' },
    { title: 'Review', detail: 'the cohorte-review workflow, one call per round' },
    { title: 'Fix', detail: 'Remediation append + scoped re-dispatch, only surfaces with findings' },
    { title: 'Close', detail: 'final loop.json + spec status + kanban', model: 'haiku' },
  ],
}

// The Workflow runtime hands `args` to a script verbatim, so a caller that passes a
// JSON-ENCODED STRING instead of a real object gets that string back here. Parse it back
// into the object it was meant to be; a bare slug stays valid shorthand.
const ARGS = (() => {
  if (typeof args === 'string') {
    const t = args.trim()
    if (t.startsWith('{')) {
      try { const o = JSON.parse(t); if (o && typeof o === 'object' && !Array.isArray(o)) return o } catch {}
    }
    return { feature: t }
  }
  return args && typeof args === 'object' ? args : {}
})()
const isSlug = s => typeof s === 'string' && /^[A-Za-z0-9._-]+$/.test(s)
const feature = ARGS.feature
if (!feature) throw new Error('cohorte-loop needs args = {feature: "<feature_id>"}')
if (!isSlug(feature)) {
  throw new Error(`cohorte-loop got a feature id that is not a slug: ${JSON.stringify(feature)}. ` +
    'Pass args as a real object, e.g. {feature: "titlebar-project-switcher"} — not a JSON string.')
}
const maxRounds = Math.max(1, Math.min(10, Number(ARGS.maxRounds) || 5))

// ── The reducer — the whole design, as one pure function ─────────────────────
// Evaluated in this order; the first match wins, and the order is load-bearing:
//   1. A child abort (preflight red, dead stager) carries no coverage claim — relay it.
//   2. `unreviewed` BEFORE `blocking`: SCHEMA.md §Dead agents — a dead reviewer makes
//      blocking == 0 a statement about code nobody read. Checked the other way round,
//      the loop ships a feature whose reviewer crashed, silently and "successfully".
//   3. blocking == 0 ⇒ ship. HIGH/MEDIUM/LOW never block (they route to the backlog)
//      and deferred findings never cost a round — both already enforced upstream.
//   4. Same blocking-item identity two CONSECUTIVE rounds ⇒ the fix round changed
//      nothing the reviewer can see: treading water, abort now rather than proving it
//      again for the remaining rounds. (An A→B→A oscillation passes this check and is
//      caught by maxRounds — an acceptable second net.) Identity excludes `:line` by
//      construction (/cohorte-review §3's blocking_items contract), so a fix that only
//      shifts lines does not mask the stall.
//   5. maxRounds is the last net, never the first.
// It runs NO agent: every field is in the contract the review path guarantees.
const decide = (r, lastKey, round, max) => {
  if (!r || typeof r !== 'object') return { outcome: 'abort', reason: 'review-died' }
  if (r.verdict === 'ABORTED') return { outcome: 'abort', reason: r.aborted || 'review-aborted' }
  if ((r.unreviewedSurfaces || []).length) return { outcome: 'abort', reason: 'unreviewed' }
  if (typeof r.blocking !== 'number') return { outcome: 'abort', reason: 'no-verdict' }
  if (r.blocking === 0) return { outcome: 'ship' }
  const key = (r.blockingItems || []).join('\n')
  if (lastKey != null && key === lastKey) return { outcome: 'abort', reason: 'treading-water' }
  if (round >= max) return { outcome: 'abort', reason: 'max-rounds' }
  return { outcome: 'continue', key }
}

// Map a finding's file path onto the owning surface, /cohorte-fix §2's rule in code:
// longest surfaces[].path prefix wins; a path under no surface goes to the surface
// already owning the most items this round (or the first) — and is logged, not hidden.
const surfaceFor = (file, surfaces) => {
  let best = null
  for (const s of surfaces) {
    if (s.path && String(file).startsWith(s.path) && (!best || s.path.length > best.path.length)) best = s
  }
  return best
}

// A cheap, deterministic 16-hex digest for the round history — workflow scripts have no
// crypto, and equality of the treading-water key is decided on the full string anyway;
// this only makes a bad run diagnosable at a glance. (FNV-1a, twice, seeded apart.)
const hash16 = s => {
  const fnv = seed => {
    let h = seed >>> 0
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0 }
    return h.toString(16).padStart(8, '0')
  }
  return s ? fnv(0x811c9dc5) + fnv(0x01000197) : ''
}

// Same profile hardening as the other three scripts — see review.js for the full story.
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

// The precondition agent returns RAW FACTS (existence, mtimes, front-matter fields,
// file contents) and every gate is decided HERE, in script code — so the freshness and
// abort logic is pinned by scripts/test-workflows.mjs instead of living in a prompt
// where no test can see it.
const FACTS = {
  type: 'object', required: ['now', 'spec', 'readiness', 'contractFile', 'build', 'loop'],
  additionalProperties: false,
  properties: {
    now: {
      type: 'object', required: ['epoch', 'iso'], additionalProperties: false,
      properties: { epoch: { type: 'integer' }, iso: { type: 'string' } },
    },
    spec: {
      type: 'object', required: ['exists'], additionalProperties: false,
      properties: {
        exists: { type: 'boolean' },
        status: { type: 'string', description: 'front-matter status, "" if none' },
        kind: { type: 'string', description: 'front-matter kind, "" if none (⇒ feature)' },
        mtimeEpoch: { type: 'integer' },
        designFiles: { type: 'array', items: { type: 'string' }, description: 'front-matter design_files links, [] if none' },
        contractDelta: { type: 'string', description: "kind:patch only — 'none' when §5 Contract delta is none/absent, else 'present'" },
      },
    },
    readiness: {
      type: 'object', required: ['exists'], additionalProperties: false,
      properties: {
        exists: { type: 'boolean' }, mtimeEpoch: { type: 'integer' },
        verdict: { type: 'string' },
        gaps: { type: 'array', items: { type: 'string' } },
        surfaces: { type: 'array', items: { type: 'string' } },
      },
    },
    contractFile: {
      type: 'object', required: ['exists'], additionalProperties: false,
      properties: { exists: { type: 'boolean' } },
    },
    build: {
      type: 'object', required: ['exists'], additionalProperties: false,
      properties: {
        exists: { type: 'boolean' }, mtimeEpoch: { type: 'integer' },
        dead: { type: 'array', items: { type: 'string' } },
      },
    },
    loop: {
      type: 'object', required: ['exists'], additionalProperties: false,
      properties: {
        exists: { type: 'boolean' }, mtimeEpoch: { type: 'integer' },
        raw: { type: 'string', description: 'the loop.json file content, verbatim' },
      },
    },
  },
}

const ITEMS = {
  type: 'object', required: ['items'], additionalProperties: false,
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object', required: ['line', 'file'], additionalProperties: false,
        properties: {
          line: { type: 'string', description: 'the appended `- [ ] …` Remediation line, verbatim' },
          file: { type: 'string', description: 'the finding\'s file path (no :line)' },
        },
      },
    },
  },
}

// Token accounting — the one thing the conversational path cannot do (a lead cannot
// read a subagent's token count) and a workflow can: budget.spent() is the runtime's
// own output-token counter for this turn. Deltas between marks give an approximate
// per-phase cost; the review CHILD workflow stamps its own review-phase line, so the
// loop marks AROUND the child to keep build/fix deltas from double-counting it.
const spent = () => {
  try {
    const v = (budget && typeof budget.spent === 'function') ? budget.spent() : 0
    return Number.isFinite(v) ? v : 0   // a NaN here would poison every metrics JSON downstream
  } catch { return 0 }
}

// kanban-move.sh is optional infrastructure — every prompt that runs it defines <core>
// and tolerates its absence, per SCHEMA.md §Kanban.
const CORE_DEF = '(<core> = .claude if .claude/pipeline/scripts/kanban-move.sh exists, else ~/.claude — ' +
  'probe with test -f; absent on both ⇒ skip the kanban step, the board is optional.)'
const METRICS_PATH = '$(dirname "$(git rev-parse --git-common-dir)")/.claude/pipeline-metrics.jsonl'

// ── Phase 0 — profile ────────────────────────────────────────────────────────
phase('Profile')
const profile = unwrapProfile(await agent(
  'Return this project\'s PIPELINE.md `yaml pipeline-profile` block as JSON, per your instructions.',
  { agentType: 'profile-reader', label: 'profile', schema: PROFILE, effort: 'low' },
))
if (!profile || profile.error) {
  return { id: feature, outcome: 'abort', reason: 'precondition', rounds: 0, detail: `profile unreadable: ${(profile && profile.error) || 'profile-reader returned nothing'}` }
}
const surfaces = Array.isArray(profile.surfaces) ? profile.surfaces : []
if (!surfaces.length) {
  return { id: feature, outcome: 'abort', reason: 'precondition', rounds: 0, detail: 'profile has no surfaces — nothing could be built or reviewed; run /cohorte-doctor' }
}
const byKey = Object.fromEntries(surfaces.map(s => [s.key, s]))
const contract = profile.contract || {}
const base = (profile.vcs && profile.vcs.default_branch) || 'main'
const contractOn = contract.enabled !== false && contract.path && !String(contract.path).startsWith('<')
const contractFilePath = contractOn ? `${contract.path}/${feature}.${contract.ext || 'ts'}` : ''

// ── Phase 1 — preconditions: raw facts in, every verdict decided in script ───
phase('Preconditions')
const facts = await agent(
  `Collect RAW facts for the cohorte loop on feature ${feature} — mechanical reads only, no judgment, ` +
  'never print file bodies. Use ONE Bash call chain where possible; file mtimes as unix epochs ' +
  '(stat -f %m on macOS, stat -c %Y on Linux), now = date +%s and date -u +%Y-%m-%dT%H:%M:%SZ.\n' +
  `- specs/${feature}.md: exists · front-matter \`status\` and \`kind\` (grep the first ~15 lines) · mtime · ` +
  'front-matter `design_files` entries as a list · and, ONLY when kind is patch: contractDelta = "none" if ' +
  'its §5 Contract delta section is `none`/absent, else "present".\n' +
  `- specs/reports/${feature}.readiness.json: exists · mtime · its verdict, gaps, surfaces fields (jq or grep).\n` +
  (contractOn ? `- ${contractFilePath}: exists.\n` : '- contractFile: report exists=false (the profile has no contract mechanism).\n') +
  `- specs/reports/${feature}.build.json: exists · mtime · its dead[] array.\n` +
  `- specs/reports/${feature}.loop.json: exists · mtime · the file content VERBATIM in raw.\n` +
  'A file that does not exist ⇒ exists=false and omit its other fields.',
  { model: 'haiku', label: 'preconditions', schema: FACTS, effort: 'low' },
)
if (!facts) {
  return { id: feature, outcome: 'abort', reason: 'precondition', rounds: 0, detail: 'the precondition agent died — nothing was dispatched; re-run the loop workflow' }
}
let clock = (facts.now && facts.now.epoch) || 0
const specMtime = (facts.spec && facts.spec.mtimeEpoch) || 0

// Resume state is parsed BEFORE the freshness gates, because the baseline they compare
// against comes from it. The loop EDITS the spec as it runs (status stamps, Remediation
// appends, DoD ticks), so the spec's mtime moves past readiness.json on the very first
// round — measured naively, the loop's own footprint would invalidate its own resume
// ("readiness is older than the spec") the moment anything real happened. loop.json
// therefore stores the spec mtime observed when the run STARTED, and an unfinished run
// for this feature measures freshness against that baseline. A human who rewrites the
// spec mid-run without re-entering through /cohorte-build is outside what mtimes can
// distinguish — delete specs/reports/<id>.loop.json to force a fresh run.
let resumed = null
if (facts.loop && facts.loop.exists && facts.loop.raw) {
  try {
    const prev = JSON.parse(facts.loop.raw)
    if (prev && prev.id === feature && !prev.outcome) resumed = prev
  } catch { /* unparseable loop.json = no resume; a fresh run overwrites it */ }
}
const baselineMtime = (resumed && typeof resumed.specMtime === 'number') ? resumed.specMtime : specMtime
const startedAt = (resumed && resumed.startedAt) || (facts.now && facts.now.iso) || ''
// Freshness: a report older than the (baseline) spec describes a spec that no longer
// exists — treat it exactly as absent (the mirror image of v2's missing-file-read-as-
// empty bug).
const fresh = f => !!(f && f.exists && typeof f.mtimeEpoch === 'number' && f.mtimeEpoch >= baselineMtime)

const abortPre = detail => ({ id: feature, outcome: 'abort', reason: 'precondition', rounds: 0, detail })

// 1. The spec, in a buildable state. `in-progress` is accepted because THIS script
//    stamps it — a resumed loop must not refuse its own footprint.
if (!facts.spec.exists) return abortPre(`specs/${feature}.md does not exist — /cohorte-spec first`)
const status = facts.spec.status || ''
if (!['frozen', 'in-review', 'in-progress'].includes(status)) {
  return abortPre(`spec status is '${status || '(none)'}' — the loop needs frozen | in-review | in-progress ` +
    `(SCHEMA.md §Spec status). draft ⇒ /cohorte-spec; blocked ⇒ route by the spec's ## Remediation first; shipped ⇒ done already`)
}
// 2. A fresh readiness verdict — the gate /cohorte-build §1.6 wrote. NOT-READY is the one
//    outcome more passes cannot fix; stale-or-absent means nobody has judged THIS spec.
if (!fresh(facts.readiness)) {
  return abortPre(`specs/reports/${feature}.readiness.json is ${facts.readiness.exists ? 'older than the spec' : 'absent'} — ` +
    `run /cohorte-build ${feature} once (its §1.6 writes the readiness verdict), then re-run the loop`)
}
if (facts.readiness.verdict === 'NOT-READY') {
  return { ...abortPre(`readiness verdict is NOT-READY — /cohorte-spec ${feature} must close these gaps first`), gaps: facts.readiness.gaps || [] }
}
if (!['READY', 'RESERVATIONS'].includes(facts.readiness.verdict || '')) {
  return abortPre(`readiness verdict is '${facts.readiness.verdict || '(none)'}' — not a verdict the loop can build on; re-run /cohorte-build ${feature}`)
}
// 3. The contract file — the single sync channel, lead-authored. A patch whose §5 is
//    `none` legitimately has no contract; everything else without one means /cohorte-build
//    §2 never ran, and authoring it is exactly the step a workflow must not do.
const isPatch = facts.spec.kind === 'patch'
if (contractOn && !facts.contractFile.exists && !(isPatch && facts.spec.contractDelta !== 'present')) {
  return abortPre(`contract file ${contractFilePath} is absent — /cohorte-build ${feature} authors it (lead-only, §2); the loop never will`)
}
// 4. Every surface the readiness verdict names must resolve in the profile. One that
//    does not is /cohorte-build §1.5's reconcile case — a human decision (new agent,
//    new tree owner), so name it and stop rather than dispatch around it.
const wantedKeys = (facts.readiness.surfaces || []).filter(Boolean)
if (!wantedKeys.length) return abortPre('readiness.json names no surfaces — nothing to dispatch; re-run /cohorte-build')
const unknown = wantedKeys.filter(k => !byKey[k])
if (unknown.length) {
  return abortPre(`readiness names surface(s) the profile does not own: ${unknown.join(', ')} — ` +
    `that is /cohorte-build §1.5's reconcile (a human renders the new agent); run /cohorte-build ${feature}, then re-run the loop`)
}

// Resume — loop.json is state, not memory (parsed above, before the gates). The
// persisted history already carries the round being resumed when the run died after
// its review — keep only rounds BEFORE the current one, or the re-review double-counts.
let round = 1
let lastKey = null
let history = []
if (resumed) {
  round = Math.max(1, Number(resumed.round) || 1)
  lastKey = Array.isArray(resumed.lastItems) ? resumed.lastItems.join('\n') : null
  history = (Array.isArray(resumed.history) ? resumed.history : []).filter(h => h && h.round < round)
  log(`Resuming ${feature} at round ${round} (unfinished loop.json)`)
}

// Readiness gaps (RESERVATIONS) inline into the dispatch of the surface they affect —
// gap format: `<check>|<where>|<what>`; route by `<where>` when it names a surface key,
// else give the gap to every dispatched surface (better a stated assumption twice than
// an invented answer once).
const gapsFor = key => (facts.readiness.gaps || [])
  .filter(g => { const w = String(g).split('|')[1]; return !w || !byKey[w] || w === key })

// ── The one byte-stable dispatch template — /cohorte-build §3 and /cohorte-fix §2 ─────
// Build rounds and fix rounds use the SAME prompt; only the trailing variable slots
// differ, so every repeat hits the prompt-cache prefix, and the fix rounds can never
// drift from the build (the drift nobody notices for months).
const contractSlot = contractOn
  ? (isPatch && facts.spec.contractDelta !== 'present' ? 'none (kind: patch, no contract delta)' : `\`${contractFilePath}\``)
  : 'none — the spec prose is the sync channel'
const dispatchPrompt = j =>
  `Implement the **${j.s.key}** surface for feature \`${feature}\`. Read \`PIPELINE.md\` first. ` +
  `Spec: \`specs/${feature}.md\`. Contract: ${contractSlot} (import read-only). Work test-first. ` +
  `Touch only \`${j.s.path}\`. Need the current state of your tree? Compute it yourself: ` +
  `git diff ${base} -- ${j.s.path}. Return the handoff in the format your agent instructions define. ` +
  `Design files: ${j.design}. ` +
  'Open Remediation items for YOUR surface (self-contained — fix exactly these, reading only the files ' +
  `they name; \`none\` ⇒ first build, implement the spec's tasks for your surface): ${j.items}. ` +
  'Readiness gaps for YOUR surface (§1.6 RESERVATIONS — the spec is silent here: implement the stated ' +
  `assumption and flag what you assumed in your handoff): ${j.gaps}.`

// Dispatch + roll call, SCHEMA.md §Dead agents: parallel fan-out, then each silent
// surface retried ONCE, alone, byte-identical. Never a surface that answered.
const dispatchSurfaces = async (jobs, phaseTitle) => {
  const tag = phaseTitle === 'Build' ? 'build' : 'fix'
  const first = await parallel(jobs.map(j => () =>
    agent(dispatchPrompt(j), { agentType: j.s.agent, label: `${tag}:${j.s.key}`, phase: phaseTitle })))
  const out = []
  for (let i = 0; i < jobs.length; i++) {
    let h = first[i]
    if (h == null) {
      log(`${jobs[i].s.key}: implementer died — one byte-identical retry, alone`)
      h = await agent(dispatchPrompt(jobs[i]), { agentType: jobs[i].s.agent, label: `${tag}-retry:${jobs[i].s.key}`, phase: phaseTitle })
    }
    out.push({ key: jobs[i].s.key, handoff: h })
  }
  return out
}

const designSlot = s => (s.uses_design && (facts.spec.designFiles || []).length)
  ? (facts.spec.designFiles || []).join(' · ') : 'none'

// One mechanical state writer per boundary: loop.json (EXACT content composed here —
// the agent only substitutes <ISO> and never invents fields), plus the optional spec
// status stamp, kanban move and metrics line. Returns `done <epoch>` so wall-clock
// threads through the agents' own `date +%s` (scripts have no clock of their own).
const writeState = async ({ label, phaseName, outcome, reason, status: st, kanban, metrics }) => {
  const loopJson = JSON.stringify({
    id: feature, round, maxRounds, phase: phaseName, startedAt, specMtime: baselineMtime, ts: '<ISO>',
    lastItems: lastKey == null ? null : lastKey.split('\n').filter(Boolean),
    history, ...(outcome ? { outcome, reason } : {}),
  })
  const steps = [
    `1. mkdir -p specs/reports; write EXACTLY this to specs/reports/${feature}.loop.json (overwrite), ` +
    'substituting EVERY <ISO> token in this and every later step with `date -u +%Y-%m-%dT%H:%M:%SZ` ' +
    `and changing NOTHING else:\n${loopJson}`,
  ]
  if (st) steps.push(
    `${steps.length + 1}. In specs/${feature}.md front-matter set \`status: ${st}\` (sed the existing status: line; ` +
    'a spec with no front-matter ⇒ skip silently — the loop never dies over a status line).')
  if (kanban) steps.push(
    `${steps.length + 1}. <core>/pipeline/scripts/kanban-move.sh auto ${feature} ${kanban} || true ${CORE_DEF}`)
  if (metrics) steps.push(
    `${steps.length + 1}. Append ONE line to ${METRICS_PATH}: ` +
    `{"ts":"<ISO>","feature":"${feature}","phase":"${metrics.phase}","seconds":$(($(date +%s)-${clock || 0})),` +
    `"tokens":${metrics.tokens || 0},` +
    `"surfaces":${JSON.stringify(metrics.surfaces)}}` + (metrics.buildJson
      ? `\n${steps.length + 2}. Write to specs/reports/${feature}.build.json (overwrite): ` +
        `{"id":"${feature}","phase":"build","ts":"<ISO>","surfaces":${JSON.stringify(metrics.surfaces)},"dead":${JSON.stringify(metrics.dead)}}`
      : ''))
  const r = await agent(
    `Mechanical state write for the cohorte loop, feature ${feature} — do ALL steps, then return exactly: done <epoch> ` +
    '(<epoch> = date +%s).\n' + steps.join('\n'),
    { model: 'haiku', label, phase: outcome ? 'Close' : undefined, effort: 'low' },
  )
  const m = /done\s+(\d+)/.exec(String(r || ''))
  if (m) clock = Number(m[1])
  return r != null
}

// Close the run: final loop.json + status + kanban, then the return object. Status
// doctrine (SCHEMA.md §Spec status): `blocked` = a round gave up (resumable, reason
// named); `in-review` = zero blocking, awaiting /cohorte-ship; precondition aborts
// never stamped anything, so they change nothing here either.
const close = async (outcome, reason, extra = {}) => {
  // Every abort that reaches close() is a round giving up — preconditions abort via
  // abortPre() before anything was stamped and never come through here. An abort left
  // outside this list once stranded the spec at `in-progress` forever.
  const gaveUp = outcome === 'abort'
  const closed = await writeState({
    label: 'close', phaseName: 'done', outcome, reason,
    status: outcome === 'ship' ? 'in-review' : gaveUp ? 'blocked' : undefined,
    kanban: outcome === 'ship' ? 'review' : gaveUp ? 'fix' : undefined,
  })
  return {
    id: feature, outcome, reason, rounds: history.length,
    blocking: history.length ? history[history.length - 1].blocking : null,
    tokens: spent(),   // approx output tokens for the whole run (runtime counter)
    history, report: `specs/reports/${feature}.md`,
    ...(closed ? {} : { stateWarning: 'the closing state agent died — loop.json/status/kanban may not reflect this outcome' }),
    ...extra,
  }
}

// ── Phase 2 — build, unless build's own work is already fresh on disk ────────
// /cohorte-build has no stop-after-§1.6 mode: when the human ran it through, the
// implementers' work and build.json are on disk and re-building would be waste; when
// build.json is stale, absent, or carries dead[], the loop builds (a full re-dispatch —
// implementers are idempotent against a frozen contract, the same property fix rounds
// already rely on).
let mark = spent()
if (fresh(facts.build) && !(facts.build.dead || []).length) {
  log('build.json is fresh with no dead surfaces — skipping the build phase, entering at review')
  await writeState({ label: 'state:enter', phaseName: 'review', status: 'in-progress', kanban: 'review' })
} else {
  phase('Build')
  await writeState({ label: 'state:build', phaseName: 'build', status: 'in-progress', kanban: 'building' })
  const jobs = wantedKeys.map(k => ({
    s: byKey[k], design: designSlot(byKey[k]), items: 'none',
    gaps: gapsFor(k).join(' · ') || 'none',
  }))
  const built = await dispatchSurfaces(jobs, 'Build')
  const dead = built.filter(b => b.handoff == null).map(b => b.key)
  // Write build.json + the metrics line EVEN WHEN a surface died — an incomplete batch
  // is exactly the batch worth recording (SCHEMA.md §Dead agents).
  await writeState({
    label: 'state:built', phaseName: dead.length ? 'build' : 'review',
    metrics: {
      phase: 'build', buildJson: true, dead, tokens: Math.max(0, spent() - mark),
      surfaces: Object.fromEntries(built.map(b => [b.key, b.handoff == null ? 'dead' : 'ok'])),
    },
  })
  if (dead.length) {
    return close('abort', 'dead-implementers', {
      detail: `surface(s) returned nothing twice: ${dead.join(', ')} — their trees are UNVERIFIED ` +
        '(a dead agent has no handoff to speak for); re-run the loop, or /cohorte-build conversationally',
    })
  }
}

// ── Phases 3–5 — the loop body: review → decide → fix → … ────────────────────
while (true) {
  phase('Review')
  await writeState({ label: `state:round-${round}`, phaseName: 'review', status: 'in-progress', kanban: 'review' })
  const roundMark = spent()
  let review
  try {
    review = await workflow('cohorte-review', { feature })
  } catch (e) {
    return close('abort', 'review-workflow-unavailable', {
      detail: `workflow('cohorte-review') failed: ${e.message} — the review workflow must be installed ` +
        '(<core>/workflows/review.js; /cohorte-doctor check 8); the loop never falls back to a conversational review',
    })
  }

  // The review child stamps its own review-phase metrics line; marking here keeps the
  // fix phase's delta clean of it. History carries the round's review cost.
  mark = spent()
  const verdict = decide(review, lastKey, round, maxRounds)
  if (review && typeof review.blocking === 'number') {
    history.push({
      round, blocking: review.blocking,
      fingerprint: hash16((review.blockingItems || []).join('\n')),
      tokens: Math.max(0, spent() - roundMark),
    })
  }

  if (verdict.outcome === 'ship') {
    // review.js stamps the freshness gate + DoD ticks only when every leftover is LOW
    // (`clean`); its `next` already says which side this run landed on — relay it, so a
    // ship exit with surviving HIGH/MEDIUM does not read as "run /cohorte-ship" when
    // /cohorte-ship would refuse (no reviewed_base/reviewed_digest stamp).
    return close('ship', 'ship', {
      deferred: review.deferred || 0,
      next: review.next || `/cohorte-ship ${feature}`,
    })
  }
  if (verdict.outcome === 'abort') {
    return close('abort', verdict.reason, {
      ...(verdict.reason === 'unreviewed' ? { unreviewed: review.unreviewedSurfaces } : {}),
      ...(verdict.reason === 'preflight' ? { detail: 'preflight red — mechanical failures need /cohorte-fix or the human, not more rounds' } : {}),
      ...(verdict.reason === 'treading-water' ? { detail: `round ${round} left the same ${review.blocking} blocking finding(s) as round ${round - 1} — the fix rounds are not converging; a human look is cheaper than ${maxRounds - round} more rounds` } : {}),
      ...(verdict.reason === 'max-rounds' ? { detail: `${review.blocking} blocking finding(s) still open after ${maxRounds} round(s)` } : {}),
    })
  }

  // The fix round ingests the staged report from disk; a dead staging agent means that
  // file is the PREVIOUS round's (or absent) — ingesting it fixes the wrong items and
  // manufactures a false treading-water abort next round. The verdict itself is real;
  // only the handoff is missing, so this is a resumable give-up, not a verdict.
  if (review.reportStaged === false) {
    return close('abort', 'report-not-staged', {
      detail: `round ${round}'s review completed (blocking: ${review.blocking}) but its report was never ` +
        `staged to disk (the staging agent died) — re-run the loop; it resumes at round ${round}`,
    })
  }

  // A blocking finding pointing at THE contract file itself is /cohorte-fix §1's
  // lead-only step (update spec §5, re-author the contract). A loop that rewrites its
  // own contract between rounds has no frozen contract — abort and name the finding.
  // Exact-file match, not a contract.path prefix: ordinary surface code can live under
  // the same tree (a `shared` surface at the contract package), and a prefix match
  // would make every blocking finding there permanently unfixable by the loop.
  if (contractOn) {
    const onContract = (review.blockingItems || []).filter(it => String(it.split('|')[1] || '') === contractFilePath)
    if (onContract.length) {
      return close('abort', 'contract-change', {
        detail: 'blocking finding(s) target the frozen contract itself — a lead must update spec §5 and ' +
          `re-author the contract (/cohorte-spec ${feature} Mode B, then /cohorte-build), then re-enter the loop`,
        findings: onContract,
      })
    }
  }

  // ── Fix round ──────────────────────────────────────────────────────────────
  phase('Fix')
  const ingest = await agent(
    `Mechanical ingest of a cohorte review round for feature ${feature} (loop round ${round}):\n` +
    `1. <core>/pipeline/scripts/kanban-move.sh auto ${feature} fix || true ${CORE_DEF}\n` +
    `2. Read the BLOCKING findings from specs/reports/${feature}.md ## Findings — exactly the lines whose ` +
    'severity is CRITICAL or whose kind is security (they are the only lines matching this identity list, ' +
    `one \`<surface>|<file>|<first words of the problem>\` per finding): ${JSON.stringify(review.blockingItems)}\n` +
    `3. Append them to specs/${feature}.md under \`## Remediation\` (create the heading if absent) beneath a ` +
    `new subheading \`### $(date -u +%Y-%m-%d) — cohorte-loop round ${round}\`, one line each: ` +
    '`- [ ] <SEVERITY> · <file:line> · <kind> · <the finding\'s concrete fix>`. Append with >>, never rewrite the spec.\n' +
    '4. Return each appended line verbatim plus its bare file path (no :line).',
    { model: 'haiku', label: `ingest:${round}`, phase: 'Fix', schema: ITEMS, effort: 'low' },
  )
  // A dead ingest agent appended nothing — dispatching implementers with no Remediation
  // items would re-build surfaces blind. Abort as a give-up, resumable at this round.
  if (!ingest || !(ingest.items || []).length) {
    return close('abort', ingest ? 'no-fix-items' : 'ingest-died', {
      detail: 'the Remediation ingest returned nothing — the blocking findings were never turned into ' +
        `fix items; re-run the loop (it resumes at round ${round}), or run /cohorte-fix ${feature} by hand`,
    })
  }
  // Surface mapping in script, /cohorte-fix §2's rule — longest path prefix owns the
  // item; unowned items ride with the surface already owning the most (logged).
  const grouped = {}
  const unowned = []
  for (const it of ingest.items) {
    const s = surfaceFor(it.file, surfaces)
    if (s) (grouped[s.key] = grouped[s.key] || []).push(it.line)
    else unowned.push(it)
  }
  if (unowned.length) {
    const host = Object.keys(grouped).sort((a, b) => grouped[b].length - grouped[a].length)[0] || wantedKeys[0]
    log(`${unowned.length} item(s) under no surface path — attached to ${host}: ${unowned.map(i => i.file).join(', ')}`)
    ;(grouped[host] = grouped[host] || []).push(...unowned.map(i => i.line))
  }
  const fixJobs = Object.keys(grouped).filter(k => byKey[k]).map(k => ({
    s: byKey[k], design: designSlot(byKey[k]), items: grouped[k].join(' · '),
    gaps: 'none',
  }))
  const fixed = await dispatchSurfaces(fixJobs, 'Fix')
  const fixDead = fixed.filter(f => f.handoff == null).map(f => f.key)
  // The metrics line is written EVEN WHEN a surface died — an incomplete batch is
  // exactly the batch worth recording (SCHEMA.md §Dead agents), so it lands before
  // the dead-implementers abort, with the dead surfaces named.
  await writeState({ label: `state:fixed-${round}`, phaseName: 'review', metrics: {
    phase: 'fix', tokens: Math.max(0, spent() - mark),
    surfaces: Object.fromEntries(fixed.map(f => [f.key, f.handoff == null ? 'dead' : 'ok'])),
  } })
  if (fixDead.length) {
    // Their items stay `- [ ]` — a dead agent never ticks a box (/cohorte-fix §3), and
    // nothing here has ticked anything yet, so the spec is already honest.
    return close('abort', 'dead-implementers', {
      detail: `fix implementer(s) returned nothing twice: ${fixDead.join(', ')} — their items stay open ` +
        `\`- [ ]\` in the spec; re-run the loop (resumes at round ${round}) or /cohorte-fix ${feature}`,
    })
  }
  // Tick ONLY what a live handoff claims — the excerpt passed per surface is its
  // `## Remediation addressed` section, so the ticker never sees (or trusts) silence.
  const excerpt = h => {
    const m = /## Remediation addressed[\s\S]*?(?=\n## |$)/.exec(String(h))
    return (m ? m[0] : String(h)).slice(0, 2000)
  }
  const ticked = await agent(
    `In specs/${feature}.md, flip \`- [ ]\` → \`- [x]\` for EXACTLY the Remediation items these surface handoffs ` +
    'report fixed (match by file:line; append a terse ` — fixed: <what>` note). Leave every item no handoff ' +
    'claims — and every other line — untouched. Then return the single word: done.\n' +
    fixed.map(f => `--- handoff ${f.key} ---\n${excerpt(f.handoff)}`).join('\n'),
    { model: 'haiku', label: `tick:${round}`, phase: 'Fix', effort: 'low' },
  )
  if (ticked == null) log('the ticking agent died — items stay `- [ ]`; the next round re-reviews regardless')

  lastKey = verdict.key
  round += 1
}
