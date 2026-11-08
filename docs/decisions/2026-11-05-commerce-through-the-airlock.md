---
type: decision
title: Commerce through the airlock
description: A print-on-demand app sells with no server hatch. Calls out go through the airlock, by Dapr invocation behind a breaker with no retries; webhooks are poll signals, uploads go to the blob plane, guests may order, the mail is an origin effect, and a sink varies per release target.
status: accepted, built
---

# Commerce through the airlock

A print-on-demand app's checkout ran as an edge hatch: a Worker route holding a payment
SDK, an integration framework, the vendor's client, order state, private artwork in the
database and its own sweep. An SSR release refuses hatches, and most of that code re-made
what a machine, the [ledger](2026-10-03-external-effects.md#the-ledger) and the blob plane
already give. So the order becomes a machine, and no server hatch remains.

## What was decided

**Calls out are effects.** A quote, a checkout session, a session's re-read, placing a
vendor's order, reading its status and the mail are each an invoking state and a handler.
The claim, retries and the record of what was asked are the ledger's, so the app writes
none of them.

**A webhook is a poll signal.** The alternative was to verify the payload and believe it,
with an idempotency key carried across. A correlation id does not say who sent the request,
so a forged "paid" would ship goods, and one of the two providers signs nothing. So a
webhook only names the row to re-check, and the state it enters asks the provider. No
handler, no signature and no webhook secret. A forgery costs one read. A polling timer alone
was rejected: its latency and its calls are paid on every order, for an event the provider
offers. The price of a signal is one more read and a little replication before the reader
sees it, which a payment confirmation can afford and a latency-critical application might not.

**A signal during a check answers non-2xx.** A state that invokes takes no event, so a
webhook arriving mid-check would otherwise be lost to a read that came back too early. The
provider's redelivery carries it instead.

**Guests own orders.** A guest's session is a real id with private rows, so nothing about
privacy asks for sign-in. An order completes on the server if the guest's tab is gone. Sign-in
through a provider is a separate track, since it leaves the guest's rows behind today.

**Abuse is bounded by global caps.** Guest ids are free, so per-account limits stop nobody.
A trigger caps orders waiting for payment, which needs no clock or counter since a slot frees
itself when its order is paid or expires. The cost is that one abuser can block checkout
until their orders expire.

**Print shop is one dialog.** `window.print` over one document with an `@page` size, so no PDF
library. It gives up the Trim and Bleed boxes, which is acceptable because the art stays inside
the trim. Several dialogs for one deck would not be acceptable. A vendor that fetches one image
per card still needs the browser to compose them, in a small host-DOM hatch.

**Mail is an origin effect.** Cloudflare's REST API works from any backend, so the edge
needs no extension. The mail piece speaks SMTP from a container, which the edge lacks, and
Activepieces has no provider-neutral send. A `mail` capability shaped like `ai` waits for a
second target to need it.

**An effect declares its content type, and calls are invocations.** The payment API takes form
bodies, and daprd's bindings API runs `json.Marshal` over `data`, a string included, through every
version to 1.19. Its gRPC API carries bytes, at the cost of a gRPC library on Deno and two transports.
Dapr's own answer for a non-Dapr endpoint is service invocation against a declared `HTTPEndpoint`,
which was measured to hand body, headers and status through unchanged. daprd also forwards a full
URL with no setting to stop it, so a `routerchecker` rule generated from the effects, with
`api.allowed`, keeps declared destinations the only ones reached by accident. That is a guard against
mistakes in trusted code, not a security boundary: a deliberate `dapr-app-id` header on an allowed
path was measured reaching an undeclared host, and gRPC proxying was not settled.

**A breaker and no retries.** Declaring a Resiliency policy for an endpoint turns off daprd's
built-in retries, which cannot know what a repeat costs; the ledger decides that. A sink's 4xx
counts toward the trip and no policy filters it, which was accepted because the trip is high and
an open breaker spends no attempt: it only delays. The edge is demo-level and has no breaker.

**A sink varies per release target,** as `ai.targets` varies a model: `sink: {origin, targets:
docker: bridge: "simulator"}`, the entry winning and a target left with neither refused at
generation. The endpoint is written at generation, so nothing reads an environment for it. Compose
is one stack for `launch`, `integrate` and a docker release, which all run as platform `docker`, so
`local` is no key here. Sandbox or live is the app's own value, and going live is a reviewed commit.
Cloud Run's airlock has no daprd, its mesh address being the AI gateway, so that release refuses an
app whose effects reach anything else.

**Uploads go to the [authorized blob
plane](https://github.com/bonisoft3/mecha/blob/v0.20.6/docs/decisions/2026-10-08-authorized-blob-plane.md),** with its
guest refusal relaxed and its raw reads kept. `/img` re-encodes, and a vendor must fetch the very
bytes written.

## What this does not settle

Delivery addresses stay in the ledger, whose input is frozen, with no purge. Time travel needs that
record, so its retention belongs to a separate discussion.
