'use strict';
// Freshness data: which core is installed where, and how it compares to npm latest.
// Dependency-free — reads VERSION files + the committed pointer, fetches the npm registry.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { layouts } = require('./runtime.js');

function readTrimmed(file) {
  try { return fs.readFileSync(file, 'utf8').trim(); } catch { return null; }
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

// Installed core in a given root (global ~/.claude or a repo's bundled .claude).
function coreAt(claudeDir) {
  const version = readTrimmed(path.join(claudeDir, 'pipeline', 'VERSION'));
  return { present: version != null, version, dir: claudeDir };
}

// The committed per-repo pointer (bundled mode); names the mode + core_version.
function pointerAt(projectRoot) {
  const ptr = readJson(path.join(projectRoot, '.claude', 'pipeline.json'));
  if (!ptr || typeof ptr !== 'object') return { present: false };
  return { present: true, mode: ptr.mode || null, core_version: ptr.core_version || null };
}

// Latest published version — registry fetch first, `npm view` as a fallback (it uses the
// user's configured registry/proxy, which works where a raw fetch may be blocked). Cached
// briefly so repeated calls don't hammer the network. null only if both fail.
let _cache = { value: null, at: 0 };
const CACHE_MS = 5 * 60 * 1000;
// Failures are cached too, briefly. Without this an offline machine paid the FULL
// 5s fetch timeout + 8s `npm view` timeout on every call — and /api/fleet calls
// this once per tracked project, so a batch of probes never finished.
const FAIL_CACHE_MS = 60 * 1000;

async function fetchRegistry(timeoutMs = 5000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch('https://registry.npmjs.org/cohorte/latest', {
      signal: ctrl.signal,
      headers: { accept: 'application/vnd.npm.install-v1+json' },
    });
    if (!res.ok) return null;
    const body = await res.json();
    return typeof body.version === 'string' ? body.version : null;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

// Fallback only — spawnSync blocks the single-threaded server for up to its
// timeout, so it must stay behind latestNpm()'s cache + in-flight dedupe (at most
// one call a minute, and only when the registry fetch already failed).
function npmView() {
  try {
    // One static string on Windows (npm is npm.cmd — needs a shell; the
    // shell+args-array combination is DEP0190-deprecated). Nothing dynamic.
    const r = process.platform === 'win32'
      ? spawnSync('npm view cohorte version', { encoding: 'utf8', timeout: 8000, shell: true })
      : spawnSync('npm', ['view', 'cohorte', 'version'], { encoding: 'utf8', timeout: 8000 });
    if (r.status === 0 && r.stdout) {
      const v = r.stdout.trim();
      return /^\d+\.\d+\.\d+/.test(v) ? v : null;
    }
  } catch { /* npm absent or slow */ }
  return null;
}

let _inflight = null;
// `opts` bounds what a CALLER is willing to pay for the answer. The CLI's staleness
// notice runs at the tail of an install, where the default 5s fetch + 8s `npm view`
// fallback would make an OFFLINE install appear to hang for 13 seconds after it had
// already succeeded — so it asks for a short fetch and no fallback. The cache is
// shared across callers either way: a cheap lookup still serves an expensive one.
async function latestNpm({ timeoutMs = 5000, fallback = true } = {}) {
  const age = Date.now() - _cache.at;
  if (_cache.at && age < (_cache.value ? CACHE_MS : FAIL_CACHE_MS)) return _cache.value;
  // /api/fleet resolves N projects concurrently — without this, N lookups race and
  // each pays the full timeout instead of sharing one.
  if (_inflight) return _inflight;
  _inflight = (async () => {
    try {
      const v = (await fetchRegistry(timeoutMs)) || (fallback ? npmView() : null);
      _cache = { value: v || null, at: Date.now() };
      return v || null;
    } finally {
      _inflight = null;
    }
  })();
  return _inflight;
}

// Naive semver compare — returns -1|0|1 (a<b|a==b|a>b). Ignores pre-release tags.
function cmpSemver(a, b) {
  if (!a || !b) return null;
  const pa = a.split('.').map(n => parseInt(n, 10) || 0);
  const pb = b.split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) < (pb[i] || 0)) return -1;
    if ((pa[i] || 0) > (pb[i] || 0)) return 1;
  }
  return 0;
}

async function versions({ projectRoot, globalDir, cliVersion }) {
  const global = coreAt(globalDir);
  let bundled = coreAt(path.join(projectRoot, '.claude'));
  const pointer = pointerAt(projectRoot);
  const latest = await latestNpm();

  // A non-Claude runtime keeps its core in `.cohorte/<id>/`, not `.claude/`. Probing only the
  // Claude path reported a perfectly installed Cursor/Codex/Gemini/OpenCode repo as having no
  // core at all — and every downstream check keys off `installMode`, so one wrong probe turned
  // the whole report red.
  if (!bundled.present) {
    const projectCore = layouts({ projectRoot, globalDir })
      .find(l => l.scope === 'project' && l.core.startsWith(projectRoot));
    if (projectCore) bundled = coreAt(projectCore.core);
  }

  // The core that actually serves this project: bundled wins if present, else global.
  const effective = bundled.present ? bundled : global.present ? global : null;
  const installedVersion = effective ? effective.version : null;
  const behind = cmpSemver(installedVersion, latest);

  return {
    cli: cliVersion,
    latest,
    global,
    bundled,
    pointer,
    installMode: bundled.present ? 'bundled' : global.present ? 'global' : 'none',
    installedVersion,
    // -1 behind, 0 up-to-date, 1 ahead of registry (dev), null unknown
    freshness: behind,
    // freshness of the GLOBAL core specifically (for the fleet banner, independent of project mode)
    globalFreshness: global.present ? cmpSemver(global.version, latest) : null,
  };
}

module.exports = { versions, latestNpm, cmpSemver };
