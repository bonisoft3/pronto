---
type: decision
title: "verify@<target>: post-release verification across live deployments"
description: Extends the verification loop from the local container developer stack to released applications across Cloudflare, Kubernetes, and GCP, executing one representative user journey per role/screen type with an airlock that enforces rollback for write mutations.
status: accepted
---

# verify@<target>

The battery against `launch.nu` runs against ephemeral local containers: Caddy
serving files from disk, local database instances, and synchronous mock doors.
It is blind to the platform boundaries that define a release: edge worker routing
rules (`run_worker_first`), CDN edge PoP caching tiers, immutable headers,
ingress controllers, gateway proxies, and load balancers. A release can pass
`integrate` cleanly and fail on its first cold edge request.

This record defines `verify@<target>`: the post-release gate that runs against
the live deployment (Cloudflare Workers, Kubernetes, GCP Cloud Run) before traffic
cutover, exercising user-centric journeys without polluting live data.

## Why local integration cannot settle a release

| Layer | `integrate` (local container stack) | `release@<target>` (deployed platform) |
|---|---|---|
| **Routing** | Caddy reverse proxy to local port | Edge Workers (`run_worker_first`), K8s Ingress, Cloud Load Balancing |
| **Assets** | Filesystem reads, dynamic bundler | Content-addressed `_immutable-*` assets, edge CDN cache, cold edge PoPs |
| **Cache policy** | Ephemeral, no edge cache | CDN immutable caching (`max-age=31536000`), header rules (`_headers`) |
| **Persistence** | Ephemeral container, wiped on restart | Durable Objects (Cloudflare), StatefulSet (K8s), Managed DB (GCP) |
| **Time & Clock** | Local tick, manual driver (`?clock=manual`) | Target platform time, distributed alarms, background queues |

`integrate` proves the app's components agree in a closed world. `verify` proves
the release runs under the target platform's real delivery and network contract.

## Target switching

A target release defines its default hostname in `meta.domain` (or the target's
configured environment). `verify` targets the live deployment and supports
explicit override via command flag and environment variable:

```sh
# Default: targets the domain declared in program.cue (e.g. https://golaberto.bonisoft3.com)
sayt verify@cloudflare

# Explicit deployment or preview environment
sayt verify@cloudflare --target=https://staging.golaberto.bonisoft3.com
APP_URL=https://staging.golaberto.bonisoft3.com sayt verify@cloudflare

# Kubernetes and GCP targets
sayt verify@k8s --target=https://preview.app.k8s.internal
sayt verify@gcp --target=https://app-preview-xyz-uc.a.run.app
```

`plugins/omnishell/base-url.ts` reads `APP_URL` across all drivers, ensuring
both manual tools and automated test drivers resolve the intended door.

## The two verification tiers

`verify` runs with a strict budget (under 15–30 seconds) across two complementary
tiers:

```
Pronto Metadata (shell.json, hints.json, wrangler.jsonc / manifest)
  │
  ├──► Tier 1: Fast HTTP Asset & Cold-Cache Sweep (~300ms)
  │      • Content-addressed asset matrix (200 + immutable)
  │      • Catalogue matrix (/messages/*.json)
  │      • Synthetic 404 cache-poisoning probe (404 + no-store)
  │
  └──► Tier 2: Browser User Journey Sweep (~5–15s)
         • One representative journey per role/screen type
         • Zero-tolerance network listener (traps any 4xx/5xx or net::ERR_*)
         • Airlocked write mutations with guaranteed compensating rollback
```

### Tier 1: Fast HTTP Asset and Cache Sweep

Generated purely from release metadata (`hints.json`, `shell.json`, target manifests):
1. **Asset Matrix**: Parallel `GET` requests for every content-addressed file
   (`/_immutable-<sha256>-<name>`) and catalogue (`/messages/<locale>.json`). Asserts
   status `200` and `Cache-Control: public, max-age=31536000, immutable`.
2. **Negative 404 Poisoning Probe**: `GET` request for a non-existent immutable
   path (e.g. `/_immutable-00000000000000000000000000000000-dummy.css`). Asserts status
   `404` and `Cache-Control: no-store`. If edge headers lock 404s into the CDN,
   verification fails immediately.
3. **Document Routes**: `GET` and `HEAD` for declared routes with `Accept: text/html`.
   Asserts status `200` and valid HTML entry without executing browser JS.

This tier completes in sub-second time and catches cold edge 404s before launching
a browser.

