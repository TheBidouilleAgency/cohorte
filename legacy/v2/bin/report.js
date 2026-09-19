'use strict';
// Machine-readable reports for `cohorte specs` and `cohorte doctor`.
//
// Both commands read what lib/doctor.js computes (`scanSpecs` and `state`) and
// render it four ways:
//
//   default      a human table on a terminal
//   --porcelain  one record per line, fields separated by U+001F (the ASCII unit
//                separator) — stable, greppable, and immune to a spec title that
//                contains a space, a tab or a pipe
//   --json       the native document (the full doctor state, the spec list)
//   --panel      the payload shape a Francois extension panel validates against
//                (`{rows:[{key,value,tone}]}` / `{rows:[{id,cells,tone}]}`). This is
//                the ONLY Francois-aware surface in cohorte; everything else here is
//                generic. See github.com/TheBidouilleAgency/francois-plugin-cohorte.
//
// Dependency-free, and it never writes anything.

const US = String.fromCharCode(0x1f); // ASCII unit separator (U+001F)

// A spec's status → a display tone. The tones are the ones a status column can carry
// anywhere (terminal colour, panel row tone); `busy` marks the two statuses that mean
// "a command is mid-flight on this spec".
const STATUS_TONE = {
  draft: 'neutral',
  frozen: 'neutral',
  'in-progress': 'busy',
  'in-review': 'busy',
  shipped: 'ok',
  blocked: 'error',
};

// doctor's four check states → the same tone vocabulary. `skip` is not a failure:
// a check that does not apply to this project (no design system, no worktrees) reads
// neutral, never warn.
const CHECK_TONE = { ok: 'ok', warn: 'warn', bad: 'error', skip: 'neutral' };

// Collapse anything that would break the line format or a single-line cell. A spec
// title is free text written by a human in YAML frontmatter — it can contain a newline
// continuation, and it must never split one record into two. A stray separator inside a
// field goes the same way, and so does the padding a doctor `fix` carries for terminal
// alignment — in a one-line panel cell that padding reads as a hole.
function flat(value) {
  return String(value == null ? '' : value)
    .replace(new RegExp(`[\\s${US}]+`, 'g'), ' ')
    .trim();
}

function specRecords(projectRoot, scanSpecs) {
  return scanSpecs(projectRoot).map((s) => ({
    id: s.id,
    title: s.title || '',
    status: s.status || 'unknown',
    branch: s.branch || '',
    file: s.file,
    tone: STATUS_TONE[s.status] || 'warn', // an unknown status IS the warning
  }));
}

function specsPorcelain(records) {
  return records
    .map((r) => [r.id, r.title, r.status, r.branch, r.tone].map(flat).join(US))
    .join('\n');
}

function specsPanel(records) {
  return JSON.stringify({
    rows: records.map((r) => ({
      id: flat(r.id),
      tone: r.tone,
      cells: { id: flat(r.id), title: flat(r.title), status: flat(r.status), branch: flat(r.branch) },
    })),
  });
}

function specsHuman(records) {
  if (!records.length) return 'no specs in ./specs — /cohorte-spec writes the first one';
  const w = (k) => Math.max(...records.map((r) => flat(r[k]).length), k.length);
  const [wi, ws, wb] = [w('id'), w('status'), w('branch')];
  const head = `${'id'.padEnd(wi)}  ${'status'.padEnd(ws)}  ${'branch'.padEnd(wb)}  title`;
  const rows = records.map(
    (r) => `${flat(r.id).padEnd(wi)}  ${flat(r.status).padEnd(ws)}  ${flat(r.branch).padEnd(wb)}  ${flat(r.title)}`,
  );
  return [head, '-'.repeat(head.length), ...rows].join('\n');
}

function checkRecords(state) {
  return state.checks.map((c) => ({
    id: c.id,
    label: c.label,
    status: c.status,
    detail: c.detail,
    fix: c.fix || '',
    tone: CHECK_TONE[c.status] || 'neutral',
  }));
}

function doctorPorcelain(records) {
  return records
    .map((r) => [r.id, r.label, r.status, r.detail, r.fix].map(flat).join(US))
    .join('\n');
}

// key-value, one row per check: the check's label keyed against what it found. The fix
// rides in the value for a failing check — a panel row has nowhere else to put it, and
// a health report that says "broken" without saying "run this" is half a report.
function doctorPanel(records) {
  return JSON.stringify({
    rows: records.map((r) => ({
      key: flat(r.label),
      value: flat(r.fix && r.tone !== 'ok' ? `${r.detail} → ${r.fix}` : r.detail),
      tone: r.tone,
    })),
  });
}

function doctorHuman(state, records) {
  const mark = { ok: 'ok  ', warn: 'warn', bad: 'BAD ', skip: 'skip' };
  const lines = [`cohorte doctor — ${state.project}`, ''];
  for (const r of records) {
    lines.push(`${mark[r.status] || '?   '}  ${r.label} — ${flat(r.detail)}`);
    if (r.fix && r.status !== 'ok') lines.push(`        fix: ${flat(r.fix)}`);
  }
  const s = state.summary;
  lines.push('', `${s.ok} ok · ${s.warn} warn · ${s.bad} bad · ${s.skip} skipped`);
  return lines.join('\n');
}

module.exports = {
  US,
  STATUS_TONE,
  CHECK_TONE,
  specRecords,
  specsPorcelain,
  specsPanel,
  specsHuman,
  checkRecords,
  doctorPorcelain,
  doctorPanel,
  doctorHuman,
};
