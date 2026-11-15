#!/usr/bin/env node
// citadel chart fetcher.
//
// Reads the pins in charts.lock.yaml, downloads every chart archive from its
// upstream Helm repository or OCI registry, checks each archive against the
// pinned digest, writes the tarballs into charts/, and rebuilds
// charts/index.yaml from the archives that are now on disk.
//
//   node tools/fetch-charts.mjs            fetch what is missing and rebuild index.yaml
//   node tools/fetch-charts.mjs --check    verify everything, write nothing
//   node tools/fetch-charts.mjs --force    re-download every chart, rebuild index.yaml
//   node tools/fetch-charts.mjs --update   re-download and refresh pinned digests in the lock
//
// Node is required, and nothing else, except for a chart the lock declares as
// source: local. Those are built here by this repository, so packaging them is
// the one step that needs helm.
//
// Chart.yaml is read straight out of each .tgz, so the index entries always
// match the archive that a release would install.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as yaml from './miniyaml.mjs';
import { findMember } from './minitar.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CHARTS_DIR = `${ROOT}charts`;
const LOCK_FILE = `${ROOT}charts.lock.yaml`;

const CHART_LAYER = 'application/vnd.cncf.helm.chart.content.v1.tar+gzip';
const args = new Set(process.argv.slice(2));
const check = args.has('--check');
const force = args.has('--force');
const update = args.has('--update');

if (args.has('--help') || args.has('-h')) {
  console.log('usage: node tools/fetch-charts.mjs [--check|--force|--update]');
  process.exit(0);
}

const log = (...a) => console.log(...a);
const die = (msg) => { console.error(`error: ${msg}`); process.exit(1); };

// Only a source: local entry needs Helm. Every other source is plain https.
const HELM_BIN = process.env.CITADEL_HELM_BIN || 'helm';

const lock = yaml.parse(readFileSync(LOCK_FILE, 'utf8'));
if (!lock || !Array.isArray(lock.charts) || lock.charts.length === 0) {
  die(`${LOCK_FILE.replace(ROOT, '')} holds no charts`);
}

// ---------------------------------------------------------------- downloads

async function getBuffer(url, headers = {}) {
  const res = await fetch(url, { headers, redirect: 'follow' });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    die(`GET ${url}\n  ${res.status} ${res.statusText}${body ? `\n  ${body.trim().slice(0, 300)}` : ''}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

async function fetchHttp(entry) {
  if (!entry.url) die(`${entry.name}: http source has no url`);
  return getBuffer(entry.url);
}

// OCI token handshake. Registries answer /v2/ with 401 and the token realm.
// Registries are pinned as hostnames such as ghcr.io, so add the scheme.
function registryUrl(entry) {
  const r = String(entry.registry ?? '');
  return /^https?:\/\//.test(r) ? r : `https://${r}`;
}

async function ociToken(registry, repository) {
  const probe = await fetch(`${registry}/v2/`, { redirect: 'manual' });
  const challenge = probe.headers.get('www-authenticate') || '';
  if (probe.status !== 401 || !/^Bearer/i.test(challenge)) return null;
  const realm = /realm="([^"]+)"/i.exec(challenge)?.[1];
  const service = /service="([^"]*)"/i.exec(challenge)?.[1];
  if (!realm) return null;
  const url = new URL(realm);
  if (service) url.searchParams.set('service', service);
  url.searchParams.set('scope', `repository:${repository}:pull`);
  const res = await fetch(url);
  if (!res.ok) die(`token ${url.origin}${url.pathname} -> ${res.status}`);
  const body = await res.json();
  return body.token || body.access_token || null;
}

async function ociManifests(entry) {
  const { repository, tag } = entry;
  const registry = registryUrl(entry);
  let token = await ociToken(registry, repository);
  const headers = { Accept: `${CHART_LAYER},application/vnd.oci.image.manifest.v1+json,application/vnd.oci.image.index.v1+json,*/*` };
  if (token) headers.Authorization = `Bearer ${token}`;
  let res = await fetch(`${registry}/v2/${repository}/manifests/${tag}`, { headers });
  if (res.status === 401 && !token) {
    token = await ociToken(registry, repository);
    if (token) { headers.Authorization = `Bearer ${token}`; res = await fetch(`${registry}/v2/${repository}/manifests/${tag}`, { headers }); }
  }
  if (!res.ok) die(`manifest ${registry}/${repository}:${tag} -> ${res.status} ${await res.text().then((t) => t.trim().slice(0, 200))}`);
  return { doc: await res.json(), token };
}

