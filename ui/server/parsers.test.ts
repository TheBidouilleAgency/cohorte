import { describe, expect, it } from 'vitest';
import { parseShortstat, parseStatus } from './gitinfo';
import { urlsIn } from './jobs';
import { parsePs } from './docker';

describe('parseStatus', () => {
  it('reads branch, upstream, ahead/behind and counts', () => {
    const s = parseStatus('# branch.oid abc\n# branch.head feat/x\n# branch.upstream origin/feat/x\n# branch.ab +2 -1\n1 .M N... 100644 100644 100644 a b f.ts\n1 M. N... 100644 100644 100644 a b g.ts\n? new.txt\nu UU N... 1 1 1 1 a b c h.ts\n');
    expect(s).toMatchObject({ branch: 'feat/x', upstream: 'origin/feat/x', ahead: 2, behind: 1, modified: 1, staged: 1, untracked: 1, conflicted: 1 });
  });
  it('a detached head has no branch', () => { expect(parseStatus('# branch.head (detached)\n').branch).toBeNull(); });
});
describe('parseShortstat', () => {
  it('reads files and line counts', () => { expect(parseShortstat(' 3 files changed, 10 insertions(+), 2 deletions(-)')).toEqual({ files: 3, insertions: 10, deletions: 2 }); });
  it('handles a single file and only insertions', () => { expect(parseShortstat(' 1 file changed, 1 insertion(+)')).toEqual({ files: 1, insertions: 1, deletions: 0 }); });
  it('is zero for empty output', () => { expect(parseShortstat('')).toEqual({ files: 0, insertions: 0, deletions: 0 }); });
});
describe('urlsIn', () => {
  it('finds local urls, strips colour codes, maps 0.0.0.0', () => {
    expect(urlsIn(['  \u001b[32m➜\u001b[39m  Local:   http://localhost:5173/', 'listening on http://0.0.0.0:3333.', 'see https://example.com:443/x'])).toEqual(['http://localhost:5173/', 'http://localhost:3333']);
  });
});
describe('parsePs', () => {
  it('reads ndjson and arrays', () => {
    expect(parsePs('{"Service":"a"}\n{"Service":"b"}')).toHaveLength(2);
    expect(parsePs('[{"Service":"a"}]')).toHaveLength(1);
    expect(parsePs('')).toEqual([]);
  });
});
