import { createApprovalService } from '@cohorte/core/approvals';
import { describe, expect, test } from 'vitest';

describe('approvals', () => {
  test('the approval service factory is present at the core boundary', () => {
    expect(createApprovalService).toBeTypeOf('function');
  });
});