async function fetchOci(entry) {
  if (!entry.registry || !entry.repository || !entry.tag) die(`${entry.name}: oci source is incomplete`);
  let { doc, token } = await ociManifests(entry);
  // A multi-manifest index carries the chart manifest as one of its entries.
  if (Array.isArray(doc?.manifests)) {
    const pick = doc.manifests.find((m) => /manifest/i.test(m.mediaType || '')) ?? doc.manifests[0];
    const ref = pick.digest || pick.platform?.architecture || entry.tag;
    const res = await fetch(`${registryUrl(entry)}/v2/${entry.repository}/manifests/${ref}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.oci.image.manifest.v1+json,*/*' },
    });
    if (!res.ok) die(`index manifest ${entry.name} -> ${res.status}`);
    doc = await res.json();
  }
  const registry = registryUrl(entry);
  const layer = (doc.layers ?? []).find((l) => l.mediaType === CHART_LAYER);
  if (!layer) die(`${entry.name}: no ${CHART_LAYER} layer in ${registry}/${entry.repository}:${entry.tag}`);
  const res = await fetch(`${registry}/v2/${entry.repository}/blobs/${layer.digest}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) die(`blob ${layer.digest} -> ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

// Charts that this repository builds rather than downloads.
//
//   source: local
//   path: charts-src/litellm      the chart directory, relative to the repo root
//
// There is no upstream to pull: helm packages the directory here, so the archive
// citadel serves is the one this repository produced. It lands in charts/ like
// any other archive, and the digest check that follows is what proves that a
// re-run reproduces it. Nothing is written into charts/ by the package step
// itself; helm writes into a temporary directory that is discarded again, so a
// digest mismatch still stops the run before anything is written.
function fetchLocal(entry) {
  const dir = entry.path ? String(entry.path) : '';
  if (!dir) die(`${entry.name}: local source has no path`);
  const abs = join(ROOT, dir);
  if (!existsSync(abs)) die(`${entry.name}: local source path ${dir} does not exist`);
  const file = entry.file || `${entry.name}-${entry.version}.tgz`;

  // helm is optional for every other source, so only report it when a local
  // entry actually needs it.
  const version = spawnSync(HELM_BIN, ['version', '--short'], { encoding: 'utf8' });
  if (version.error) {
    console.error(`error: ${entry.name}: source local needs the command "${HELM_BIN}", which was not found.`);
    console.error(`  It packages ${dir} into ${file}. Install Helm (https://helm.sh/docs/intro/install/)`);
    console.error(`  or set CITADEL_HELM_BIN to its path. Every other source needs no Helm.`);
    process.exit(1);
  }
  if (version.status !== 0) die(`${entry.name}: helm is not runnable\n  ${(version.stderr || version.stdout || '').trim().slice(0, 300)}`);

  const out = mkdtempSync(join(tmpdir(), 'citadel-local-'));
  try {
    const run = spawnSync(HELM_BIN, ['package', abs, '-d', out], { encoding: 'utf8' });
    if (run.status !== 0) {
      die(`${entry.name}: helm package ${dir} failed\n  ${(run.stderr || run.stdout || '').trim().slice(0, 500)}`);
    }
    const built = readdirSync(out).filter((f) => f.endsWith('.tgz'));
    if (built.length !== 1) die(`${entry.name}: helm package ${dir} wrote ${built.length} archives, expected 1`);
    return readFileSync(join(out, built[0]));
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

const fetchChart = (e) => (e.source === 'oci' ? fetchOci(e) : e.source === 'local' ? fetchLocal(e) : fetchHttp(e));

// ------------------------------------------------------------------- archiving

// Read Chart.yaml straight out of the archive, so the index is built from the
// bytes a release would install and not from a copy of the metadata.
function chartOf(tgz) {
  const hit = findMember(tgz, (name) => /(^|\/)Chart\.yaml$/.test(name));
  if (!hit) die('archive has no Chart.yaml');
  const chart = yaml.parse(hit.data.toString('utf8'));
  if (!chart?.name || !chart?.version) die('Chart.yaml has no name or version');
  return { chart, mtime: hit.mtime };
}

// ---------------------------------------------------------------------- main

function sha256(buf) { return createHash('sha256').update(buf).digest('hex'); }
function rfc3339(epochSeconds) {
  const d = new Date((epochSeconds || 0) * 1000);
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

const lockCharts = lock.charts;
let fetched = 0, verified = 0, changed = 0;

log(`citadel: ${lockCharts.length} charts pinned`);

for (const entry of lockCharts) {
  const file = entry.file || `${entry.name}-${entry.version}.tgz`;
  const path = `${CHARTS_DIR}/${file}`;
  const have = existsSync(path) && !force && !update;
  let buf;
  if (have) {
    buf = readFileSync(path);
    verified++;
  } else {
    buf = await fetchChart(entry);
    fetched++;
  }
  const digest = sha256(buf);
  if (entry.digest) {
    if (entry.digest !== digest) {
      if (!update) {
        // A chart packaged from charts-src/ cannot be rebuilt byte for byte, so
        // say what to do about it instead of leaving a confusing dead end.
        const note = entry.source === 'local' ? `\n  ${entry.name} is source: local. helm stamps the build time into the archive, so a rebuild of ${entry.path ?? 'its source'} always hashes differently. Run with --update to store the new digest.` : '';
        die(`${file}\n  digest mismatch\n  pinned ${entry.digest}\n  got    ${digest}${note}`);
      }
      entry.digest = digest;
      changed++;
    }
  } else if (!have) {
    log(`  ! ${file}: no pinned digest to check against. Run with --update to store one.`);
  }
  if (entry.size && Number(entry.size) !== buf.length) {
    if (update) { entry.size = buf.length; changed++; }
    else log(`  ! ${file}: size ${buf.length} but pinned ${entry.size}`);
  }
  if (!entry.size) { entry.size = buf.length; if (update) changed++; }
  if (!have) {
    if (!check) {
      mkdirSync(CHARTS_DIR, { recursive: true });
      writeFileSync(path, buf);
    }
    log(`  + ${file}  ${(buf.length / 1024).toFixed(1)} KiB  sha256:${digest.slice(0, 12)}…`);
  } else {
    log(`  = ${file}  ${(buf.length / 1024).toFixed(1)} KiB  ok`);
  }
}

// ------------------------------------------------------------- rebuild index.yaml

function indexEntries() {
  const entries = {};
  for (const file of readdirSync(CHARTS_DIR).filter((f) => f.endsWith('.tgz')).sort()) {
    const tgz = readFileSync(`${CHARTS_DIR}/${file}`);
    const { chart, mtime } = chartOf(tgz);
    const version = String(chart.version);
    // A helm index entry omits what the chart does not set, so drop empty keys
    // instead of writing `key: null` for all of them.
    const filled = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined && !(Array.isArray(v) && v.length === 0)));
    const entry = filled({
      name: chart.name,
      version,
      appVersion: chart.appVersion ?? null,
      description: chart.description ?? null,
      apiVersion: chart.apiVersion ?? null,
      type: chart.type ?? null,
      keywords: chart.keywords ?? null,
      home: chart.home ?? null,
      sources: chart.sources ?? null,
      maintainers: chart.maintainers ?? null,
      icon: chart.icon ?? null,
      deprecated: chart.deprecated ?? null,
      dependencies: chart.dependencies?.length ? chart.dependencies : null,
      annotations: Object.keys(chart.annotations ?? {}).length ? chart.annotations : null,
      digest: sha256(tgz),
      created: mtime ? rfc3339(mtime) : rfc3339(Math.floor(statSync(`${CHARTS_DIR}/${file}`).mtimeMs / 1000)),
      urls: [`./${file}`],
    });
    if (!entries[chart.name]) entries[chart.name] = [];
    entries[chart.name].push(entry);
  }
  const sorted = {};
  for (const name of Object.keys(entries).sort()) {
    sorted[name] = entries[name]
      .sort((a, b) => compareVersions(b.version, a.version))
      .map(({ apiVersion, name: _n, version, ...rest }) => ({ apiVersion: apiVersion ?? 'v2', name, version, ...rest }));
  }
  return { apiVersion: 'v1', entries: sorted };
}

function compareVersions(a, b) {
  const pa = String(a).replace(/^v/, '').split(/[.\-+]/);
  const pb = String(b).replace(/^v/, '').split(/[.\-+]/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = parseInt(pa[i] ?? '0', 10) || 0;
    const y = parseInt(pb[i] ?? '0', 10) || 0;
    if (x !== y) return x - y;
  }
  return 0;
}

const index = indexEntries();
const indexYaml = yaml.dump(index);
if (!check) {
  mkdirSync(CHARTS_DIR, { recursive: true });
  writeFileSync(`${CHARTS_DIR}/index.yaml`, indexYaml);
}
log(`  index.yaml: ${Object.keys(index.entries).length} charts, ${Object.values(index.entries).flat().length} versions`);

// --------------------------------------------------------------- rewrite lock

if (!check && (changed || update || process.env.CITADEL_REWRITE_LOCK === '1')) {
  const header = readFileSync(LOCK_FILE, 'utf8').split('\n').filter((l) => l.startsWith('# ')).join('\n');
  const body = yaml.dump({ ...lock, generated: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z') });
  writeFileSync(LOCK_FILE, `${header}\n${body}`);
  log(`  charts.lock.yaml: refreshed digests (${changed} change${changed === 1 ? '' : 'd'})`);
}

log(`done: ${fetched} fetched, ${verified} already present, ${changed} digest${changed === 1 ? '' : 's'} updated`);
if (check) log('(check mode: nothing written)');
