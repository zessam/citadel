# citadel

citadel is a Helm chart repository. It holds the chart archives that
[ai-inference-platform](https://github.com/zessam/ai-inference-platform) pins,
copied out of the public chart repositories and OCI registries that Argo CD
normally pulls them from.

A pinned chart that stays on a vendor's server can change underneath a release.
If a vendor retires a tag, moves a release, or drops a version, the Argo CD
Application that names it stops syncing. citadel keeps a local copy instead, so
installing a version you already validated does not depend on someone else's
upload.

Every archive here is byte for byte what upstream publishes. `tools/` re-downloads
them and checks each one against a pinned SHA-256 digest.

## Layout

```
charts/
├── index.yaml              the Helm repository index
├── seaweedfs-4.53.0.tgz
└── ...                     one archive per pinned chart version
charts.lock.yaml            the pins that tools/fetch-charts.mjs reads
charts-src/
└── litellm/                the source of the one chart we build, not download
tools/
├── fetch-charts.mjs        download, verify, rebuild index.yaml
├── selftest.mjs            check the repository, no cluster or Helm needed
├── miniyaml.mjs            the YAML reader and writer
└── minitar.mjs             reads one file out of a .tgz
```

The Helm root is `charts/`. `index.yaml` sits next to the archives it lists and
points at them as `./name-version.tgz`, so the folder is self-contained and moves
with the repository.

## Use it as a chart repository

Add it to Helm:

```bash
helm repo add citadel https://raw.githubusercontent.com/zessam/citadel/main/charts/
helm repo update
helm search repo citadel --versions
```

Point one Argo CD Application at citadel instead of the upstream source. This is
the seaweedfs app before the change:

```yaml
  sources:
    - repoURL: https://seaweedfs.github.io/seaweedfs/helm
      chart: seaweedfs
      targetRevision: 4.53.0
```

and after it, for an HTTP chart:

```yaml
  sources:
    - repoURL: https://raw.githubusercontent.com/zessam/citadel/main/charts
      chart: seaweedfs
      targetRevision: 4.53.0
```

`targetRevision` is the chart version for an HTTP chart. For an OCI chart, Argo CD
uses the tag instead. citadel serves OCI charts over HTTP, so use the chart
version listed in `charts.lock.yaml` as `targetRevision` and drop `repoURL` to the
citadel URL. See [the OCI notes](#oci-charts) below.

The values files do not change. Argo CD still reads them from the platform
repository through the `ref: values` source.

## Charts

Fourteen charts, 3.1 MB, pinned at the versions that
`ai-inference-platform/argocd/apps/` names. Run `node tools/selftest.mjs` to see
the same table verified against the files on disk.

| Chart | Version | Upstream source | Pinned by |
| --- | --- | --- | --- |
| seaweedfs | 4.53.0 | https://seaweedfs.github.io/seaweedfs/helm | argocd/apps/storage/seaweedfs.yaml |
| kube-prometheus-stack | 93.1.2 | https://prometheus-community.github.io/helm-charts | argocd/apps/monitoring/kube-prometheus-stack.yaml |
| cert-manager | v1.21.3 | https://charts.jetstack.io | argocd/apps/management/kserve/cert-manager.yaml |
| lws | v0.8.0 | registry.k8s.io/lws/charts (OCI) | argocd/apps/management/kserve/lws.yaml |
| keda | 2.21.0 | https://kedacore.github.io/charts | argocd/apps/management/keda.yaml |
| gateway-helm | v1.8.6 | docker.io/envoyproxy (OCI) | argocd/apps/management/kserve/envoy-gateway.yaml |
| ai-gateway-crds-helm | v1.1.0 | docker.io/envoyproxy (OCI) | argocd/apps/management/kserve/envoy-ai-gateway-crds.yaml |
| ai-gateway-helm | v1.1.0 | docker.io/envoyproxy (OCI) | argocd/apps/management/kserve/envoy-ai-gateway.yaml |
| kserve-llmisvc-crd | v0.21.0 | ghcr.io/kserve/charts (OCI) | argocd/apps/management/kserve/kserve-llmisvc-crd.yaml |
| kserve-llmisvc-resources | v0.21.0 | ghcr.io/kserve/charts (OCI) | argocd/apps/management/kserve/kserve-llmisvc-resources.yaml |
| kserve-runtime-configs | v0.21.0 | ghcr.io/kserve/charts (OCI) | argocd/apps/management/kserve/kserve-runtime-configs.yaml |
| cloudnative-pg | 0.29.1 | https://cloudnative-pg.github.io/charts | argocd/apps/management/litellm/cloudnative-pg.yaml |
| litellm-helm | 1.106.7 | ghcr.io/berriai (OCI) | argocd/apps/management/litellm/litellm.yaml |
| litellm | 1.106.7-1 | built here from `charts-src/litellm` | nothing yet, see [charts we build](#charts-we-build) |

### What is not here

- **The three charts that live in the platform repository.** `helm/inference/vllm`,
  `helm/management/kserve/kserve-gateway` and `helm/monitoring/grafana-dashboards`
  are source charts, not downloads. Their Applications use `path:` on the platform
  repository, so citadel has nothing to serve. The fourth of them,
  `helm/management/litellm/litellm-db`, is now bundled into the `litellm` umbrella
  chart, so citadel does serve it: as part of that archive.
- **Subcharts are not separate entries.** `kube-prometheus-stack`, `gateway-helm`,
  `litellm-helm`, `cloudnative-pg` and the rest ship their dependencies inside
  their own archive, so Helm resolves a release from one download.

## OCI charts

Seven of the fourteen charts live in an OCI registry rather than a tar index.
`tools/fetch-charts.mjs` pulls them through the registry API, takes the
`application/vnd.cncf.helm.chart.content.v1.tar+gzip` layer, and stores it as an
ordinary archive. What lands in `charts/` is identical to what `helm pull
--oci` would get.

The archives carry the chart version, which is not always the tag. For these
charts the tag and the version match, so `targetRevision` in the Application stays
the same string. `charts.lock.yaml` records both in `version` and `tag`.

To pull from OCI directly instead of from citadel, keep the original Application.
citadel does not replace the registry, it copies out of it.

## Keeping it correct

```bash
node tools/fetch-charts.mjs --check   # every archive is present and matches its digest
node tools/selftest.mjs               # index, digests, pins, and the YAML reader
```

`selftest.mjs` compares its own YAML reader against `js-yaml` when that is
installed, so the index and the lock cannot drift into a dialect only one tool
understands:

```bash
npm i -D js-yaml
npm test
```

### Fetch a chart

```bash
node tools/fetch-charts.mjs           # fetch what is missing, then rebuild index.yaml
node tools/fetch-charts.mjs --force   # re-download everything
node tools/fetch-charts.mjs --update  # re-download and refresh digests in the lock
```

Only Node is required, except for the `local` chart, which this repository builds
and so needs `helm package`. No Python, no container registry credentials.
Registries that need a token, such as ghcr.io, hand one to the script during the
anonymous pull.

### Charts we build

One entry, `litellm`, is not a copy of anything. Its source is the chart directory
`charts-src/litellm`, and the lock declares it

```yaml
  - name: litellm
    source: local
    path: charts-src/litellm
    file: litellm-1.106.7-1.tgz
```

The same run of `tools/fetch-charts.mjs` that downloads the other thirteen packages
this one with `helm package` and writes the archive into `charts/`, so
`charts.lock.yaml` stays the whole recipe: nothing in `charts/` is manual.

`litellm` is an umbrella chart, one Helm release that installs the gateway and its
database together. It pulls in two dependencies, both bundled in `charts-src/litellm/charts/`:
the vendored `litellm-helm` archive above, byte for byte, and the CloudNativePG
`litellm-db` chart copied out of the platform repository. Helm expands both into
directories inside the packed archive, which is why the whole release installs
from one download.

The one thing that does not survive a rebuild is the archive's own bytes. Helm
stamps the packaging time into every entry of the tar, so `digest` identifies the
archive that was committed here, not the source: a rebuild an hour later hashes
differently even though `diff -r` of the two extracted trees is empty. Keep the
pin, and run with `--update` after editing a chart under `charts-src/`.

### Add or bump a chart

1. Change `charts.lock.yaml`. Copy a `charts:` entry and set `name`, `version`,
   `tag`, `source`, `repository` or `registry`, and `url` — or `path`, for a chart
   built from `charts-src/`. Leave `digest` and `size` empty or wrong on purpose,
   the fetch fills them in.
2. Run `node tools/fetch-charts.mjs --update`. The script downloads the archive,
   writes it into `charts/`, refreshes `index.yaml`, and stores the real digest in
   the lock.
3. Run `node tools/selftest.mjs`.
4. Commit `charts.lock.yaml`, `charts/index.yaml` and the new archive.

To drop a version, delete its entry and its archive, then run the fetch script to
rebuild the index.

If a fetch fails, the script stops before it writes anything. A half-written
repository is worse than a failed sync, so a digest mismatch is a hard error
rather than a warning.

## Licenses

Each archive is unchanged from upstream and keeps the LICENSE and Chart.yaml it
was published with. citadel stores copies for availability, it does not
relicense them.
