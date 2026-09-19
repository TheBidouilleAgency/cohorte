import type { FakeAgentRule, FakeScript } from './index.ts';

/**
 * What a rule is matched against: `SpawnRequest` fields, plus `attempt`, which the fake derives from the requests it
 * has seen (a spawn without `continuation` opens an attempt, DESIGN 2.5 `retrying`). No phase, no pipeline word (R10).
 */
export interface FakeMatchSubject {
  role: string;
  agentId: string;
  incarnation: number;
  attempt: number;
}

/** `*` is any run of characters, `?` is one character, everything else is literal. */
export function globToRegExp(glob: string): RegExp {
  const source = glob.replace(/[.+^${}()|[\]\\*?]/g, (char) => {
    if (char === '*') return '.*';
    if (char === '?') return '.';
    return `\\${char}`;
  });
  return new RegExp(`^${source}$`, 's');
}

/** The FIRST rule whose every present field agrees; an absent field, and `incarnation: 'any'`, constrain nothing. */
export function matchFakeRule(script: FakeScript, subject: FakeMatchSubject): FakeAgentRule | undefined {
  return script.agents.find(({ match }) => {
    if (match.role !== undefined && match.role !== subject.role) return false;
    if (match.agentId !== undefined && !globToRegExp(match.agentId).test(subject.agentId)) return false;
    if (match.incarnation !== undefined && match.incarnation !== 'any' && match.incarnation !== subject.incarnation)
      return false;
    if (match.attempt !== undefined && match.attempt !== subject.attempt) return false;
    return true;
  });
}
