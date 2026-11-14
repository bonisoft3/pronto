---
type: decision
title: "release@gcp: production staged while the gate tests, deployed when it passes"
description: The gated gcp release does everything that runs no production code while its tests run (project, plan, images, storage, grants), so a pass leaves only the schema job and the deploy; nothing of the release executes in production before the tests pass. Adds a revision-aware rollback.
status: proposed
---

# A staged release

A gated `release@gcp` (docs/release-targets.md#gcp) deploys the preview `rc`,
tests it with the app's drivers (verify.nu), and only then releases the very
images it tested. Bonk Chess's release of 2026-10-29 took 27 minutes:

| Phase | Minutes | What |
|---|---|---|
| Preview: images | 0–4 | Cloud Build; reused when unchanged |
| Preview: schema job | ~1.5 | initdb on the emptied `rc` database |
| Preview: deploy | ~4 | the service, then its sidecars apart and the clock |
| Tests | ~5.5 | check-online, check-premium, integrate |
| **Production, after the pass** | **~6** | project check, the copy finished and tagged, the plan rendered, storage, grants, the schema job, the deploy |
| Tests' log, read before the release went live | ~1 | (gcp.19) |

Two of these are already better on this fork's line and wait only for the apps
to move to it: the drivers run together (verify.nu, "the drivers run
together"), so the tests take as long as the slowest, about 2½ minutes; and
the tests' log is read once the release is live (`drivers-log`). Bonk Chess
releases on gcp.19, which has neither.

The production phase is what this record changes. Of its six minutes, about
two and a quarter pass before the schema job starts: waiting on the copy build
the gate started, tagging each of fifteen images `release` and reading its
digest back, rendering the plan (several `cue export` and `docker compose
config` runs), the bucket and its grant, the scrape configs, the secret
grants. None of it runs the app. All of it can happen while the tests run.

## Decision

The release's production phase is split at the one line that matters: **does
it run code of the release against production?**

**While the tests run** (after `go-drivers`, beside `finish-drivers`), the
release stages production, running none of the app:

1. `ensure-infrastructure`: the project's APIs, repository, database instance,
   accounts and secrets, as today (a marker makes it two seconds when nothing
   changed).
2. The copy of the tested images into the release's repository, as
   `candidate`, as today (`start-copy`).
3. The plan rendered and `dist/gcp/*.yaml` written. The digests it names are
   the tested ones, known before the copy ends: a release's image is the
   preview's, byte for byte, so the plan needs no `release` tag to render.
4. The bucket and its grant, the scrape configs, the secret grants.

**When the tests pass**, the release deploys what it staged:

1. Each image tagged `release`, its digest checked against the tested one (in
   parallel, as today).
2. The schema job replaced and run: the first production code of the release.
3. The service replaced; its sidecars apart and the ticker's clock together,
   as today; the domains; `/health`.

**When the tests fail**, the release stops. Production is as the last release
left it: the job and the service are untouched, no image is tagged `release`,
and what staging wrote is declarative and idempotent (the project, the
bucket's grant, the grants on secrets the plan names), so the next release
restates it. The `candidate` images stay in the repository untagged for
production, as a failed gate's do today.

Expected: the production phase drops from about six minutes to about three
and a half (the schema job and the deploy, which run production code and stay
after the pass). With the drivers already running together, a gated release
goes from about 27 minutes to about 19.

## Why not a mirror, flipped

The first idea was to deploy the release beside production with no traffic
(Cloud Run's `--no-traffic --tag candidate`) while the tests run, and move
traffic to it when they pass. Rejected: Cloud Run starts an instance of every
revision it deploys to check it is ready, traffic or not. For an app with a
database that instance is production code against production: the migrator,
Electric taking its replication slot (which the live revision holds), the
gateway on a schema not yet carried forward. A release that must run nothing
before its gate passes cannot deploy a revision before it.

## Rollback

A revision a release replaced is still in Cloud Run, so going back is a
traffic change, seconds, not a release: `release@gcp --rollback` moves the
service's traffic, and each sidecar service's, to the revision before the
current one.

Not when the schema moved. The schema job carries the database forward and
completes its migrations; the revision before expects the schema before, which
is gone. Each revision a release deploys carries the hash of the migrations it
was released with (a `pronto.dev/schema` annotation); `--rollback` refuses
when the revision it would go back to has another, and says so: going back
past a migration is a release of the older commit, which the gate tests.

## What changes

- `gcp/release.nu`: `deploy` split into `stage` (the four steps above, no
  production code) and `go-live` (tag, schema job, service, sidecars, clock,
  domains, health); `main` runs `stage` for production beside
  `finish-drivers`, and `go-live` after it. A preview, a dry run, a snapshot
  and `--no-gate` run both, one after the other, as `deploy` does now.
- Each step prints its stamp, so the next measurement reads from the log.
- `--rollback`, and the schema annotation on every revision.
- docs/release-targets.md#gcp says the release stages production while it
  tests.

Every app releasing to gcp gets it with the next gcp version of this fork
(gcp.27); Bonk Chess moves to it from gcp.19, through its local CI and a gated
release.

## Not now

- The preview's deploy (about four minutes, most of it Cloud Run waiting for
  the revision): its sidecars wait for the service because they dial its door;
  starting them together is a change to how they find it.
- release@k8s: the same split (stage the manifests and images, apply after
  the pass) belongs there too, after gcp.
