'use strict';
// Minimal block-YAML parser — just enough for the `yaml pipeline-profile` block in PIPELINE.md.
// Deliberately dependency-free (keeps the published package zero-dep). Handles:
//   key: value · nested maps (indent) · block sequences (- item / - key: val) ·
//   flow arrays [a, b] · flow maps { a: 1 } · quoted scalars (with \" \\ \n escapes) ·
//   #-comments · bool/int/float coercion · indentless sequences (`key:` then `- a` at the same
//   indent) · `|` / `>` block scalars.
// A `key: value` pair needs a colon followed by a space (or the end of the line), as in YAML:
// `- db:wipe` and `- http://x` are scalars, not one-key maps.
// NOT a general YAML implementation — anchors, tags, multi-document etc. are out of scope.

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
  if (v.length >= 2 && v[0] === '"' && v[v.length - 1] === '"') {
    return v.slice(1, -1).replace(/\\(["\\nt])/g, (_, c) => (c === 'n' ? '\n' : c === 't' ? '\t' : c));
  }
  if (v.length >= 2 && v[0] === "'" && v[v.length - 1] === "'") return v.slice(1, -1).replace(/''/g, "'");
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v === 'null' || v === '~') return null;
  if (/^-?\d+$/.test(v)) return parseInt(v, 10);
  if (/^-?\d+\.\d+$/.test(v)) return parseFloat(v);
  return v;
}

// Split "key: rest" on the first colon that is followed by a space or ends the line,
// outside quotes. A colon inside a value (a URL, `db:wipe`, a chained shell command) does
// not split. Callers never feed this a flow scalar (`[a, b]` / `{a: 1}`).
function keyValue(text) {
  let q = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === q) q = null; continue; }
    if (c === '"' || c === "'") { if (i === 0) q = c; continue; }
    if (c === ':' && (i + 1 === text.length || text[i + 1] === ' ')) {
      const key = text.slice(0, i).trim().replace(/^(["'])(.*)\1$/, '$2');
      return key ? { key, rest: text.slice(i + 1).trim() } : null;
    }
  }
  return null;
}

const DASH = /^-(?:(\s+)(.*))?$/;

function parse(text) {
  const lines = [];
  for (const raw of text.split(/\r?\n/)) {
    const stripped = stripComment(raw).replace(/\s+$/, '');
    if (stripped.trim() === '') { lines.push({ blank: true, indent: Infinity, text: '', raw }); continue; }
    lines.push({ indent: stripped.match(/^ */)[0].length, text: stripped.trim(), raw });
  }
  let pos = 0;
  const skipBlank = () => { while (pos < lines.length && lines[pos].blank) pos++; };

  // `|` keeps newlines, `>` folds them into spaces. Lines are taken RAW (comments are text).
  function blockScalar(indent, style) {
    const out = [];
    let base = null;
    while (pos < lines.length && (lines[pos].blank || lines[pos].indent > indent)) {
      const raw = lines[pos].raw.replace(/\s+$/, '');
      if (lines[pos].blank) out.push('');
      else {
        if (base === null) base = raw.match(/^ */)[0].length;
        out.push(raw.slice(Math.min(base, raw.match(/^ */)[0].length)));
      }
      pos++;
    }
    while (out.length && out[out.length - 1] === '') out.pop();
    return style.startsWith('|') ? out.join('\n') : out.join(' ').replace(/ {2,}/g, ' ').trim();
  }

  function block(indent) {
    skipBlank();
    const isSeq = DASH.test(lines[pos].text);
    const result = isSeq ? [] : {};
    while (pos < lines.length) {
      skipBlank();
      if (pos >= lines.length || lines[pos].indent < indent) break;
      if (lines[pos].indent > indent) { pos++; continue; } // defensive: skip stray deeper line
      const line = lines[pos];
      const dash = line.text.match(DASH);
      // A sequence ends at the first same-indent line that is not an item (an indentless
      // sequence is followed by the next key of its parent map), and vice versa.
      if (isSeq !== !!dash) break;

      if (dash) {
        const remainder = (dash[2] || '').trim();
        const itemIndent = indent + 1 + (dash[1] ? dash[1].length : 1);
        const kv = remainder && remainder[0] !== '[' && remainder[0] !== '{' ? keyValue(remainder) : null;
        if (!remainder) {
          pos++;
          skipBlank();
          result.push(pos < lines.length && lines[pos].indent > indent ? block(lines[pos].indent) : null);
        } else if (kv && /^[\w.-]+$/.test(kv.key)) {
          // A dash item that is `key: …` opens a nested map; realign so its keys share one indent.
          lines[pos] = { ...line, indent: itemIndent, text: remainder };
          result.push(block(itemIndent));
        } else {
          result.push(scalar(remainder));
          pos++;
        }
        continue;
      }

      const kv = keyValue(line.text);
      if (!kv) { pos++; continue; }
      pos++;
      if (/^[|>][-+]?$/.test(kv.rest)) { result[kv.key] = blockScalar(indent, kv.rest); continue; }
      if (kv.rest !== '') { result[kv.key] = scalar(kv.rest); continue; }
      skipBlank();
      if (pos < lines.length && lines[pos].indent > indent) result[kv.key] = block(lines[pos].indent);
      else if (pos < lines.length && lines[pos].indent === indent && DASH.test(lines[pos].text)) result[kv.key] = block(indent);
      else result[kv.key] = null;
    }
    return result;
  }

  skipBlank();
  return pos < lines.length ? block(lines[pos].indent) : {};
}

// Extract + parse the ```yaml pipeline-profile fenced block from a PIPELINE.md string.
function parseProfileBlock(md) {
  const m = md.match(/```yaml pipeline-profile\r?\n([\s\S]*?)\r?\n```/);
  if (!m) return null;
  return parse(m[1]);
}

// The exact bytes `cohorte sync` writes to `.claude/profile.json` for a PIPELINE.md string, or null
// when there is no block / it parses to nothing. One serializer, shared by sync (the writer) and
// doctor (the freshness check), so the two can never disagree about what "fresh" means.
function profileJsonText(md) {
  const profile = typeof md === 'string' ? parseProfileBlock(md) : null;
  if (!profile || typeof profile !== 'object' || Array.isArray(profile) || !Object.keys(profile).length) return null;
  return JSON.stringify(profile, null, 2) + '\n';
}

module.exports = { parse, parseProfileBlock, profileJsonText };
