# Activepieces trigger host spike

Status: experiment complete; not production integration or release wiring.

One provider-independent host executes unchanged published Stripe, GitHub and RSS
triggers. This demonstrates useful lifecycle reuse beyond the existing action-only
[[../../docs/activepieces-hatches|hatch]]. It does not establish universal catalogue
compatibility or trusted payment fulfillment.

## Reproduce

From this directory, with the repository's Sayt toolchain:

```sh
sayt build@local
sayt lint@local
sayt test@local
```

Deno 2.9.7 and all npm artifacts are pinned; `deno.lock` records integrity hashes.
The six tests invoke the actual bundled packages, with HTTP intercepted by Nock.
Unmatched requests fail; the test invocation grants no network permission. No
provider account, webhook registration or payment is touched. There is no app UI
change, so no visual design oracle is involved.

| Published package | Selected trigger | Context exercised |
| --- | --- | --- |
| `@activepieces/piece-stripe@0.9.0` | `checkout_session_completed` | Secret-text auth, properties, webhook URL, persistent store, payload |
| `@activepieces/piece-github@0.11.0` | `trigger_issues` | OAuth-shaped auth, repository properties, webhook URL, store, payload |
| `@activepieces/piece-rss@0.7.2` | `new-item` | Feed URL, store, republish flag and polling context |

GitHub receives a fixture access token; OAuth consent and refresh are not tested.
Registry selection and fixture HTTP responses are provider-specific; `host.ts` has
no provider branches. Unknown context capabilities fail explicitly.

## What ran

1. Stripe and GitHub register/unregister through their own hooks; a new host object
   reopens the persisted store and can remove the registered endpoints. Filtering,
   GitHub ping handling and host-provided delivery-ID deduplication work.
2. The Stripe trigger emits an unsigned, unpaid checkout payload unchanged.
3. RSS enable establishes a cursor. An injected failure before local commit leaves
   both cursor and outbox unchanged. A new host object retries and records the item.
   Republish preserves the cursor; repeated polling emits no duplicate item.
4. An injected failure after external registration but before local commit leaves
   an orphan registration; retry creates another. Local transactions cannot undo
   provider side effects, and this trigger supplies no registration idempotency key.
5. With eager store writes, dropping RSS output after the trigger returns advances
   its cursor and loses the event. Buffering store changes and committing them with
   the outbox, as the shared host does, closes this local failure window.
6. GitHub registration supplies no webhook signing secret; its trigger emits an
   unsigned callback body.

The host's JSON snapshot and rename model a single-writer transaction boundary.
They are not a production store: no fsync/power-loss guarantee, distributed lease,
concurrent writer protection, schema validation or bounded storage. Restart here
means a fresh host object loading disk, not a killed process. The outbox is recorded
but not delivered into Pronto, and webhook receipt IDs are supplied by the tests;
provider identity extraction and verified ingress are still design work.

## What the full runtime buys

Source audit is pinned separately to upstream
[`f34c43cd8cc712f1e5e460984f0040c729e8bb9d`](https://github.com/activepieces/activepieces/tree/f34c43cd8cc712f1e5e460984f0040c729e8bb9d).
This is an audit of source, not an execution of the full Activepieces service and
not a claim that the npm artifacts were built from this exact commit.

- The engine's generic verification path applies to `APP_WEBHOOK` through
  `piece.events.verify`; ordinary `WEBHOOK` invokes the trigger's own `run`.
  The audited Stripe and GitHub triggers do not provide signature verification.
  [Engine verification](https://github.com/activepieces/activepieces/blob/f34c43cd8cc712f1e5e460984f0040c729e8bb9d/packages/server/engine/src/lib/helper/trigger-helper.ts).
- Telegram demonstrates that a piece can own verification: it registers a secret
  token and checks the callback header. Its implementation accepts the payload if
  the stored secret is absent, so qualification still needs failure cases.
  [Telegram trigger](https://github.com/activepieces/activepieces/blob/f34c43cd8cc712f1e5e460984f0040c729e8bb9d/packages/pieces/community/telegram-bot/src/lib/trigger/new-message.ts).
- The polling helper persists its cursor before emitting results; the polling
  worker submits those results afterwards. That exposes a source-level failure
  window analogous to test 5; the complete upstream deployment was not fault-tested.
  [Polling helper](https://github.com/activepieces/activepieces/blob/f34c43cd8cc712f1e5e460984f0040c729e8bb9d/packages/pieces/common/src/lib/polling/index.ts),
  [polling worker](https://github.com/activepieces/activepieces/blob/f34c43cd8cc712f1e5e460984f0040c729e8bb9d/packages/server/worker/src/lib/execute/jobs/execute-polling.ts).
- The full service provides HTTP ingress, queues, scheduling, registration lifecycle,
  connection resolution and workers. Async webhook acknowledgement is queue
  admission, not Pronto's durable application acceptance. Importing the engine alone
  does not provide those services: it has internal workspace dependencies and an
  API-backed context.
  [Engine package](https://github.com/activepieces/activepieces/blob/f34c43cd8cc712f1e5e460984f0040c729e8bb9d/packages/server/engine/package.json),
  [webhook service](https://github.com/activepieces/activepieces/blob/f34c43cd8cc712f1e5e460984f0040c729e8bb9d/packages/server/api/src/app/webhooks/webhook.service.ts).

## Recommendation

Proceed with a shared standard-trigger host, not a provider-specific runner for each
integration. The measured compatibility unit is the selected operation and its
required context. Implement the common lifecycle/store once, then qualify selected
versions for authentication, retry behavior and event identity. Three successful
pieces do not establish coverage of the whole catalogue.

Before exposing this host, add transactional checkpoint plus outbox persistence,
per-trigger serialization, durable delivery/replay, credential isolation, lifecycle
reconciliation and authenticated ingress. Preserve raw callback bodies and headers;
fail closed when verification is unavailable. Stripe/GitHub require a corrected
piece or a verified ingress adapter before their callbacks may drive trusted state.
The generic trigger interface alone cannot supply the missing authentication.

Pronto should own the application machine and fulfillment decisions. Polling is an
external acquisition concern; its outputs enter Pronto through durable callback
acceptance and CDC. For payments, checkout completion alone is not payment
confirmation, and a provider event is not permission to fulfill an unrelated order.

Running the full Activepieces service buys substantial orchestration but does not
eliminate the audited auth/checkpoint concerns. For this architecture its added
PostgreSQL/Redis/worker deployment overlaps Pronto's orchestration. This spike favors
a bounded compatibility host; OAuth refresh, renewal, handshakes, file services and
broader trigger strategies remain unmeasured. Cloudflare and browser portability
were not tested; no production host or release target was changed by this spike.
