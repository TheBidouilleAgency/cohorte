import { useEffect, useState, type FormEvent } from 'react';
import type { FoundingView } from '../../../../shared/api';
import { loadIdentity, setIdentity, useFounding } from '../../store/founding';
import { Button, Card, Muted, Pill } from '../../ui/primitives';

/**
 * Who cohorte's commits in this folder will be authored by — asked before the first one. Without a configured
 * `user.email`, git signs them `<os user>@<hostname>` and the code host cannot link them to an account; fixing that
 * afterwards is a history rewrite. Set here for this repository only (`git config`, never `--global`).
 */
export function IdentityCard({ f }: { f: FoundingView }) {
  const info = useFounding((s) => (s.identityFor === f.projectId ? s.identity : null));
  const bad = !!f.identity && f.identity.status !== 'ok';
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  useEffect(() => { if (bad) void loadIdentity(); }, [bad, f.projectId]);
  useEffect(() => { if (f.identity && !name) setName(f.identity.name); }, [f.identity?.name]);
  if (!bad || !f.identity) return null;
  const gh = info?.github ?? null;
  const submit = (e: FormEvent) => { e.preventDefault(); if (name.trim() && email.trim()) void setIdentity({ source: 'manual', name: name.trim(), email: email.trim() }); };
  return (
    <Card tone="warn" className="checkpoint">
      <div className="plan-head"><Pill tone="warn">Git identity · needed before the first commit</Pill></div>
      <div className="pre-wrap">{f.identity.reason}{f.identity.effective ? <> — commits would be authored <span className="mono">{f.identity.effective}</span>, which your code host cannot link to you.</> : '.'}</div>
      {gh ? (
        <div className="actions">
          <Button variant="primary" onClick={() => void setIdentity({ source: 'github' })}>{`Use my GitHub identity — ${gh.name} <${gh.email}>`}</Button>
        </div>
      ) : info ? <Muted>{!info.gh.installed ? 'The GitHub CLI is not installed — type the name and email your code host knows.' : 'gh is not signed in (gh auth login) — type the name and email your code host knows.'}</Muted> : <Muted>Looking for your GitHub identity…</Muted>}
      <form onSubmit={submit} className="row-form wrap gap-top">
        <input value={name} onChange={(e) => setName(e.target.value)} aria-label="Author name" placeholder="Your name" />
        <input value={email} onChange={(e) => setEmail(e.target.value)} aria-label="Author email" placeholder="the email your code host knows" type="email" />
        <Button type="submit" disabled={!name.trim() || !email.trim()}>Use this identity</Button>
      </form>
      <Muted>Set for this project only (<span className="mono">git config user.name / user.email</span> in its folder). Nothing is committed until it is set.</Muted>
    </Card>
  );
}
