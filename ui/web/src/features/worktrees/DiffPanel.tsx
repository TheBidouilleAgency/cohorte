import { classifyDiffLine } from '../../lib/diff';
import { closeDiff, openFileDiff, useDiff } from '../../store/git';
import { Button, Muted, SectionTitle } from '../../ui/primitives';

const BADGE: Record<string, string> = { added: 'A', modified: 'M', deleted: 'D', renamed: 'R', copied: 'C', untracked: '?', changed: 'T' };

/** Files changed in a worktree against the default branch, and one file's unified diff. Diff text is data: text nodes only. */
export function DiffPanel() {
  const { wt, base, files, file, error } = useDiff();
  if (!wt) return null;
  const lines = file ? file.diff.split('\n') : [];
  return (
    <section className="diff-panel" aria-label="Diff">
      <SectionTitle>{`Diff · ${wt.split(/[\\/]/).pop()} vs ${base ?? 'HEAD'} `}<Button onClick={closeDiff}>Close</Button></SectionTitle>
      {error ? <div className="error" role="alert">{error}</div> : null}
      {!files ? <Muted>Loading…</Muted> : !files.length ? <Muted>No changed files.</Muted> : (
        <div className="diff-grid">
          <ul className="file-list" aria-label="Changed files">
            {files.map((f) => (
              <li key={f.path}>
                <button type="button" className={`file${file?.file === f.path ? ' sel' : ''}`} onClick={() => void openFileDiff(f.path)}>
                  <span className={`badge badge-${f.status}`} title={f.status}>{BADGE[f.status] ?? '·'}</span><span className="mono">{f.path}</span>
                </button>
              </li>
            ))}
          </ul>
          <div className="diff-view">
            {!file ? <Muted>Pick a file.</Muted> : (
              <pre className="diff" aria-label={`Diff of ${file.file}`}>
                {lines.map((l, i) => <div key={i} className={`dl dl-${classifyDiffLine(l)}`}>{l || ' '}</div>)}
                {file.truncated ? <div className="dl dl-meta">… diff truncated</div> : null}
              </pre>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
