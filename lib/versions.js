'use strict';
// Freshness data: which core is installed where, and how it compares to npm latest.
// Dependency-free — reads VERSION files + the committed pointer, fetches the npm registry.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function readTrimmed(file) {
  try { return fs.readFileSync(file, 'utf8').trim(); } catch { return null; }
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

// A core rooted at `dir` (its `pipeline/VERSION`). 3.x: `<globalDir>/cohorte`. 2.x left one
// straight in `<globalDir>` (global mode) or in a repo's `.claude` (bundled mode).
function coreAt(dir) {
  const version = readTrimmed(path.join(dir, 'pipeline', 'VERSION'));
  return { present: version != null, version, dir };
}

// The committed per-repo pointer; names the core_version (and, on a 2.x repo, a mode).
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
  // Opt-out honoured by every caller (install notice, doctor, panels): offline machines and CI.
  if (process.env.COHORTE_NO_VERSION_CHECK) return null;
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

// Semver compare — returns -1|0|1 (a<b|a==b|a>b). A pre-release sorts before its release
// (3.0.0-dev.8 < 3.0.0), and between pre-releases the tags compare as strings.
function cmpSemver(a, b) {
  if (!a || !b) return null;
  const split = (v) => { const [core, pre] = String(v).split('-', 2); return [core.split('.').map(n => parseInt(n, 10) || 0), pre || null]; };
  const [pa, ra] = split(a);
  const [pb, rb] = split(b);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) < (pb[i] || 0)) return -1;
    if ((pa[i] || 0) > (pb[i] || 0)) return 1;
  }
  if (ra === rb) return 0;
  if (!ra) return 1;
  if (!rb) return -1;
  return ra < rb ? -1 : 1;
}

async function versions({ projectRoot, globalDir, cliVersion, offline = false }) {
  const global = coreAt(path.join(globalDir, 'cohorte'));
  const pointer = pointerAt(projectRoot);
  const latest = offline ? null : await latestNpm();
  // 2.x layouts, reported so doctor can name the migration — never used to serve the project.
  const legacyGlobal = coreAt(globalDir);
  const legacyBundled = coreAt(path.join(projectRoot, '.claude'));

  const installedVersion = global.present ? global.version : null;
  return {
    cli: cliVersion,
    latest,
    global,
    // Kept for consumers of `doctor --json` (the Francois panel): 3.x has no bundled core.
    bundled: { present: false, version: null, dir: path.join(projectRoot, '.claude') },
    legacy: { global: legacyGlobal, bundled: legacyBundled },
    pointer,
    installMode: global.present ? 'global' : 'none',
    installedVersion,
    // -1 behind, 0 up-to-date, 1 ahead of registry (dev), null unknown
    freshness: cmpSemver(installedVersion, latest),
    globalFreshness: global.present ? cmpSemver(global.version, latest) : null,
  };
}

module.exports = { versions, latestNpm, cmpSemver };
