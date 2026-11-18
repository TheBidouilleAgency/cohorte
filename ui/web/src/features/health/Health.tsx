import type { ProjectDetail } from '../../../../shared/api';
import { Cards, Pill, Stat, SectionTitle, Table, type PillTone } from '../../ui/primitives';

const tone = (s: string): PillTone => (s === 'ok' ? 'ok' : s === 'warn' ? 'warn' : s === 'bad' ? 'bad' : '');

export function Health({ d }: { d: ProjectDetail }) {
  const s = d.doctor.summary;
  return (
    <div>
      <Cards>{(['ok', 'warn', 'bad', 'skip'] as const).map((k) => <Stat key={k} value={s[k]} label={k} />)}</Cards>
      <SectionTitle>Checks</SectionTitle>
      <Table head={['Check', 'Status', 'Detail']}>
        {d.doctor.checks.map((c, i) => (
          <tr key={i}>
            <td>{c.label}</td>
            <td><Pill tone={tone(c.status)}>{c.status}</Pill></td>
            <td>{c.detail}{c.fix ? <div className="fix">{`fix: ${c.fix}`}</div> : null}</td>
          </tr>
        ))}
      </Table>
    </div>
  );
}
