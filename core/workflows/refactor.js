// cohorte — /cohorte-refactor as a deterministic workflow (opt-in; the conversational
// /cohorte-refactor command remains the default path and the fallback).
//
// BIG domains only: a domain with just a handful of open backlog items is
// cheaper through the conversational /cohorte-refactor — this script skips it and says
// so. Invoke with args = {domains: ["backend", …]} or {domains: "all"}.
//
// Shape (profile/schema/workflows.md): profile via profile-reader (phase 0), the open
// backlog read once, the `shared` domain (contract package — every slice
// imports it) refactored FIRST and alone, then the other domains' surface
// implementers in parallel (their trees are disjoint by construction), each
// verified per-domain with one bounded retry round, then — gates green and ≥ 1 item
// cleared — the round frozen as ONE `kind: refactor` spec (the route to /cohorte-review →
// /cohorte-ship, which ships specs, not backlogs) and the backlog ticked with its id.

export const meta = {
  name: 'cohorte-refactor',
  description: 'Apply the /cohorte-audit refactor backlog for big domains: shared first, then parallel surface implementers, per-domain verify + one retry',
  whenToUse: 'Only when the human explicitly asks for the refactor workflow on big domains. args = {domains: ["<surface key>", …] | "all"}.',
  phases: [
    { title: 'Profile', detail: 'PIPELINE.md → JSON via profile-reader', model: 'haiku' },
    { title: 'Backlog', detail: 'read the open items per requested domain', model: 'haiku' },
    { title: 'Shared', detail: 'refactor the contract package first, alone' },
    { title: 'Refactor', detail: 'one surface implementer per domain, parallel' },
    { title: 'Verify', detail: 'per-domain gates + item check, one retry round', model: 'haiku' },
    { title: 'Spec', detail: 'freeze the round as a kind: refactor spec for review → ship', model: 'haiku' },
    { title: 'Tick', detail: 'check cleared items off specs/refactor-backlog.md (· refactor:<id>)', model: 'haiku' },
  ],
}

// A domain below this many open items is not "big" — the conversational
// /cohorte-refactor handles it with less overhead than a workflow run.
const MIN_ITEMS = 5

// The Workflow runtime hands `args` to a script verbatim, so a caller that passes a
// JSON-ENCODED STRING instead of a real object gets that string back here. Parse it
// back into the object it was meant to be. A bare slug is shorthand for the DOMAIN in
// this script — mapping it to {feature, target} (review.js's keys, once copy-pasted
// here) left ARGS.domains undefined, which fell through to 'all': the shorthand
// "backend" dispatched code-editing implementers on EVERY big domain, not the one
// the caller named.
const ARGS = (() => {
  if (typeof args === 'string') {
    const t = args.trim()
    if (t.startsWith('{')) {
      try { const o = JSON.parse(t); if (o && typeof o === 'object' && !Array.isArray(o)) return o } catch {}
    }
    return { domains: [t] }
  }
  return args && typeof args === 'object' ? args : {}
})()

