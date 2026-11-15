// Minimal YAML reader and writer for the block-style subset that Helm and this
// repository use: Chart.yaml, and charts.lock.yaml.
//
// Supports block maps, block sequences of scalars or maps, quoted scalars, flow
// sequences and maps, plain multi-line scalars, | and > block scalars, null and
// booleans. It does not support anchors, tags or multi-document streams, none of
// which appear in helm index files or Chart.yaml.
//
// All scalars resolve to strings. Numbers are never coerced, so "1.10" and "1.1"
// cannot collide the way JSON numbers would.
//
// This file has no dependencies so that `node tools/fetch-charts.mjs` runs
// anywhere Node is installed, including Git Bash on Windows.

export function parse(text) {
  return new Reader(text).doc();
}

class Reader {
  constructor(text) {
    this.lines = [];
    for (const raw of String(text).replace(/\t/g, '    ').split('\n')) {
      const line = raw.replace(/\r$/, '');
      const stripped = stripComment(line);
      if (stripped.trim() === '') continue;
      this.lines.push({
        indent: line.match(/^ */)[0].length,
        raw: stripped,
        body: stripped.trim(),
      });
    }
    this.i = 0;
  }

  peek() { return this.lines[this.i]; }

  doc() { return this.block(0); }

  block(indent) {
    const p = this.peek();
    if (!p || p.indent < indent) return null;
    if (isSeq(p.body)) return this.seq(p.indent);
    return this.map(p.indent);
  }

  seq(indent) {
    const out = [];
    while (this.peek() && this.peek().indent === indent && isSeq(this.peek().body)) {
      const dashIndent = this.peek().indent;
      const body = this.peek().body === '-' ? '' : this.peek().body.slice(2).trim();
      const contIndent = dashIndent + 2;
      this.i++;
      if (body === '') {
        const nxt = this.peek();
        out.push(nxt && nxt.indent > dashIndent ? this.block(nxt.indent) : null);
        continue;
      }
      const kv = splitKV(body);
      if (!kv) { out.push(scalar(body)); continue; }

      // A map that starts on the dash line. Later keys of the same item sit at
      // contIndent, two columns past the dash.
      const item = {};
      const put = (key, rawVal) => {
        if (isBlockMarker(rawVal)) item[key] = this.blockScalar(contIndent, rawVal);
        else if (rawVal === '') {
          const nxt = this.peek();
          if (nxt && nxt.indent > contIndent) item[key] = this.block(nxt.indent);
          else if (nxt && nxt.indent === contIndent && isSeq(nxt.body)) item[key] = this.seq(contIndent);
          else item[key] = null;
        } else item[key] = this.folded(contIndent, scalar(rawVal));
      };
      put(kv[0], kv[1]);
      while (this.peek() && this.peek().indent === contIndent && !isSeq(this.peek().body)) {
        const p = this.peek();
        const cont = splitKV(p.body);
        if (!cont) { this.i++; continue; }
        this.i++;
        put(cont[0], cont[1]);
      }
      out.push(item);
    }
    return out;
  }

  map(indent) {
    const out = {};
    while (this.peek() && this.peek().indent === indent) {
      const p = this.peek();
      const kv = splitKV(p.body);
      if (!kv) { this.i++; continue; }
      this.i++;
      const [k, v] = kv;
      if (isBlockMarker(v)) out[k] = this.blockScalar(indent, v);
      else if (v === '') {
        const nxt = this.peek();
        if (nxt && nxt.indent > indent) out[k] = this.block(nxt.indent);
        else if (nxt && nxt.indent === indent && isSeq(nxt.body)) out[k] = this.seq(indent);
        else out[k] = null;
      } else out[k] = this.folded(indent, scalar(v));
    }
    return out;
  }

  blockScalar(indent, marker = '|') {
    const fold = marker.startsWith('>');
    const chomp = marker.endsWith('-') ? 'strip' : marker.endsWith('+') ? 'keep' : 'clip';
    const lines = [];
    let base = null;
    while (this.peek() && this.peek().indent > indent) {
      const p = this.peek();
      if (base === null) base = p.indent;
      lines.push(p.raw.slice(base));
      this.i++;
    }
    if (!lines.length) return '';
    const text = fold ? lines.join(' ').replace(/ {2,}/g, ' ') : lines.join('\n');
    if (chomp === 'strip') return text;
    return text + '\n';
  }

