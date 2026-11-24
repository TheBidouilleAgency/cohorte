'use strict';
// The git identity a commit in a repository would carry, and whether it is one a code host can link to an
// account. With no `user.email` configured, git falls back to `<os user>@<hostname>` (e.g. enzo@Enzos-MBP.lan):
// the commit goes through, the host cannot attribute it, and fixing it later means rewriting history.
// Shared by `cohorte doctor` (lib/doctor.js) and cohorte ui's founding flow (ui/server/founding.ts).

const { spawnSync } = require('child_process');

// Domains a machine gives itself, never a mailbox: the hostname git invents when nothing is configured.
const LOCAL_TLD = /\.(local|lan|localdomain|localhost)$/i;

/** Why an email cannot be a real author address, or null when it looks like one. Pure. */
function suspiciousEmail(email) {
  const e = String(email || '').trim();
  if (!e) return 'no email';
  const at = e.lastIndexOf('@');
  if (at <= 0 || at === e.length - 1) return `"${e}" is not an email address`;
  const domain = e.slice(at + 1);
  if (domain === '(none)') return `"${e}" has no domain`;
  if (!domain.includes('.')) return `"${e}" has no dot in its domain — git made it from the machine's hostname`;
  if (LOCAL_TLD.test(domain)) return `"${e}" is a local network name — git made it from the machine's hostname`;
  return null;
}

/**
 * Classify an identity read from git. Pure.
 * `name` / `email` are what `git config` returns (empty when unset); `effective` is what git would actually write
 * (`git var GIT_AUTHOR_IDENT`), which includes the invented fallback.
 * → { status: 'ok' | 'missing' | 'suspicious', reason }
 */
function classifyIdentity({ name, email }) {
  const n = String(name || '').trim();
  const e = String(email || '').trim();
  if (!e && !n) return { status: 'missing', reason: 'no user.name and no user.email are set — git would invent one from the OS user and hostname' };
  if (!e) return { status: 'missing', reason: 'user.email is not set — git would invent one from the OS user and hostname' };
  const bad = suspiciousEmail(e);
  if (bad) return { status: 'suspicious', reason: bad };
  if (!n) return { status: 'missing', reason: 'user.name is not set — git would use the OS account name' };
  return { status: 'ok', reason: '' };
}

const git = (cwd, args) => spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 10000 });

/** One config key's value and where it comes from (`file:/Users/x/.gitconfig`, `command line:`…), or empty. */
function configWithOrigin(cwd, key) {
  const r = git(cwd, ['config', '--show-origin', '--get', key]);
  if (r.status !== 0 || !r.stdout) return { value: '', origin: '' };
  const line = r.stdout.replace(/\r?\n$/, '');
  const tab = line.indexOf('\t');
  return tab < 0 ? { value: line.trim(), origin: '' } : { value: line.slice(tab + 1).trim(), origin: line.slice(0, tab) };
}

/**
 * The identity git would use for a commit in `cwd` — evaluated in that repository, so conditional includes
 * (`includeIf "gitdir:…"`) apply — in git's own order: GIT_AUTHOR_* env, `author.*`, `user.*`, then $EMAIL.
 * Anything past that is what git invents from the OS account and the hostname: missing.
 * → { name, email, nameOrigin, emailOrigin, effective, status, reason }
 */
function readIdentity(cwd) {
  const env = process.env;
  const pick = (envKey, keys, fallbackEnv) => {
    if (env[envKey]) return { value: env[envKey], origin: `environment (${envKey})` };
    for (const k of keys) { const c = configWithOrigin(cwd, k); if (c.value) return { value: c.value, origin: c.origin || k }; }
    if (fallbackEnv && env[fallbackEnv]) return { value: env[fallbackEnv], origin: `environment (${fallbackEnv})` };
    return { value: '', origin: '' };
  };
  const name = pick('GIT_AUTHOR_NAME', ['author.name', 'user.name']);
  const email = pick('GIT_AUTHOR_EMAIL', ['author.email', 'user.email'], 'EMAIL');
  const v = git(cwd, ['var', 'GIT_AUTHOR_IDENT']);
  const effective = v.status === 0 ? (v.stdout || '').trim().replace(/\s+\d+\s+[+-]\d{4}$/, '') : '';
  const id = { name: name.value, email: email.value, nameOrigin: name.origin, emailOrigin: email.origin, effective };
  return { ...id, ...classifyIdentity(id) };
}

/** The GitHub no-reply address of a `gh api user` record — linked to the account, never exposes a mailbox. Pure. */
function githubIdentityOf(user) {
  if (!user || typeof user !== 'object') return null;
  const login = typeof user.login === 'string' ? user.login.trim() : '';
  const id = Number(user.id);
  if (!/^[A-Za-z0-9-]{1,39}$/.test(login) || !Number.isInteger(id) || id <= 0) return null;
  const name = typeof user.name === 'string' && user.name.trim() ? user.name.trim().slice(0, 100) : login;
  return { login, name, email: `${id}+${login}@users.noreply.github.com` };
}

/** The signed-in GitHub account's identity through `gh` (sync; the CLI's use), or null. */
function githubIdentity(cwd, ghBin = process.env.COHORTE_GH_BIN || 'gh') {
  const r = spawnSync(ghBin, ['api', 'user'], { cwd, encoding: 'utf8', timeout: 10000, env: { ...process.env, GH_PROMPT_DISABLED: '1' } });
  if (r.status !== 0) return null;
  try { return githubIdentityOf(JSON.parse(r.stdout)); } catch { return null; }
}

/** The exact commands that set an identity for this repository only. */
function fixCommand(name, email) {
  const q = s => `"${String(s).replace(/(["\\$`])/g, '\\$1')}"`;
  return `git config user.name ${q(name)} && git config user.email ${q(email)}`;
}

/** Set the identity in `cwd`'s own .git/config (never --global). Throws on a value git refuses or an unusable one. */
function setIdentity(cwd, name, email) {
  const n = String(name || '').trim();
  const e = String(email || '').trim();
  if (!n || n.length > 200 || /[\r\n<>]/.test(n)) throw new Error('the name is required (no <, > or line breaks)');
  if (e.length > 254 || /[\s<>]/.test(e)) throw new Error('the email has no spaces, < or >');
  const bad = suspiciousEmail(e);
  if (bad) throw new Error(`${bad} — use the address your code host knows`);
  for (const [k, v] of [['user.name', n], ['user.email', e]]) {
    const r = git(cwd, ['config', '--local', k, v]);
    if (r.status !== 0) throw new Error(`git config ${k} failed: ${(r.stderr || '').trim()}`);
  }
  return readIdentity(cwd);
}

module.exports = { suspiciousEmail, classifyIdentity, readIdentity, githubIdentityOf, githubIdentity, fixCommand, setIdentity };
