import { describe, expect, it } from 'vitest';
import { classifyDiffLine } from './diff';

describe('classifyDiffLine', () => {
  it.each([
    ['@@ -1,2 +1,3 @@ fn', 'hunk'], ['+++ b/a.ts', 'meta'], ['--- a/a.ts', 'meta'], ['diff --git a/a b/a', 'meta'], ['index 1..2 100644', 'meta'],
    ['+added', 'add'], ['-removed', 'remove'], [' context', 'context'], ['', 'context'], ['\\ No newline at end of file', 'meta'],
  ])('%j → %s', (line, kind) => { expect(classifyDiffLine(line)).toBe(kind); });
});
