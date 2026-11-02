---
type: decision
title: "release@gcp: a passed local gate replaces the rc preview, until something deploy-shaped changes"
description: The gated gcp release skips the rc preview, and goes straight to staging and going live, where the local gate passed for the app's tree and no deploy-shaped file changed since a release passed rc.
status: proposed
---

# The local gate replaces rc

The rc gate deploys a preview, builds the drivers in Cloud Build and runs them
against it: most of the release's wall time. The local pre-gate
([2026-11-01-release-concurrency](2026-11-01-release-concurrency.md)) already
runs the same drivers (`local-drivers.ts`) against the same app on a local
stack. What rc adds is what only the cloud has: the images as built there, the
service and job as rendered, the schema on Cloud SQL, the secrets and grants.
All of it is a function of a few files, and none of it changes with a change in
the app's screens, rules or content.

## The rule

A release (not `--preview`, `--dry-run`, `--snapshot` or `--no-gate`) skips rc
when both hold:

- its local gate passed for this exact tree, either found in the ledger
  (`~/.cache/pronto/local-gate/<app>/<key>`, stamped by `integrate@local` or by
  the app's full rehearsal) or run first, and
- its deploy-shaped key has a stamp (`~/.cache/pronto/rc-passed/<app>/<key>`),
  written only after a release that ran rc succeeded.

The deploy-shaped key hashes what the local gate never exercises, since it runs host
processes, not the images or the service Cloud Run renders: `release.cue`, `program.cue`,
`cue.mod/module.cue`, `.mise.toml`, `mise.lock`, `.say.yaml`, `.pronto/cluster.json`,
`compose*.yaml` and `.bayt/compose*.yaml`, `infra/`, every Dockerfile (`*Dockerfile*`,
`docker/`), the web server's, entrypoints' and sidecars' files (`Caddyfile*`, `nginx*.conf`,
`*entrypoint*`, `sidecar/`), and pronto's `gcp/*.nu` and `plugin.json`. Database migrations are
not in it: the local gate runs them on postgres. (`program.cue` is taken whole, its release and
target sections not being separable.) Any change to one runs rc, and so does `--rc`,
`--no-local-gate` (nothing then stands in for it), and a first release. The log says which path
was taken and why. The skipped path is `--no-gate`'s (stage, images built in Cloud Build, go
live), after the local gate.

## Not covered

What rc would find that no file in that list explains: a base image that moved under a floating
tag, a Cloud-only environment value, a quota, a grant changed in the project by hand, a file the
list does not name that an image reads (a config under a name the patterns miss), and a
floating `FROM` tag (unpinned base images), which no file of the app reveals. `--rc` is for
them. Stamps are per machine. A pass is recorded for the tree as it was before the gate ran, and
only if it is unchanged after; a tree whose key cannot be read is never recorded.

## Interface

`nu gcp/local-gate-key.nu <verb> <app dir>`: `key` and `deploy-key` print the
keys; `passed` and `rc-passed` print true or false; `stamp` records a local pass
for the tree as it stands (what an app's rehearsal calls after a full pass);
`rc-stamp` records an rc pass.

Both keys also hash the tool pins (mise.lock, .mise.toml: sayt, omnishell and its visual lint) of the app and of the repository above it.

## Pronto's own version is not deploy-shaped

The first deploy key hashed pronto's `gcp/*.nu` and the mise pins, so every pronto prerelease sent
every app's next release through the 13-minute rc preview. The scripts were in the set because rc
was the only run that exercised the release engine against a real project. That purpose is now served
earlier: a change to the engine runs its own fork tests (`release-flow.test.ts`, `release-gcp.test.ts`,
`local-gate-key.test.ts`, over `testdata/fake-cloud.sh`) before it is published, and an app's rc
preview of the next release adds nothing those did not.

So `deploy-key` hashes the pinned pronto runtime's content (what mise installed, found from the script's
own path) minus the engine's files (`gcp/*.nu`, those three tests, `testdata/`, `docs/`), and minus the
`#Version` line of `distribution/config.cue`; and it reads `.mise.toml`, `mise.lock` and
`cue.mod/module.cue` without pronto's own pin (the version, checksums and URLs of its tool block, its
dependency in the module). A pronto version whose only differences are in the engine keeps the key;
any other changed runtime file (`write.ts`, `distribution/`, `builders/`...) or any other tool's pin
(mecha, sayt, omnishell) moves it. The local gate's `key` is unchanged and still hashes the pins whole.

The risk taken: an engine change that works against the fakes and misbehaves against a real project is
no longer found by the next app's rc. `--rc` remains for it, and the release's own run still
fails loudly where a cloud call does.
