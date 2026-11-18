import { useEffect } from 'react';
import { titleFor } from '../../lib/notify';
import { pendingTotal, useActivity } from '../../store/activity';

/** "(2) Cohorte" in the tab title while approvals wait. */
export function TitleBadge() {
  const n = useActivity((s) => pendingTotal(s.items));
  useEffect(() => { document.title = titleFor(n); }, [n]);
  return null;
}