  // A plain scalar may keep going on the next more-indented lines, where each
  // newline folds into one space. Nothing can nest under a scalar value, so
  // every deeper line is a continuation.
  folded(indent, value) {
    if (value === null) return null;
    let v = value;
    while (this.peek() && this.peek().indent > indent) {
      const p = this.peek();
      if (isSeq(p.body) || isBlockMarker(p.body)) break;
      v = typeof v === 'string' ? v + ' ' + p.body : p.body;
      this.i++;
    }
    return typeof v === 'string' ? v.replace(/ {2,}/g, ' ') : v;
  }
}

function isSeq(body) { return body === '-' || body.startsWith('- '); }
function isBlockMarker(v) { return /^\||>[-+]?[0-9]*$/.test(v); }

function stripComment(line) {
  let q = null, out = '';
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { out += c; if (c === q) q = null; continue; }
    if (c === '"' || c === "'") { q = c; out += c; continue; }
    if (c === '#' && (i === 0 || /\s/.test(line[i - 1]))) break;
    out += c;
  }
  return out.replace(/\s+$/, '');
}

// Return [key, value] for a block-style `key: value`, else null. The key is the
// text before the first colon that is followed by a space or the line end, so a
// value such as https://example.test is read as one scalar.
export function splitKV(body) {
  let q = null;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (q) { if (c === q) q = null; continue; }
    if (c === '"' || c === "'") { q = c; continue; }
    if (c !== ':') continue;
    const key = body.slice(0, i).trim();
    const rest = body.slice(i + 1);
    if (!key) continue;
    if (key.includes(':') && !/^["']/.test(key)) continue;
    if (rest !== '' && rest[0] !== ' ' && rest[0] !== '\t') continue;
    return [unquote(key), rest.trim()];
  }
  return null;
}

function unquote(s) {
  if (s.length > 1 && ((s[0] === '"' && s.endsWith('"')) || (s[0] === "'" && s.endsWith("'")))) {
    const body = s.slice(1, -1);
    return s[0] === '"'
      ? body.replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\')
      : body.replace(/''/g, "'");
  }
  return s;
}

export function scalar(v) {
  if (v === '' || v === '~' || v === 'null') return null;
  if (v.length > 1 && ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'")))) return unquote(v);
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v.startsWith('[') && v.endsWith(']')) return flow(splitFlow(v.slice(1, -1)), true);
  if (v.startsWith('{') && v.endsWith('}')) return flow(splitFlow(v.slice(1, -1)), false);
  return v;
}

function flow(parts, isSeqLike) {
  if (isSeqLike) return parts.filter((s) => s.trim() !== '').map((s) => scalar(s.trim()));
  const out = {};
  for (const p of parts) {
    const i = p.indexOf(':');
    if (i < 0) continue;
    out[unquote(p.slice(0, i).trim())] = scalar(p.slice(i + 1).trim());
  }
  return out;
}

function splitFlow(s) {
  const body = s.startsWith('[') ? s.slice(1, -1) : s;
  const out = [];
  let depth = 0, q = null, cur = '';
  for (const c of body) {
    if (q) { cur += c; if (c === q) q = null; continue; }
    if (c === '"' || c === "'") { q = c; cur += c; continue; }
    if (c === '[' || c === '{') depth++;
    if (c === ']' || c === '}') depth--;
    if (c === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

// ---------- writer ----------

// A plain scalar needs quotes when it starts with a YAML indicator, holds a
// colon or hash followed by a space, has outer spaces, or looks like a number,
// bool or null. A url is plain, because ":" is not followed by a space there.
const INDICATOR = /^[-?:\[\]{}&*!|>'"%@#]/;
const DOT_RUN = /^\.\.|^\.\.\.$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}([T ].*)?$/;
const LOOKS_TYPED = /^(true|false|null|~|yes|no|on|off)$/i;
const LOOKS_NUMBER = /^[-+]?(\d[d_]*\.?\d*|\.\d+)([eE][-+]?\d+)?$/;
const LOOKS_NUMBER2 = /^0[oobx][0-9a-f_]+$/i;
function needsQuote(s) {
  if (s === '') return true;
  if (INDICATOR.test(s)) return true;
  if (/^\s|\s$/.test(s)) return true;
  if (/: | #/g.test(s) || s.endsWith(':') || s.endsWith('#')) return true;
  if (DOT_RUN.test(s)) return true;
  if (LOOKS_TYPED.test(s) || LOOKS_NUMBER.test(s) || LOOKS_NUMBER2.test(s)) return true;
  // Quote timestamps. A plain scalar reads back as a string, but some parsers
  // resolve it to a date object and then a version string is no longer equal.
  if (TIMESTAMP.test(s)) return true;
  if (/[\x00-\x08\x0b-\x1f\x7f\n]/.test(s)) return true;
  return false;
}

// Write a mapping. Nested collections are indented two columns past their key so
// that a sequence under a key can never be read back as a sibling.
export function dump(obj, indent = 0) {
  const pad = ' '.repeat(indent);
  let out = '';
  for (const [k, v] of Object.entries(obj ?? {})) {
    if (v === undefined) continue;
    const head = k === '' ? '' : String(k);
    if (v === null) { out += `${pad}${q(head)}: null\n`; continue; }
    if (typeof v === 'object' && !Array.isArray(v)) {
      const keys = Object.keys(v);
      if (!keys.length) { out += `${pad}${q(head)}: {}\n`; continue; }
      out += `${pad}${q(head)}:\n` + dump(v, indent + 2);
      continue;
    }
    if (Array.isArray(v)) {
      if (!v.length) { out += `${pad}${q(head)}: []\n`; continue; }
      out += `${pad}${q(head)}:\n` + seq(v, indent + 2);
      continue;
    }
    if (typeof v === 'string' && v.includes('\n')) {
      out += `${pad}${q(head)}: |\n` + v.replace(/\n$/, '').split('\n').map((l) => ' '.repeat(indent + 2) + l).join('\n') + '\n';
      continue;
    }
    out += `${pad}${q(head)}: ${fmt(v)}\n`;
  }
  return out;
}

function seq(items, indent) {
  const pad = ' '.repeat(indent);
  let out = '';
  for (const item of items) {
    if (item === null || isScalar(item)) { out += `${pad}- ${fmt(item)}\n`; continue; }
    if (Array.isArray(item)) {
      if (!item.length) { out += `${pad}- []\n`; continue; }
      out += `${pad}-\n` + seq(item, indent + 2);
      continue;
    }
    const keys = Object.keys(item);
    if (!keys.length) { out += `${pad}- {}\n`; continue; }
    keys.forEach((k, n) => {
      const head = `${n === 0 ? pad + '- ' : pad + '  '}${q(k)}:`;
      out += line(head, item[k], indent + 2);
    });
  }
  return out;
}

// One key/value pair for a sequence item, with the head already written.
function line(head, v, indent) {
  if (v === null) return `${head} null\n`;
  if (Array.isArray(v)) {
    if (!v.length) return `${head} []\n`;
    return `${head}\n` + seq(v, indent + 2);
  }
  if (typeof v === 'object') {
    const keys = Object.keys(v);
    if (!keys.length) return `${head} {}\n`;
    return `${head}\n` + dump(v, indent + 2);
  }
  if (typeof v === 'string' && v.includes('\n')) {
    return `${head} |\n` + v.replace(/\n$/, '').split('\n').map((l) => ' '.repeat(indent + 2) + l).join('\n') + '\n';
  }
  return `${head} ${fmt(v)}\n`;
}

function isScalar(v) { return v === null || typeof v !== 'object'; }
function q(k) { return needsQuote(k) ? JSON.stringify(k) : k; }

export function fmt(v) {
  if (v === null) return 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return String(v);
  const s = String(v);
  return needsQuote(s) ? JSON.stringify(s) : s;
}
