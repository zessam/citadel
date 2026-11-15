#!/usr/bin/env node
// citadel self test.
//
//   node tools/selftest.mjs
//   CITADEL_JSYAML=/path/to/js-yaml node tools/selftest.mjs
//   npm i -D js-yaml && node tools/selftest.mjs
//
// Four checks, none of which need Helm, kubectl or the cluster:
//
//   1  the parser reads charts/index.yaml, charts.lock.yaml and every bundled
//      Chart.yaml exactly as a real YAML parser does. Needs js-yaml as an
//      oracle; reported as skipped when it is not installed.
//   2  what the writer emits reads back unchanged, so index.yaml cannot drift
//      into something only one tool understands.
//   3  every index entry points at an archive that exists, with the digest that
//      archive really has, and describes that archive's name and version.
//   4  every pin in charts.lock.yaml has its archive on disk.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as yaml from './miniyaml.mjs';
import { findMember } from './minitar.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CHARTS = `${ROOT}charts`;
let pass = 0, fail = 0, skip = 0;

const ok = (name) => { pass++; console.log(`  ok    ${name}`); };
const bad = (name, detail) => { fail++; console.log(`  FAIL  ${name}\n          ${String(detail).split('\n').join('\n          ')}`); };
const skipped = (name, why) => { skip++; console.log(`  skip  ${name}\n          ${why}`); };

function deepEqual(a, b, path = '$') {
  if (a === b) return null;
  if (typeof a !== typeof b || a === null || b === null) return `${path}: value differs (${json(a)} vs ${json(b)})`;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return `${path}: one is an array`;
    if (a.length !== b.length) return `${path}: array length ${a.length} vs ${b.length}`;
    for (let i = 0; i < a.length; i++) { const e = deepEqual(a[i], b[i], `${path}[${i}]`); if (e) return e; }
    return null;
  }
  if (typeof a === 'object') {
    const ka = Object.keys(a).sort(), kb = Object.keys(b).sort();
    if (ka.join(',') !== kb.join(',')) {
      return `${path}: keys differ (only ref: ${ka.filter((k) => !kb.includes(k))}, only mine: ${kb.filter((k) => !ka.includes(k))})`;
    }
    for (const k of ka) { const e = deepEqual(a[k], b[k], `${path}.${k}`); if (e) return e; }
    return null;
  }
  return `${path}: ${json(a)} vs ${json(b)}`;
}
const json = (v) => JSON.stringify(v)?.slice(0, 120) ?? String(v);

// This reader keeps unquoted scalars as strings, so that a version such as 1.10
// cannot turn into 1.1. A full YAML parser resolves them to numbers. Normalise
// the oracle's numbers to strings before comparing; nothing else can differ.
function stringsOf(v) {
  if (Array.isArray(v)) return v.map(stringsOf);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, stringsOf(x)]));
  return typeof v === 'number' ? String(v) : v;
}

// ---------------------------------------------------------------- fixtures

const archives = readdirSync(CHARTS).filter((f) => f.endsWith('.tgz')).sort();
const indexText = readFileSync(`${CHARTS}/index.yaml`, 'utf8');
const lockText = readFileSync(`${ROOT}charts.lock.yaml`, 'utf8');
const index = yaml.parse(indexText);
const lock = yaml.parse(lockText);

if (!archives.length) { console.error('no archives in charts/, run tools/fetch-charts.mjs first'); process.exit(1); }

// ---------------------------------------------------------------- 1 oracle
let oracle = null;
try {
  oracle = await import('js-yaml');
} catch {
  if (process.env.CITADEL_JSYAML) {
    try { oracle = await import(new URL(`file://${process.env.CITADEL_JSYAML}`).href); } catch { oracle = null; }
  }
}
const load = oracle?.load ?? oracle?.default?.load;
if (!load) {
  skipped('parser matches a real YAML parser', 'js-yaml not found. Run `npm i -D js-yaml` or set CITADEL_JSYAML to its entry file.');
} else {
  const cases = [['charts/index.yaml', indexText], ['charts.lock.yaml', lockText]];
  for (const f of archives) cases.push([`${f} Chart.yaml`, chartOf(`${CHARTS}/${f}`).text]);
  for (const [label, text] of cases) {
    const e = deepEqual(stringsOf(load(text)), yaml.parse(text));
    if (e) bad(`parse ${label}`, e); else ok(`parse ${label}`);
  }
}