const wanted = (() => {
  const d = ARGS.domains
  if (!d || d === 'all') return 'all'
  return Array.isArray(d) ? d : [String(d)]
})()

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
  // The reader may also serialize each nested value while keeping the top level.
  const decode = o => Object.fromEntries(Object.entries(o).map(([k, v]) => {
    if (typeof v !== 'string' || !/^\s*[[{]/.test(v)) return [k, v]
    try {
      const parsed = JSON.parse(v)
      return [k, parsed && typeof parsed === 'object' ? parsed : v]
    } catch { return [k, v] }
  }))
  if (typeof p === 'string') { try { p = JSON.parse(p) } catch { return null } }
  if (!p || typeof p !== 'object' || Array.isArray(p)) return null
  const flat = decode(p)
  if (Array.isArray(flat.surfaces) || flat.error) return flat
  for (const v of Object.values(flat)) {
    if (!v || typeof v !== 'object' || Array.isArray(v)) continue
    const inner = decode(v)
    if (Array.isArray(inner.surfaces)) return inner
  }
  return flat
}

const OPEN = {
  type: 'object', required: ['domains'], additionalProperties: false,
  properties: {
    domains: {
      type: 'array',
      items: {
        type: 'object', required: ['key', 'items'], additionalProperties: false,
        properties: {
          key: { type: 'string' },
          items: { type: 'array', items: { type: 'string', description: 'the open `- [ ] …` line verbatim' } },
        },
      },
    },
  },
}

// The spec writer settles the id (the script has no clock — Date is unavailable in a
// workflow) and returns it; anything not shaped like a refactor id counts as a dead writer.
const SPEC = {
  type: 'object', required: ['id', 'branch'], additionalProperties: false,
  properties: {
    id: { type: 'string', description: 'refactor-<domains>-<YYYY-MM-DD>[-n], the spec file name without .md' },
    branch: { type: 'string', description: 'the branch checked out after step 3' },
    kanban: { type: 'string', description: 'the line kanban-move.sh printed' },
  },
}
const SPEC_ID = /^refactor-[a-z0-9][a-z0-9-]*$/

const VERIFY = {
  type: 'object', required: ['cleared', 'remaining', 'gatesGreen'], additionalProperties: false,
  properties: {
    cleared: { type: 'array', items: { type: 'string' } },
    remaining: { type: 'array', items: { type: 'string' } },
    gatesGreen: { type: 'boolean' },
    failures: { type: 'string', description: 'one line per gate failure, no output dumps' },
  },
}

// ── Phase 0 — profile ────────────────────────────────────────────────────────
phase('Profile')
const profile = unwrapProfile(await agent(
  'Return this project\'s profile (the `yaml pipeline-profile` block — `.claude/profile.json`, else PIPELINE.md) as JSON, per your instructions.',
  { agentType: 'cohorte-profile-reader', label: 'profile', schema: PROFILE, effort: 'low' },
))
if (!profile || profile.error) {
  return { error: `profile unreadable: ${(profile && profile.error) || 'profile-reader returned nothing'}` }
}
const surfaces = Array.isArray(profile.surfaces) ? profile.surfaces : []
// A profile with no surfaces cannot do this workflow's work, and every later
// guard compares against `surfaces` — an empty list makes them all vacuously
// pass. Fail loudly here instead of finishing with nothing done.
if (!surfaces.length) {
  return { error: 'profile has no surfaces — nothing would be refactored. the `yaml pipeline-profile` block in PIPELINE.md is empty or unparseable, or the profile-reader mis-returned; run /cohorte-doctor' }
}
const byKey = Object.fromEntries(surfaces.map(s => [s.key, s]))
const contractPath = (profile.contract && profile.contract.path) || ''
const base = (profile.vcs && profile.vcs.default_branch) || 'main'
const quiet = s => (s.test_quiet_cmd && !String(s.test_quiet_cmd).startsWith('<'))
  ? s.test_quiet_cmd : s.test_cmd ? `${s.test_cmd} 2>&1 | tail -40` : ''
const real = c => c && !String(c).startsWith('<')
// The `shared` domain (contract package / everything outside the surface trees) has no
// surface entry, so no per-surface commands — it used to verify with NO gates and report
// gatesGreen=true by default. Every slice imports it, so it is verified with the REPO-WIDE
// commands (profile.commands), which is what a change there can actually break.
const cmds = profile.commands || {}
const repoGates = [
  real(cmds.test_quiet) ? cmds.test_quiet : real(cmds.test) ? `${cmds.test} 2>&1 | tail -40` : '',
  real(cmds.lint_quiet) ? cmds.lint_quiet : real(cmds.lint) ? `${cmds.lint} 2>&1 | tail -40` : '',
  cmds.typecheck,
].filter(real)

// ── Phase 1 — read the open backlog ──────────────────────────────────────────
phase('Backlog')
const backlog = await agent(
  'Read specs/refactor-backlog.md and return, per `## <domain>` heading, the OPEN `- [ ] …` item lines ' +
  'verbatim (skip checked `- [x]` ones). File missing ⇒ return an empty domains array. ' +
  `Requested domains: ${wanted === 'all' ? 'all' : wanted.join(', ')} — return only those (all ⇒ every domain with open items).`,
  { model: 'haiku', label: 'read-backlog', schema: OPEN, effort: 'low' },
)
// A dead reader is not "the backlog is empty" — reporting it as such sends the
// human to re-run /cohorte-audit on a backlog that is already there.
if (!backlog) return { error: 'the backlog-reading agent died — nothing was read; re-run the refactor workflow' }
const open = (backlog.domains || []).filter(d => d.items.length)
if (!open.length) return { error: 'no open backlog items for the requested domains — run /cohorte-audit (or the audit workflow) first' }

const big = open.filter(d => d.items.length >= MIN_ITEMS)
const small = open.filter(d => d.items.length < MIN_ITEMS)
for (const d of small) log(`Skipping ${d.key} (${d.items.length} open item(s) < ${MIN_ITEMS}) — use the conversational /cohorte-refactor ${d.key}, it's cheaper`)
if (!big.length) return { skipped: Object.fromEntries(small.map(d => [d.key, d.items.length])), reason: `every requested domain is below the ${MIN_ITEMS}-item workflow threshold — use /cohorte-refactor` }

const implementPrompt = d =>
  'Refactor pass on your surface (no feature spec). Read PIPELINE.md first. Add the missing tests ' +
  'FIRST (pin current behavior / cover the entry points), watch them pass, THEN refactor to clear each ' +
  'item. Preserve current public behavior unless an item marks it a bug. Migrations stay additive. ' +
  `Need the current state of your tree? Compute it yourself: <core>/pipeline/scripts/feature-diff.sh --default ${base} --patch -- <your surface path> ` +
  '(<core> = the absolute path printed by `printf %s "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/cohorte"`. Run that lookup alone first (it does not count as any "one Bash call" below), then write the path out literally in every command: the gate denies a command name held in a variable; never a bare git diff — it hides files you created). ' +
  'Lint + format before handoff; return the handoff in the format your agent instructions define. ' +
  'Backlog items for YOUR surface (self-contained — clear exactly these, reading only the files they name):\n' +
  d.items.join('\n')

const verifyDomain = async (d, implHandoff) => {
  if (implHandoff == null) return { key: d.key, cleared: [], remaining: d.items, gatesGreen: false, failures: 'implementer died' }
  const s = byKey[d.key]
  const gateCmds = s ? [quiet(s), s.lint_quiet_cmd || (s.lint_cmd ? `${s.lint_cmd} 2>&1 | tail -40` : ''), s.typecheck_cmd]
    .filter(real) : d.key === 'shared' ? repoGates : []
  // No gates at all is not green: it is unverified. Say so instead of defaulting to true.
  const noGates = gateCmds.length === 0
  let v = await agent(
    `Verify a cohorte refactor round for domain ${d.key}. 1. Run these gates, each redirected to ` +
    `specs/reports/refactor-verify.${d.key}.txt (append) — never print their output: ` +
    `${noGates ? '(none declared — skip the gates; return gatesGreen=false and failures="no gate commands declared")' : gateCmds.map(c => JSON.stringify(c)).join(' · ')}. ` +
    '2. For EACH backlog item below, open its file:line and check the prescribed fix actually landed. ' +
    'Return the item lines split into cleared / remaining (verbatim), gatesGreen, and one line per gate failure.\n' +
    'Items:\n' + d.items.join('\n'),
    { model: 'haiku', label: `verify:${d.key}`, phase: 'Verify', schema: VERIFY, effort: 'low' },
  )
  if (v && noGates) v = { ...v, gatesGreen: false, failures: 'no gate commands declared for this domain — gates unverified' }
  // One bounded retry: re-dispatch the implementer on what verification rejected.
  // The re-verify covers ONLY the retried items, so round 1's cleared list is carried
  // forward — overwriting it un-ticked every item the first pass verified, and the
  // next /cohorte-refactor re-dispatched finished work.
  if (v && (v.remaining.length || (!v.gatesGreen && !noGates)) && byKey[d.key]) {
    const cleared1 = v.cleared || []
    // Never retry items round 1 already verified cleared: on a gates-red round with
    // nothing remaining, retrying ALL items put the same lines in both `cleared` and
    // `remaining` when the re-verifier died — ticked off the backlog AND reported open.
    const retryItems = v.remaining.length ? v.remaining : d.items.filter(i => !cleared1.includes(i))
    log(`${d.key}: ${v.remaining.length} item(s) remaining${v.gatesGreen ? '' : ' + red gates'} — one retry round`)
    await agent(
      implementPrompt({ key: d.key, items: retryItems }) + (v.failures ? `\nGate failures to clear too:\n${v.failures}` : ''),
      { agentType: byKey[d.key].agent, label: `retry:${d.key}`, phase: 'Refactor' },
    )
    const v2 = await agent(
      `Re-verify domain ${d.key} after a retry round — same procedure as before (gates redirected to ` +
      `specs/reports/refactor-verify.${d.key}.txt, per-item file:line check, verbatim cleared/remaining lines).\n` +
      'Items:\n' + retryItems.join('\n'),
      { model: 'haiku', label: `reverify:${d.key}`, phase: 'Verify', schema: VERIFY, effort: 'low' },
    )
    // A dead re-verifier loses only the RETRY round's claim — round 1's verified
    // clears stay cleared; the retried items stay open (unverified ≠ cleared).
    v = v2
      ? { ...v2, cleared: [...new Set(cleared1.concat(v2.cleared || []))] }
      : { cleared: cleared1, remaining: retryItems, gatesGreen: false, failures: 'verifier died on the retry round' }
    // The retry's verifier is asked the same question with no gates either — its
    // gatesGreen is no more evidence than round 1's was.
    if (noGates) v = { ...v, gatesGreen: false, failures: 'no gate commands declared for this domain — gates unverified' }
  }
  return { key: d.key, ...(v || { cleared: [], remaining: d.items, gatesGreen: false, failures: 'verifier died' }) }
}

// ── Phase 2 — `shared` first, alone (every slice imports the contract pkg) ───
const results = []
const shared = big.find(d => d.key === 'shared')
if (shared) {
  phase('Shared')
  const handoff = await agent(
    `Refactor the shared contract package (${contractPath || 'the tree outside every surface'}) of this ` +
    'cohorte project — normally lead-owned, so: additive changes only, never break a shape a surface ' +
    'imports (grep consumers before changing any export), migrations stay additive, lint + format before ' +
    'handoff. Clear exactly these open backlog items (self-contained; read only the files they name):\n' +
    shared.items.join('\n'),
    { label: 'refactor:shared', phase: 'Shared' },
  )
  results.push(await verifyDomain(shared, handoff))
}

// ── Phases 3+4 — the other domains in parallel, each verified as it lands ────
const rest = big.filter(d => d.key !== 'shared' && byKey[d.key])
for (const d of big) {
  if (d.key !== 'shared' && !byKey[d.key]) log(`Skipping ${d.key} — no matching surface in PIPELINE.md`)
}
const restResults = await pipeline(
  rest,
  d => agent(implementPrompt(d), { agentType: byKey[d.key].agent, label: `refactor:${d.key}`, phase: 'Refactor' }),
  (handoff, d) => verifyDomain(d, handoff),
)
results.push(...restResults.filter(Boolean))

// ── Phase 5 — freeze the round as a `kind: refactor` spec ────────────────────
// Without it the round is code in the working tree with no route to a PR. ONE spec for the
// whole round: review's diff, the freshness digest and the release commit all cover the
// whole tree, so a spec per domain would each claim the others' code. Red gates ⇒ no spec
// (review's preflight would abort it anyway) — finish the round first.
const clearedAll = results.flatMap(r => r.cleared)
const remainingAll = results.flatMap(r => r.remaining)
const gatesAllGreen = results.length > 0 && results.every(r => r.gatesGreen)
const clearedDomains = results.filter(r => r.cleared.length)
// Surface keys are free text (`web_checkout`, `API`); an id is a file name and a branch,
// and SPEC_ID below rejects anything else — so normalize here, not in the writer.
const idPart = k => String(k).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'domain'
const slug = clearedDomains.length > 3 ? 'all' : clearedDomains.map(r => idPart(r.key)).join('-')
const prefix = (profile.vcs && profile.vcs.feature_branch_prefix) || 'feature/'
const bare = l => String(l).replace(/^- \[[ x]\] /, '- ')
const specTitle = `Refactor ${slug} — ${clearedAll.length} backlog item(s)`
const specText = [
  '---',
  'feature_id: <ID>',
  'kind: refactor # behaviour-preserving backlog pass — no contract; commit as refactor(<scope>)',
  `title: ${specTitle}`,
  'status: frozen',
  `branch: ${prefix}<ID>`,
  'created: <DATE>',
  'reviewed_base:',
  'reviewed_digest:',
  '---',
  '',
  `# ${specTitle}`,
  '',
  '## 1. Goal',
  '',
  `Clear ${clearedAll.length} \`specs/refactor-backlog.md\` item(s) on ${clearedDomains.map(r => r.key).join(', ')} with no change of public behaviour.`,
  '',
  '## 2. Scope',
  '',
  '**In:** the §6 items, verbatim. **Out:** any behaviour change; the items §7 lists.',
  '',
  '## 6. Surface tasks',
  ...clearedDomains.flatMap(r => ['', `### ${r.key}`, '', ...r.cleared.map(bare)]),
  '',
  '## 7. Out of scope',
  '',
  ...(remainingAll.length ? remainingAll.map(l => `${bare(l)} (still open in the backlog)`) : ['none']),
  '',
  '## 9. Acceptance criteria / DoD',
  '',
  '- [ ] Public behaviour preserved — no exported signature, route, response shape, CLI flag or persisted format changed (unless an item marks it a bug)',
  '- [ ] Each §6 item cleared at its file:line',
  '- [ ] All tests green — behaviour pinned by tests added first; no existing test loosened',
  '- [ ] `PIPELINE.md` commands.lint · typecheck · test green',
  "- [ ] Nothing outside §6's surfaces changed",
  '',
  '## Remediation',
  '',
].join('\n')

let spec = null
const wantSpec = clearedAll.length > 0 && gatesAllGreen
if (wantSpec) {
  phase('Spec')
  const w = await agent(
    'Freeze this cohorte refactor round as a spec (mechanical — no judgment). ' +
    `0. ONE open refactor spec per branch: if \`git rev-parse --abbrev-ref HEAD\` is ${prefix}refactor-<x> and ` +
    'specs/refactor-<x>.md exists with `status:` frozen or in-review, then ID = refactor-<x>: append the §6 item ' +
    "lines below under their `### <domain>` headings there (add a heading if missing), skip to step 4. " +
    `1. Run \`date +%F\` ⇒ DATE; ID = refactor-${slug}-DATE. If specs/ID.md exists and its \`status:\` is ` +
    'shipped/merged/abandoned, suffix -2, -3… until the name is free. If it exists UNSHIPPED (frozen/in-review), ' +
    "do not overwrite it: append this round's §6 item lines under their `### <domain>` headings there and skip step 2. " +
    '2. Write specs/ID.md with EXACTLY the content below, every <ID> and <DATE> substituted. ' +
    `3. \`git rev-parse --abbrev-ref HEAD\`: on ${base} ⇒ \`git switch -c ${prefix}ID\` (uncommitted work carries over); ` +
    `already on ${prefix}ID ⇒ keep it; any other branch ⇒ leave it and report it. ` +
    `4. \`<core>/pipeline/scripts/kanban-move.sh auto ID ready --title "[refactor] ${slug}"\` ` +
    '(<core> = the absolute path printed by `printf %s "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/cohorte"`. Run that lookup alone first (it does not count as any "one Bash call" below), then write the path out literally in every command: the gate denies a command name held in a variable). ' +
    'Return id (ID), branch (checked out now) and kanban (the line the script printed).\n' +
    `<<<SPEC\n${specText}SPEC`,
    { model: 'haiku', label: 'write-spec', schema: SPEC, effort: 'low' },
  )
  spec = w && typeof w === 'object' && SPEC_ID.test(String(w.id || '')) ? w : null
}

// ── Phase 6 — tick the cleared items ─────────────────────────────────────────
phase('Tick')
let tickedOk = true
if (clearedAll.length) {
  const ticked = await agent(
    'In specs/refactor-backlog.md flip EXACTLY these open `- [ ]` item lines to `- [x]` (match verbatim, ' +
    (spec ? `append \` · refactor:${spec.id}\` to each flipped line, ` : '') +
    'leave every other line untouched), then return the single word done:\n' + clearedAll.join('\n'),
    { model: 'haiku', label: 'tick-backlog', effort: 'low' },
  )
  // Reporting items as cleared while the backlog still shows them open means the
  // next /cohorte-refactor re-dispatches work that is already done.
  tickedOk = ticked != null && /done/i.test(String(ticked))
}

const branchOk = spec && spec.branch === `${prefix}${spec.id}`
return {
  domains: Object.fromEntries(results.map(r => [r.key, {
    cleared: r.cleared.length, remaining: r.remaining.length, gatesGreen: r.gatesGreen,
  }])),
  skippedSmall: Object.fromEntries(small.map(d => [d.key, d.items.length])),
  stillOpen: results.flatMap(r => r.remaining.map(line => `[${r.key}] ${line}`)).slice(0, 15),
  backlogTicked: tickedOk,
  // Only a writer that came back with a well-formed id has its spec claimed.
  refactorSpec: spec ? `specs/${spec.id}.md` : null,
  next: !tickedOk
    ? `${clearedAll.length} item(s) were cleared in code but NOT ticked off specs/refactor-backlog.md ` +
      '(the ticking agent died) — tick them by hand, or the next /cohorte-refactor re-dispatches finished work'
    : wantSpec && !spec
      ? `the refactor spec was NOT written (the spec writer died) — the ${clearedAll.length} cleared item(s) have no ` +
        'route to a PR: write it per /cohorte-refactor §4, then /cohorte-review <id> → /cohorte-ship <id>'
      : spec
        ? `/cohorte-review ${spec.id} → /cohorte-ship ${spec.id}` +
          (branchOk ? '' : ` — but the checked-out branch is ${spec.branch || 'unknown'}, not ${prefix}${spec.id}: /cohorte-ship refuses it, switch first`) +
          (remainingAll.length ? ` (${remainingAll.length} item(s) still open, listed in its §7 — /cohorte-refactor <domain> appends them to this spec first, or ship without them)` : '')
        : 'items remain — finish them with the conversational /cohorte-refactor <domain> (gates must be green before the round gets a spec)',
}
