// Hash routing: `#/` is Home, `#/p/<projectId>[/<tab>]` a project's tab. The session token is moved out of the hash
// (into sessionStorage) before anything here runs — see lib/token.ts — so the hash is free for navigation.

export interface Route { projectId: string | null; tab: string | null }

const ID = /^[0-9a-f]{10}$/;

export function parseRoute(hash: string, tabs: readonly string[]): Route {
  const m = /^#\/p\/([^/?#]+)(?:\/([^/?#]+))?/.exec(hash);
  if (!m || !ID.test(m[1])) return { projectId: null, tab: null };
  return { projectId: m[1], tab: m[2] && tabs.includes(m[2]) ? m[2] : null };
}

export function buildRoute(projectId: string | null, tab: string | null): string {
  if (!projectId) return '#/';
  return tab && tab !== 'overview' ? `#/p/${projectId}/${tab}` : `#/p/${projectId}`;
}
