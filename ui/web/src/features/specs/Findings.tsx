import type { Finding, SpecDetail } from '../../../../shared/api';
import { countBySeverity, SEVERITY_ORDER } from '../../lib/reports';
import { Muted, Pill, Pre, SectionTitle, Table, type PillTone } from '../../ui/primitives';

const SEV_TONE: Record<string, PillTone> = { CRITICAL: 'bad', HIGH: 'bad', MEDIUM: 'warn', LOW: '' };

function Rows({ rows, deferred }: { rows: Finding[]; deferred: boolean }) {
  return (
    <Table head={['Severity', 'Location', 'Category', 'Problem', 'Fix', ...(deferred ? ['Out of scope'] : [])]}>
      {rows.map((f, i) => (
        <tr key={i}>
          <td><Pill tone={SEV_TONE[f.severity] ?? ''}>{f.severity.toLowerCase()}</Pill></td>
          <td className="mono nowrap">{f.file ? `${f.file}${f.line != null ? `:${f.line}` : ''}` : ''}</td>
          <td>{f.category}</td>
          <td>{f.problem}</td>
          <td>{f.fix}</td>
          {deferred ? <td className="muted">{f.outOfScope}</td> : null}
        </tr>
      ))}
    </Table>
  );
}

function Strip({ rows }: { rows: Finding[] }) {
  const c = countBySeverity(rows);
  return (
    <div className="sev-strip" aria-label="Findings by severity">
      {SEVERITY_ORDER.map((s) => <span key={s} className={`sev sev-${s.toLowerCase()}${c[s] ? '' : ' zero'}`}><strong>{c[s]}</strong> {s.toLowerCase()}</span>)}
    </div>
  );
}

/** The review's findings (parsed from specs/reports/<id>.md by the server), most severe first, plus the deferred ones and the raw report. */
export function Findings({ review }: { review: SpecDetail['review'] }) {
  const has = review.findings.length || review.deferred.length || review.raw;
  if (!has) return <><SectionTitle>Review findings</SectionTitle><Muted>No review report yet — /cohorte-review writes specs/reports/&lt;id&gt;.md.</Muted></>;
  return (
    <div>
      <SectionTitle>Review findings{review.verdict ? ` · ${review.verdict}` : ''}</SectionTitle>
      <Strip rows={review.findings} />
      {review.findings.length ? <Rows rows={review.findings} deferred={false} /> : <Muted>None.</Muted>}
      {review.deferred.length ? <><SectionTitle>Deferred ({review.deferred.length})</SectionTitle><Rows rows={review.deferred} deferred /></> : null}
      {review.raw ? <details className="disclose"><summary>Raw review report</summary><Pre>{review.raw}</Pre></details> : null}
    </div>
  );
}
