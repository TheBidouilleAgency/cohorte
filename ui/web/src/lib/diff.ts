export type DiffKind = 'add' | 'remove' | 'hunk' | 'meta' | 'context';

/** Colouring class of one line of a unified diff. `+++`/`---` headers are meta, not additions. */
export function classifyDiffLine(line: string): DiffKind {
  if (line.startsWith('@@')) return 'hunk';
  if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('new file') || line.startsWith('deleted file') || line.startsWith('similarity') || line.startsWith('rename ') || line.startsWith('\\ No newline')) return 'meta';
  if (line.startsWith('+')) return 'add';
  if (line.startsWith('-')) return 'remove';
  return 'context';
}