// ------------------------------------------------------------ 2 round trip
for (const [label, text] of [['charts/index.yaml', indexText], ['charts.lock.yaml', lockText]]) {
  const one = yaml.parse(text);
  const e = deepEqual(one, yaml.parse(yaml.dump(one)));
  if (e) bad(`round trip ${label}`, e); else ok(`round trip ${label}`);
}
{
  const one = index;
  const e = deepEqual(one, yaml.parse(yaml.dump(one)));
  if (e) bad('round trip generated index', e); else ok('round trip generated index');
}

// ------------------------------------------- 3 index entries match archives
const declared = new Set();
for (const f of archives) {
  const buf = readFileSync(`${CHARTS}/${f}`);
  const { chart, mtime } = chartOf(`${CHARTS}/${f}`);
  declared.add(`${chart.name}@${chart.version}`);
  const entry = (index.entries?.[chart.name] ?? []).find((e) => String(e.version) === String(chart.version));
  if (!entry) { bad(`index has an entry for ${chart.name} ${chart.version} (${f})`); continue; }
  if (!entry.urls?.includes(`./${f}`)) bad(`index urls for ${f} do not point at ./charts/${f}`);
  else ok(`index urls ./ -> charts/${f}`);
  const digest = createHash('sha256').update(buf).digest('hex');
  if (entry.digest !== digest) bad(`index digest for ${f}`, `index: ${entry.digest}\ndisk:  ${digest}`);
  else ok(`index digest = sha256(charts/${f})`);
  const stamp = entry.created;
  const wantStamp = new Date((mtime || 0) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  if (stamp !== wantStamp) bad(`created for ${chart.name}`, `${stamp} is not the archive time ${wantStamp}`);
}
for (const name of Object.keys(index.entries ?? {})) {
  for (const e of index.entries[name]) {
    if (!declared.has(`${e.name}@${e.version}`)) bad(`index entry ${name}@${e.version} has no archive in charts/`);
    if (e.name !== name) bad(`index key ${name} holds an entry named ${e.name}`);
  }
}
ok(`index entries all resolve to archives on disk`);

// -------------------------------------------------------- 4 lock pins present
for (const c of lock.charts ?? []) {
  const file = c.file || `${c.name}-${c.version}.tgz`;
  if (!existsSync(`${CHARTS}/${file}`)) { bad(`pinned archive missing: charts/${file}`); continue; }
  const buf = readFileSync(`${CHARTS}/${file}`);
  if (c.digest && c.digest !== createHash('sha256').update(buf).digest('hex')) {
    bad(`charts.lock.yaml digest for ${c.name}`, `lock: ${c.digest}\ndisk: ${createHash('sha256').update(buf).digest('hex')}`);
    continue;
  }
  if (c.size && Number(c.size) !== buf.length) { bad(`charts.lock.yaml size for ${c.name}`, `lock: ${c.size} disk: ${buf.length}`); continue; }
  ok(`pinned ${c.name} ${c.version} on disk, size and digest match`);
}

// ------------------------------------------------------------------- done
console.log(`\n${pass} passed, ${fail} failed, ${skip} skipped`);
process.exit(fail ? 1 : 0);

function chartOf(path) {
  const hit = findMember(readFileSync(path), (name) => /(^|\/)Chart\.yaml$/.test(name));
  if (!hit) throw new Error(`${path} has no Chart.yaml`);
  return { text: hit.data.toString('utf8'), mtime: hit.mtime, chart: yaml.parse(hit.data.toString('utf8')) };
}