### Tier 2: Browser User Journey Sweep

Runs in a headless browser (Playwright) against the target door:
1. **Scope**: One representative user journey per role and screen type declared
   in `ir.html` and `shell.json`. Visiting every screen once exercises all dynamic
   chunk prefetch chains (`screens/_immutable-*-<name>.html.txt`), stylesheet
   loads, and hydration steps.
2. **Zero-Tolerance Network Listener**: Traps any unhandled network failure:
   ```ts
   page.on('response', (res) => {
     if (res.status() >= 400) throw new Error(`Edge HTTP ${res.status()} on ${res.url()}`)
   })
   page.on('requestfailed', (req) => {
     throw new Error(`Edge network aborted: ${req.failure()?.errorText} on ${req.url()}`)
   })
   ```
   A single 404, 5xx, or failed asset prefetch aborts verification.

## The Verification Airlock: rollbacks for write journeys

Running writes against a live release database (Cloudflare Durable Object SQLite,
Kubernetes Postgres, or GCP Cloud SQL) cannot rely on ephemeral container resets.

### Domain machines remain pure

Domain machines (`state.cortex` in [[../cortex|cortex.cue]]) model business states
only. Adding test-specific "un-do" states or synthetic hard-delete transitions
pollutes production statecharts and introduces security vulnerabilities.

### The Verification Airlock contract

Write journeys are wrapped in a **Verification Airlock** that pairs the forward
user action with an explicit compensating rollback:

```ts
export const verifyCreateNote = airlock({
  accepts: "accept-player-note",
  screen: "player-profile",
  role: "scout",

  // 1. Forward action through user journey
  async execute(page: Page) {
    await page.goto("/jogador/raphinha")
    await page.fill('[data-test="note-input"]', "Verification test observation")
    await page.click('[data-test="submit-note"]')
    const noteId = await page.getAttribute('[data-test="note"]:last-child', "data-id")
    return { noteId }
  },

  // 2. Journey assertion
  async verify(page: Page, { noteId }) {
    await assertText(page, `[data-id="${noteId}"]`, "Verification test observation")
  },

  // 3. Mandatory compensating rollback
  async rollback({ noteId }, door) {
    await door.mutate("delete_note", { id: noteId })
  }
})
```

The airlock guarantees:
1. Every write is isolated with a verification correlation token.
2. `rollback` executes in a `finally` block, running even if assertions fail or
   the browser crashes.
3. The target database returns to zero net delta.

### Compile-time enforcement

Pronto's compiler knows from `program.cue` which entities and handlers perform
writes. During `sayt lint` / `check-facts`:
- If an acceptance journey selected for `verify` performs mutations without an
  airlocked `rollback` contract, compilation fails:
  > `acceptance error: journey 'accept-edit-game' performs writes on entity 'game', but declares no airlock rollback contract.`

The author (human or LLM) must provide the cleanup contract at the time the write
case is written.

## Platform implementations

### 1. Cloudflare (`verify@cloudflare`)
- Checks Workers Assets routing rules: static assets bypass Worker via negative
  rules (`!/shell/*`), while navigations and cluster routes hit the Worker.
- Verifies Durable Object PGlite read models and RPC endpoints (`/crud`, `/electric`,
  `/poke`).
- Validates Early Hints (`103`) and `Link` preload headers.

### 2. Kubernetes (`verify@k8s`)
- Probes Ingress TLS termination, header sanitization, and path routing.
- Verifies cluster service-to-service mesh reachability and readiness probes.
- Tests multi-pod read consistency across Postgres replicas.

### 3. GCP (`verify@gcp`)
- Verifies Cloud Load Balancer frontend IP, SSL certificates, and Cloud CDN caching.
- Validates Cloud Run container concurrency, cold boot latency, and VPC egress to
  Cloud SQL.

## Alternatives considered and rejected

- **Full acceptance battery on live deploy**: Rejected. Exhaustive acceptance runs
  can take several minutes and create unnecessary load and write contention on
  production clusters. One journey per role/screen type provides 100% asset and
  route coverage in under 15 seconds.
- **Database-level transaction rollback across HTTP**: Rejected. Neither Cloudflare
  Durable Objects nor HTTP-based web apps can hold an open database transaction
  across multiple asynchronous browser HTTP requests. Compensating airlocks are
  required.
- **Rollback states inside production domain machines**: Rejected. Pollutes domain
  statecharts with test hooks that should never exist in production. The airlock
  wraps the test, keeping the machine pure.
