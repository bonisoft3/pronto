---
type: decision
title: "release@gcp: the local pre-gate beside the preview's deploy, a pass ledger, a concurrent go-live"
description: The local pre-gate runs while the rc preview deploys (the tests wait for it), a tree that passed it is not run again, and go-live runs its independent steps together, so the serial waits leave the critical path without a step touching production before every gate passed.
status: proposed
---

# Release concurrency

[2026-10-29-staged-release](2026-10-29-staged-release.md) kept one invariant:
nothing of the release runs against production before every gate passed. That
leaves room: what does not touch production can run beside what does not.

- **The local pre-gate beside the preview.** `release.nu` runs `local-gate` as a
  job beside the other: emptying `rc`, starting the tests' build and deploying
  the preview. None of those reach production. `go-drivers` (the tests told to
  run), the early copy and the production staging wait for the gate to pass.
  A gate that fails stops the preview's deploy where it is (`job kill`), cancels
  the tests' build and stops the preview, and the release fails with the gate's
  message; the tests' build is cancelled, but an image build the deploy had already
  submitted runs on to its end with nobody waiting for it. The gate's output is prefixed `local-gate|`.
- **A pass ledger.** `integrate@local` with `INTEGRATE_LOCAL_DRIVERS=all` stamps
  the app's tree on a pass, `~/.cache/pronto/local-gate/<app>/<key>`, the key a
  hash of the app's files as git lists them (tracked and untracked, not
  ignored) and of the pronto files the gate runs (`gcp/local-gate-key.nu`, the
  one place it is computed). A release finds the stamp and skips the gate, a
  gate run by hand before it counting. A changed or new file in the app, or
  another pronto, is another key. Files outside the app's directory are not in
  it. `--no-local-gate` is unchanged.
- **A concurrent go-live.** The retired migrate job's removal runs beside the service's replacement; then the door's invoker grant, each sidecar,
  the clock and the domains together. The schema job still ends before the
  service is replaced, and the health check still comes last. Each task runs to its end
  whatever the others answer, and the release fails after, with every error.
- **Rendered once.** The preview's plan and production's are rendered together
  at the start, and handed to `stage` and the early copy, which rendered them
  again; `stage` reads the compose project once, not twice.
- **Polls.** The copy's wait, the IAM retry and the health check ask every
  second, not every three or five; their total timeouts are as before.

The time saved is read from the stamps in the next release's log.
