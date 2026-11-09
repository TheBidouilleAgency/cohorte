'use strict';
// Minimal block-YAML parser — just enough for the `yaml pipeline-profile` block in PIPELINE.md.
// Deliberately dependency-free (keeps the published package zero-dep). Handles:
//   key: value · nested maps (indent) · block sequences (- item / - key: val) ·
//   flow arrays [a, b] · flow maps { a: 1 } · quoted scalars · #-comments · bool/int coercion.
// NOT a general YAML implementation — anchors, multi-line scalars, etc. are out of scope.

function stripComment(line) {
  let q = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === q) q = null; continue; }
    if (c === '"' || c === "'") { q = c; continue; }
    // A '#' starts a comment only at line start or after whitespace (YAML rule).
    if (c === '#' && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i);
  }
  return line;
}

function splitTopLevel(s) {
  const out = [];
  let depth = 0, q = null, cur = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { cur += c; if (c === q) q = null; continue; }
    if (c === '"' || c === "'") { q = c; cur += c; continue; }
    if (c === '[' || c === '{') { depth++; cur += c; continue; }
    if (c === ']' || c === '}') { depth--; cur += c; continue; }
    if (c === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim() !== '') out.push(cur);
  return out;
}

function scalar(raw) {
  const v = raw.trim();
  if (v === '') return null;
  if (v[0] === '[') {
    const inner = v.slice(1, v.lastIndexOf(']'));
    return inner.trim() === '' ? [] : splitTopLevel(inner).map(scalar);
  }
  if (v[0] === '{') {
    const inner = v.slice(1, v.lastIndexOf('}'));
    const obj = {};
    if (inner.trim() !== '') {
      for (const pair of splitTopLevel(inner)) {
        const idx = pair.indexOf(':');
        if (idx === -1) continue;
        obj[pair.slice(0, idx).trim()] = scalar(pair.slice(idx + 1));
      }
    }
    return obj;
  }
  if ((v[0] === '"' && v[v.length - 1] === '"') || (v[0] === "'" && v[v.length - 1] === "'")) {
    return v.slice(1, -1);
  }
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v === 'null' || v === '~') return null;
  if (/^-?\d+$/.test(v)) return parseInt(v, 10);
  return v;
}

// Split "key: rest" on the FIRST colon. A colon inside the value (a URL, a
// chained shell command) is therefore kept in `rest`, which is what we want;
// callers are responsible for not feeding this a flow scalar (`[a, b]` /
// `{a: 1}`) — the block parser checks the first character before calling.
function keyValue(text) {
  const idx = text.indexOf(':');
  if (idx === -1) return null;
  return { key: text.slice(0, idx).trim(), rest: text.slice(idx + 1).trim() };
}

function parse(text) {
  const lines = [];
  for (const raw of text.split('\n')) {
    const stripped = stripComment(raw).replace(/\s+$/, '');
    if (stripped.trim() === '') continue;
    lines.push({ indent: stripped.match(/^ */)[0].length, text: stripped.trim() });
  }

  let pos = 0;
  function block(indent) {
    const isSeq = lines[pos].text.startsWith('- ');
    const result = isSeq ? [] : {};
    while (pos < lines.length && lines[pos].indent >= indent) {
      if (lines[pos].indent > indent) { pos++; continue; } // defensive: skip stray deeper line
      const line = lines[pos];

      if (line.text.startsWith('- ')) {
        const remainder = line.text.slice(2).trim();
        const kv = keyValue(remainder);
        // A dash item that is `key: …` (not a flow scalar) opens a nested map.
        if (kv && remainder[0] !== '[' && remainder[0] !== '{' && /^[\w.-]+$/.test(kv.key)) {
          lines[pos] = { indent: indent + 2, text: remainder }; // realign so the item's keys share one indent
          result.push(block(indent + 2));
        } else {
          result.push(scalar(remainder));
          pos++;
        }
        continue;
      }

      const kv = keyValue(line.text);
      if (!kv) { pos++; continue; }
      if (kv.rest === '') {
        pos++;
        if (pos < lines.length && lines[pos].indent > indent) result[kv.key] = block(lines[pos].indent);
        else result[kv.key] = null;
      } else {
        result[kv.key] = scalar(kv.rest);
        pos++;
      }
    }
    return result;
  }

  return lines.length ? block(lines[0].indent) : {};
}

// Extract + parse the ```yaml pipeline-profile fenced block from a PIPELINE.md string.
function parseProfileBlock(md) {
  const m = md.match(/```yaml pipeline-profile\r?\n([\s\S]*?)\r?\n```/);
  if (!m) return null;
  return parse(m[1]);
}

module.exports = { parse, parseProfileBlock };
