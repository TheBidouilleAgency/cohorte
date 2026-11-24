import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { identity } from './legacy';
import { requireIdentity } from './founding';

describe('git identity — classification', () => {
  it('flags an unset identity as missing', () => {
    expect(identity.classifyIdentity({ name: '', email: '' }).status).toBe('missing');
    expect(identity.classifyIdentity({ name: 'Ada', email: '' }).status).toBe('missing');
    expect(identity.classifyIdentity({ name: '', email: 'ada@example.com' }).status).toBe('missing');
  });
  it('flags hostname-derived emails as suspicious', () => {
    for (const e of ['enzo@Enzos-MBP.lan', 'enzo@Enzos-MacBook-Pro.local', 'me@box.localdomain', 'me@devbox', 'me@(none)', 'no-at-sign', 'me@']) {
      expect(identity.classifyIdentity({ name: 'Enzo', email: e }).status, e).toBe('suspicious');
    }
  });
  it('accepts real and GitHub no-reply addresses', () => {
    for (const e of ['ada@example.com', '46194336+EnzoTheBidouille@users.noreply.github.com', 'a.b@sub.corp.io']) {
      expect(identity.classifyIdentity({ name: 'Ada', email: e })).toEqual({ status: 'ok', reason: '' });
    }
  });
  it('derives the no-reply address from `gh api user`', () => {
    expect(identity.githubIdentityOf({ login: 'octo', id: 583231, name: 'Octo Cat' })).toEqual({ login: 'octo', name: 'Octo Cat', email: '583231+octo@users.noreply.github.com' });
    expect(identity.githubIdentityOf({ login: 'octo', id: 1, name: null })?.name).toBe('octo');
    expect(identity.githubIdentityOf({ login: 'octo' })).toBeNull();
    expect(identity.githubIdentityOf({ login: 'bad login', id: 1 })).toBeNull();
    expect(identity.githubIdentityOf('octo')).toBeNull();
  });
  it('quotes the fix command', () => {
    expect(identity.fixCommand('Ada "L"', 'a@b.io')).toBe('git config user.name "Ada \\"L\\"" && git config user.email "a@b.io"');
  });
});

describe('git identity — in a repository', () => {
  const saved: Record<string, string | undefined> = {};
  const keys = ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'EMAIL', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM'];
  let dir = '';
  beforeAll(() => {
    for (const k of keys) { saved[k] = process.env[k]; delete process.env[k]; }
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cohorte-identity-'));
    fs.writeFileSync(path.join(dir, 'empty.gitconfig'), '');
    process.env.GIT_CONFIG_GLOBAL = path.join(dir, 'empty.gitconfig');
    process.env.GIT_CONFIG_NOSYSTEM = '1';
    spawnSync('git', ['init', '-q', path.join(dir, 'repo')]);
  });
  afterAll(() => {
    for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reads nothing configured as missing, and the founding gate refuses', () => {
    const repo = path.join(dir, 'repo');
    expect(identity.readIdentity(repo).status).toBe('missing');
    expect(() => requireIdentity(repo)).toThrow(/git identity/);
  });
  it('refuses to set a hostname email, sets a real one repo-locally', () => {
    const repo = path.join(dir, 'repo');
    expect(() => identity.setIdentity(repo, 'Ada', 'ada@mac.lan')).toThrow(/local network/);
    const id = identity.setIdentity(repo, 'Ada', 'ada@example.com');
    expect(id).toMatchObject({ name: 'Ada', email: 'ada@example.com', status: 'ok' });
    expect(id.emailOrigin).toMatch(/\.git\/config/);
    expect(fs.readFileSync(path.join(dir, 'empty.gitconfig'), 'utf8')).toBe('');
    expect(requireIdentity(repo).email).toBe('ada@example.com');
  });
  it('honours GIT_AUTHOR_EMAIL over the config, like git', () => {
    process.env.GIT_AUTHOR_EMAIL = 'ci@runner';
    try { expect(identity.readIdentity(path.join(dir, 'repo'))).toMatchObject({ email: 'ci@runner', status: 'suspicious' }); }
    finally { delete process.env.GIT_AUTHOR_EMAIL; }
  });
});
