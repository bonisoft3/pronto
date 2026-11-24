---
type: decision
title: Telemetry, tags and consent
description: Proposed, partially built (the tag frame and the consent bar) — one first-party collection path for product events and operational telemetry, routed by Vector to stores that differ in retention (DuckLake for product events, VictoriaMetrics and Jaeger for operations) and to advertising destinations server-side; tags are declared destinations, and the few that need the vendor's cookies run in an isolated same-origin tag frame, never in the app's document; consent is a framework screen and a replicated row enforced where events fan out, and Rill reads the lake.
status: proposed, partially built
---

# Telemetry, tags and consent

An app that buys ads needs four things the platform does not give it: page and product
events kept long enough to read funnels, conversions and audiences delivered to ad
networks, a consent choice that holds in every jurisdiction a visitor comes from, and a
place to read the result. Each has a familiar vendor answer (an analytics SaaS, Google Tag
Manager, a consent management platform, a BI tool), and each of those puts third-party
code in the page, a second copy of the user in someone else's store, or both. This record
argues one path for all four, built from what the cluster already runs.

## What exists

- **Operations, on one target.** `plugins/pronto/k8s/observability/observability.cue`
  deploys VictoriaMetrics, Jaeger (OTLP) and Vector, provisioned on Kind only
  ([[../../k8s/README#7. Observability Architecture (Option B)|k8s README]]). The GCP
  target exports metrics to Cloud Monitoring from sidecars
  ([[../release-targets|release targets]]); compose and Cloudflare collect nothing.
- **Trace propagation at the door.** Caddy continues an incoming `traceparent` with or
  without a collector (`plugins/pronto/caddy-tracing.integration.test.ts`).
- **The lake.** Domain rows reach DuckLake through pg_duckpipe
  ([[2026-10-20-duckstream-backend-contract|the backend contract]]).
- **No product events.** A page can load no third-party script; the terminal forbids
  it ([terminal](https://github.com/bonisoft3/omnishell/blob/v0.33.0/docs/terminal.md)). Google's tag runs beside it in a
  tag frame, and the terminal asks the reader's consent for it (both below).

## What is decided

**One collection path, two kinds of store.** The browser and the native hosts send
batched events to the app's own door at `/e`; backends send theirs directly. Vector routes
them. Product events go to a DuckLake events table and are kept; metrics and traces go to
VictoriaMetrics and Jaeger and expire. The stores differ in retention and query shape
(per-user sequences over years against per-request spans over days), not in how events
arrive, so the collector is shared and the stores are not.

**The lake is written by one writer.** Vector's HTTP sink delivers batches to a writer in
mecha's lake package, which inserts into DuckLake. DuckLake 1.0 inlines small inserts in its
catalog and compacts them later, so a stream of small batches does not become a stream of
small files. The alternative, Vector's S3 sink writing Parquet and a job registering the
files with `ducklake_add_data_files`, needs no new service but leaves registration,
compaction and replay to a cron job.

**Page events stay out of the app's database.** Domain facts (a sign-up, a generated deck,
a payment) are already rows and already reach the lake. Page views are high-volume and
loss-tolerant; putting them in the transactional database would make every page view a
replicated write. They meet the domain facts in the lake, where a funnel joins both.

**Ingestion is a mecha contract, not Vector.** Vector runs where containers run. Each
release target implements the same `/e` contract:

| Target | Collector | Notes |
| --- | --- | --- |
| compose, k8s | Vector | the observability stack, extended |
| GCP | Vector beside the door | Cloud Monitoring stays for operations |
| Cloudflare | a Worker | Zaraz is the vendor equivalent, free to 1M events a month |

**Tags are destinations, not scripts.** A tag manager's job is to send the same event to
several vendors under a consent policy. Pronto already declares effects and sinks, so a tag
is a declared destination of the event stream: conversions to Google Ads, remarketing
signals, Meta's Conversions API. Two delivery classes:

- *Conversions* are few and must not be lost: each is a Level 4 effect through the airlock
  ([[2026-10-03-external-effects|external effects]]), keyed by the click identifier stored
  with the user (`gclid`, `gbraid`, `wbraid`) and an idempotent transaction id. Google
  routes offline conversions and Customer Match through its Data Manager API since 2026.
- *Signals* (page-level remarketing hits) are many and loss-tolerant: a Vector sink, the
  way server-side GTM and Zaraz fan out server to server.

Nothing third-party runs in the app's document, so its content security policy, the realm
lockdown and time travel are untouched, ad blockers see a first-party request, and the
native hosts send to the same door.

**What needs Google's cookies runs in a tag frame.** Some destinations work only from the
visitor's browser with the vendor's own cookies: Google's conversion linker and remarketing
match an anonymous visitor that way, and no server can forward those cookies. They run in a
hidden same-origin frame that pronto emits beside the app, with its own document, realm and
policy. The frame admits Google's tag and the scripts it chains; the app's document admits
only the frame. The app passes the frame the real page location, referrer, click
identifiers, route changes and consent by `postMessage`, origin-checked both ways. Same
origin keeps the `_gcl_*` cookies first-party, and is also why the frame separates policy
and realm but not authority: the vendor's code can reach `parent`. A cross-origin frame
would contain it and lose the first-party cookies. A GTM web container could live there too
without reaching the app. Built for Google's tag as `meta.googleTag`; its contract is in
[[../component-contracts|component contracts]].

**Google Tag Manager is not the primitive.** GTM runs in the page because collection needs
the browser: the landing URL and its click identifiers, the referrer, first-party cookies
and interactions. Server-side GTM keeps that client half and moves only the fan-out. Pronto
already owns a client in the page, so the terminal collects the same fields and the door
sets the first-party identifier as an HttpOnly cookie. A GTM web container is a remote
script whose contents change without a deploy, which the page's policy cannot admit and a
reviewer cannot read, so it never runs in the app's document. Its server container (sGTM) is
a fan-out service like the one above; an app whose marketers want GTM's interface may
declare sGTM as one destination.

**Native does not get a webview.** [Native
hosts](https://github.com/bonisoft3/omnishell/blob/v0.33.0/docs/native-hosts.md#rejected) rejects a webview for its cost; an invisible one to host GTM would pay it for a
script whose web cookies do not attribute an app. Native hosts post to `/e`; installs and
in-app purchases are attributed by the store integrations Google Ads already reads.

**Remarketing runs in the tag frame, Customer Match beside it.** Google's remarketing script
loads further scripts the app's policy refuses, and admitting them fails under the realm
lockdown; in the tag frame neither applies. Anonymous visitors are matched there by
Google's cookies. Signed-in users are also uploaded by Customer Match (hashed identifiers,
through the Data Manager API), which survives blocked scripts and expired cookies.
Rejected: remarketing from the server alone, which cannot carry Google's cookies and so
loses most anonymous visitors; Partytown, under which Google's tag is unreliable; an image
beacon without script, whose support by Google is unestablished.

**Consent is a framework screen and a row.** The terminal draws the choice like its own
chrome, in every language the app has, and it is stored as a replicated row (choice, policy
version, time) because it is evidence, not a preference. Destinations read the consent row
at fan-out, so a refused purpose is never sent, and Google destinations carry Consent Mode
v2's four signals.

*One purpose, in an advertiser's words.* An advertiser asks one thing, `advertising`: Google
storing and sending to measure the app's ads and to remarket (`ad_storage`, `ad_user_data`,
`ad_personalization`). `measurement`, the app's own first-party events into its own lake, is
not asked: it is never sent to a third party. Google's `analytics_storage` follows
`advertising` rather than being a second question, so Google stores nothing unless the reader
said yes to ads. A publisher asks other questions. An app that shows others' ads (AdMob,
AdSense) owes an IAB TCF string and, in the EEA, a Google-certified CMP. That is a separate
declaration, `adServing`, kept for a TCF engine such as c15t or a certified CMP (Cookiebot,
Usercentrics, Didomi), and it is not built.

*No geography.* Everyone sees the same bar. A jurisdiction table (opt-in in the EEA, the UK,
Switzerland and Brazil, opt-out with Global Privacy Control in the US, notice elsewhere)
would need the edge to locate every reader. It would also need a table that ages and is
reviewed like code, and a fallback for a reader it cannot place, which has to be the strict
case anyway. Asking everyone is the strict case without the table, and an advertiser loses
little by it: a reader who ignores the bar is simply not measured. An app that has decided
for itself states it as `mode: "none"` with an explicit `none.advertising`, so asking nobody
is written down where a reviewer reads it.

*The first view, and nothing heavier.* The bar appears on the first view, compact and
non-blocking. Ignoring it is a refusal, and it stays until it is answered. A Reject is final
until the reader reopens the choice, and Global Privacy Control is a Reject that shows no bar,
unless the reader explicitly accepted: a standing browser default yields to an answer given on
the site, as California's rules allow.
A first-interaction trigger, asking at the first gesture that would send something rather
than on arrival, is planned through the identity mechanism. So is an
`{op: "identity", consent: …}` machine step that lets a flow ask at its own moment
([PR #2510](https://github.com/bonisoft3/pronto/pull/2510#issuecomment-7089537089)).

*Native discloses at install.* An app store asks at install time, through structured data:
Play's Data safety form, and the App Store's privacy labels with `PrivacyInfo.xcprivacy`.
Pronto should generate those from the same declarations (the tag, `consent`, and later
`adServing`), not draw a second consent screen inside a native host.

Built for the tag frame as `meta.consent`, its contract in
[[../component-contracts#consent-metaconsent|component contracts]]. The choice is kept on the
device, not yet in a row. A `device` row is an entity of the app's, with a schema, a
migration and a data plane that opens after the first screen. The choice has to be read
before the tag mounts, by a terminal that owns no entity, so it sits beside the session in
the device's storage. The replicated evidence row, which needs a framework-owned entity, and
fan-out enforcement, which needs the `/e` path, are not built.

**Rill reads the lake.** Rill runs on its live DuckLake connector. Its single-tenant
developer interface behind the app's door is the bound for an app before it scales; a
shared, permissioned deployment is Rill Cloud. Rill draws funnel and retention charts but
does not compute ordered, windowed, per-user funnels, so pronto generates those as SQL
models from a funnel declared in CUE (its steps, window and cohort).

## Rejected

- **An analytics SaaS** (PostHog, Mixpanel, Amplitude): a second copy of every user,
  priced per event. PostHog self-hosted is ClickHouse, Kafka, Postgres, Redis and MinIO,
  with roughly 8 GB of memory at hobby scale.
- **stratif.io** for funnels: a Python and React service for what a generated SQL model
  and Rill's chart do.
- **RisingWave as the landing store**: it maintains views; it is not where raw events are
  kept. It may read the stream for live aggregates later.
- **A tag manager or CMP script in the app's document**: see above.

## Open

- The writer's batch identity and replay against DuckLake's inlining.
- The event table's shape: Segment-style `track`, `identify` and `page` with
  `anonymous_id`, `user_id` and properties, and how `anonymous_id` joins the guest session.
- Whether logs also go to the lake with short retention, replacing a log store.
- Funnel declarations in CUE and the SQL they generate.
- Customer Match eligibility for the advertiser accounts.
- The consent row: a framework-owned entity the terminal writes beside the device's copy,
  and how a guest's choice follows them into an account.
