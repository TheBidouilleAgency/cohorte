// The session token arrives in the URL hash (`#token=…`), is moved to sessionStorage and removed from the address bar.
export function readToken(): string | null {
  try {
    const m = /token=([0-9a-f]+)/.exec(location.hash);
    if (m) { sessionStorage.setItem('cohorte-token', m[1]); history.replaceState(null, '', location.pathname); }
    return sessionStorage.getItem('cohorte-token');
  } catch { return null; }
}
