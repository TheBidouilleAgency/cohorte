// cohorte — /cohorte-audit as a deterministic workflow (opt-in; the conversational
// /cohorte-audit command remains the default path and the fallback).
//
// Invoke with args = {target: "<path or domain>"} (optional — default whole repo).
//
// Shape (SCHEMA.md §Workflows): profile via profile-reader (phase 0), the
// mechanical gates staged to disk by one haiku agent, then ONE auditor per
// domain (each surface + `shared`) running concurrently — the runtime caps
// concurrency at 20 (CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS since 2026-08), extra
// domains queue — and a merge phase that writes the
// prioritized specs/refactor-backlog.md. Only the summary comes back.

export const meta = {
  name: 'cohorte-audit',
  description: 'Audit the codebase against PIPELINE.md: mechanical gates, one auditor per domain in parallel, prioritized refactor backlog',
  whenToUse: 'Only when the human explicitly asks for the audit workflow. args = {target: "<path or domain>"} — omit for the whole repo.',
  phases: [
    { title: 'Profile', detail: 'PIPELINE.md → JSON via profile-reader', model: 'haiku' },
    { title: 'Gates', detail: 'format/lint/typecheck/tests → specs/reports/audit-gates.txt', model: 'haiku' },
    { title: 'Audit', detail: 'one review-in-audit-mode agent per domain (concurrent, runtime-capped 20)' },
    { title: 'Backlog', detail: 'merge + write specs/refactor-backlog.md', model: 'haiku' },
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
const target = ARGS.target || ''

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
// See also the structured-output section of core/agents/profile-reader.md.
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

const GATES = {
  type: 'object', required: ['failures'], additionalProperties: false,
  properties: {
    failures: {
      type: 'array', maxItems: 40,
      items: {
        type: 'object', required: ['file', 'line', 'kind', 'summary'], additionalProperties: false,
        properties: {
          file: { type: 'string' }, line: { type: 'integer' },
          kind: { enum: ['lint', 'format', 'type', 'test'] },
          summary: { type: 'string', description: 'one line, no output excerpts' },
        },
      },
    },
    overflow: { type: 'integer', description: 'failures beyond the 40-item cap' },
  },
}

const BACKLOG = {
  type: 'object', required: ['items'], additionalProperties: false,
  properties: {
    items: {
      type: 'array', maxItems: 30,
      items: {
        type: 'object', required: ['severity', 'file', 'line', 'kind', 'fix'], additionalProperties: false,
        properties: {
          severity: { enum: ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] },
          file: { type: 'string' }, line: { type: 'integer' },
          kind: { enum: ['rule', 'tdd', 'lint', 'format', 'type', 'security'] },
          fix: { type: 'string', description: 'one concrete change, one line, no code excerpts' },
        },
      },
    },
    overflow: { type: 'integer' },
  },
}

// ── Phase 0 — profile ────────────────────────────────────────────────────────
phase('Profile')
const profile = unwrapProfile(await agent(
  'Return this project\'s PIPELINE.md `yaml pipeline-profile` block as JSON, per your instructions.',
  { agentType: 'profile-reader', label: 'profile', schema: PROFILE, effort: 'low' },
))
if (!profile || profile.error) {
  return { error: `profile unreadable: ${(profile && profile.error) || 'profile-reader returned nothing'}` }
}
const cmds = profile.commands || {}
const surfaces = Array.isArray(profile.surfaces) ? profile.surfaces : []
// A profile with no surfaces cannot do this workflow's work, and every later
// guard compares against `surfaces` — an empty list makes them all vacuously
// pass. Fail loudly here instead of finishing with nothing done.
if (!surfaces.length) {
  return { error: 'profile has no surfaces — nothing would be audited. the `yaml pipeline-profile` block in PIPELINE.md is empty or unparseable, or the profile-reader mis-returned; run /cohorte-doctor' }
}
const quiet = (q, full) => (q && !String(q).startsWith('<') ? q : full ? `${full} 2>&1 | tail -40` : '')
const scope = target || 'the whole repo'

// ── Phase 1 — mechanical gates, staged to disk ───────────────────────────────
phase('Gates')
const gateCmds = [
  cmds.format ? `${cmds.format} --check` : '',
  quiet(cmds.lint_quiet, cmds.lint),
  cmds.typecheck,
  quiet(cmds.test_quiet, cmds.test),
].filter(c => c && !String(c).startsWith('<'))
const gates = await agent(
  `Run the cohorte audit's mechanical gates, scoped to ${scope}. Commands (adapt the format one to the ` +
  `project's check mode if --check is wrong): ${gateCmds.map(c => JSON.stringify(c)).join(' · ')}.\n` +
  'Redirect EVERY command\'s output into specs/reports/audit-gates.txt (append, `cmd >> file 2>&1`) — ' +
  'never print it — and keep going after failures (this is an inventory, not a gate to pass). Then grep ' +
  'the file and return each failure as file/line/kind/one-line summary, capped at 40 (set overflow for the rest).',
  { model: 'haiku', label: 'gates', schema: GATES, effort: 'low' },
)
// A dead gates agent is NOT "zero mechanical failures" — silence would read as the
// cleanest possible inventory from a phase that never ran (SCHEMA.md §Dead agents).
// The domain auditors still run (they read the staged gates file, which then simply
// isn't there), but the run must say the mechanical sweep is uncovered.
const gatesCovered = gates != null
const mech = (gates && gates.failures) || []
log(gatesCovered
  ? `Mechanical failures: ${mech.length}${gates.overflow ? ` (+${gates.overflow} overflow)` : ''}`
  : 'the gates agent died — mechanical checks NOT covered this run')

// ── Phase 2 — one auditor per domain, concurrent ─────────────────────────────
// Domains = every surface + `shared` (contract package + anything outside the
// surface trees). The runtime caps concurrent agents at 20 by default; more domains
// queue. Raising CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS raises the ceiling, it does not
// change this script — the queue is the runtime's, and a queued domain is not a lost one.
phase('Audit')
const domains = surfaces.map(s => ({ key: s.key, path: s.path }))
  .concat([{ key: 'shared', path: (profile.contract && profile.contract.path) || '(everything outside the surface trees)' }])
  .filter(d => !target || target === d.key || String(d.path).startsWith(target) || target.startsWith(String(d.path)))
if (!domains.length) return { error: `target "${target}" matches no surface/domain` }

const audited = await parallel(domains.map(d => () => agent(
  'Audit a target against PIPELINE.md (no spec — audit mode, per your agent instructions). Check ' +
  'conventions for the domain\'s surface, TDD coverage (untested entry points / modules), and — if the ' +
  'profile enables them — mobile-first + design-system usage. Mechanical findings are already staged: ' +
  'read specs/reports/audit-gates.txt and fold the ones in your domain in. Return the prioritized items, ' +
  'capped at 30, one line each, no code excerpts. — Variable slots: domain: ' +
  `${d.key} · tree: ${d.path}${target ? ` · human-requested target: ${target}` : ''}`,
  { agentType: 'review', label: `audit:${d.key}`, schema: BACKLOG },
).then(r => r && { key: d.key, items: r.items, overflow: r.overflow || 0 })))
const perDomain = audited.filter(Boolean)
// A dead auditor returns null, and a domain with no result is indistinguishable
// from a domain with nothing to report — the backlog would simply omit it and the
// human would read that as "clean". Name them instead.
const deadDomains = domains.filter(d => !perDomain.some(p => p.key === d.key)).map(d => d.key)
if (deadDomains.length) log(`Auditor died on: ${deadDomains.join(', ')} — those domains are NOT audited`)

// ── Phase 3 — merge + write the backlog ──────────────────────────────────────
phase('Backlog')
const SEV = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 }
const body = ['# Refactor backlog', '', `> Generated by the cohorte-audit workflow (scope: ${scope}).`]
if (deadDomains.length) {
  body.push('', `> ⚠ NOT audited (the auditor died): ${deadDomains.join(', ')} — absence of items below`,
    '> for those domains means "not looked at", not "clean". Re-run the audit for them.')
}
if (!gatesCovered) {
  body.push('', '> ⚠ Mechanical gates NOT run (the gates agent died) — lint/typecheck/test failures',
    '> are uncounted below. Re-run the audit for the mechanical sweep.')
}
let total = 0
for (const d of perDomain) {
  const items = [...d.items].sort((a, b) => SEV[a.severity] - SEV[b.severity])
  total += items.length
  body.push('', `## ${d.key}`, '')
  for (const it of items) body.push(`- [ ] ${it.severity} · ${it.file}:${it.line} · ${it.kind} · ${it.fix}`)
  if (d.overflow) body.push(`- [ ] (+${d.overflow} more beyond the cap — re-audit ${d.key} after this pass)`)
}
const written = await agent(
  `Write EXACTLY this content to specs/refactor-backlog.md (overwrite), then return the single word done:\n<<<BACKLOG\n${body.join('\n')}\nBACKLOG`,
  { model: 'haiku', label: 'write-backlog', effort: 'low' },
)
// Returning `backlog: <path>` when the writer died points /cohorte-refactor at a file
// that does not exist (or, worse, at the PREVIOUS run's stale backlog).
const backlogOk = written != null && /done/i.test(String(written))

return {
  backlog: backlogOk ? 'specs/refactor-backlog.md' : '(NOT written — the backlog writer died)',
  notAudited: deadDomains,   // absence of findings here means "not looked at"
  mechanicalFailures: gatesCovered ? mech.length : null,  // null = gates agent died, NOT zero
  gatesCovered,
  domains: Object.fromEntries(perDomain.map(d => [d.key, d.items.length + (d.overflow || 0)])),
  total,
  top: perDomain.flatMap(d => d.items.map(it => ({ ...it, domain: d.key })))
    .sort((a, b) => SEV[a.severity] - SEV[b.severity]).slice(0, 10)
    .map(it => `[${it.severity}] ${it.domain} · ${it.file}:${it.line} — ${it.fix}`),
  next: !backlogOk
    ? 'the backlog was NEVER written (writer died) — the counts above are real but nothing is on disk; re-run the audit'
    : deadDomains.length
      ? `re-audit ${deadDomains.join(', ')} (auditor died — not covered), then /cohorte-refactor <domain>`
      : 'refactor a domain with /cohorte-refactor <domain> (or the refactor workflow for big domains)',
}
