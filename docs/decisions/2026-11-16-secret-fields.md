---
type: decision
title: Secret fields
description: A value a reader types once for an external effect, a Pix PIN, sealed by the page to the airlock's public key as Kubernetes' Sealed Secrets seal a value to its one reader — a field flag whose column is always NULL, ciphertext alone in the request, the database and its logs, opened in memory just before the handler's call, and kept out of what the handler records by the handler's contract.
status: accepted
---

# Secret fields

The expense app pays by Pix. The payer types a PIN, the `execute-pix` effect sends
it to the bank, and afterwards nobody may read it: not a row, not the
[ledger](2026-10-03-external-effects.md#the-ledger), not a replay, not a synced
table, not a log. Everything else pronto keeps is history, on purpose. This is
the one value that must not be.

Two models, both well known, give the shape. Docker keeps a secret on tmpfs: it
exists while the work runs and never in the image, its layers or the build
cache. Kubernetes' Sealed Secrets, like libsodium's sealed box, encrypt a value
to the public key of its one reader, so whatever stores or carries it holds
ciphertext. Kubernetes names a secret from a container's environment with
`secretKeyRef`. Pronto takes these words and invents none.

## The grammar

```cue
entities: Payment: fields: [
	{name: "id", type: "uuid", pk: true},
	{name: "status", type: "string"},
	{name: "pin", type: "string", secret: true},
]
effects: "execute-pix": {
	input:   {amount: "NEW.total"}
	secrets: ["PIX_CLIENT_KEY", {field: "pin"}]   // the environment's, and the reader's
	...
}
```

The screen's form names the field like any other, as a password, which the
markup check requires:

```html
<form data-entity="payment" data-action="update">
  <input type="hidden" name="status" value="paying">
  <input type="password" name="pin" inputmode="numeric" autocomplete="off" required>
  <button type="submit">Pay</button>
</form>
```

The handler reads `secrets.pin` beside `secrets.PIX_CLIENT_KEY`. A sealed value
waits five minutes for its effect; that is the platform's, not the program's.

## The seal

The airlock holds a private key, `AIRLOCK_SEAL_KEY`, a deployment secret that is
never in the program or the database. It publishes the public half in
`airlock_seal`, which every client role reads through crud and none writes, and
brings that table and its own secret table at its start, so a database that
outlived a release needs no migration (`seal-tables.ts`). Every write the page
makes of a secret field, whichever writer states it (a form, a handler, a
machine), reads that key, encrypts the value with WebCrypto and sends
`seal1.<kid>.<ciphertext>` in its place (omnishell's `data-sync.js`, mecha's
`services/airlock/seal.ts`).

**RSA-OAEP with SHA-256 over a 3072-bit key.** It is the one WebCrypto encryption
every browser, Deno and workerd hold with no key schedule of ours, and a PIN fits
its one block (318 bytes), so a hybrid scheme buys nothing. HPKE (RFC 9180) over
X25519 would need its labelled HKDF written by hand on every side, and X25519 is
missing from WebCrypto in browsers still in use. The OAEP label is the table,
field and row the value was typed for, the row by its key as the database
spells it back (a uuid in lowercase), so a sealed value opens for that row
alone: one copied onto another row, or replayed from a log into another
payment, does not open.

Only the airlock opens it, in memory, just before its handler's call. A rotation
sets the new key and keeps the old one as `AIRLOCK_SEAL_KEY_PREVIOUS` for the
five minutes anything sealed to it can wait; the page reads the key at every
seal, so it moves to the new one at once.

No release makes the key. It is a secret like any an effect declares, made out of
band (mecha's `services/airlock/seal-key.ts` prints one), handed to the release
through its environment and checked where the stack starts, only for a program
with a secret field. Compose's airlock and the docker appliance's entrypoint
refuse to start without it, and the airlock dies at boot when its manifest has a
secret field and the key is unset. gcp keeps a release environment's key in
Secret Manager, a new value a new version, or else needs it there already;
cloudflare sets it on the dispatcher, its public half as the object's
`AIRLOCK_SEAL_PUBLIC`, or else keeps what the deployed Workers hold; a release
that finds it in neither place is refused.

The key follows pronto's tiers ([release targets](../release-targets.md#keys)):

- **Dev.** The local stack falls back to a development key committed in mecha,
  as it does for its JWT secret, and says so (`AIRLOCK_SEAL_DEV=local`).
  Everywhere else the airlock refuses that key by its id at start, however its
  PKCS#8 is spelled, current or previous; cloudflare's publish refuses it by
  its id, and gcp's release and the appliance refuse its usual spellings
  before anything runs.
- **Staging and sandbox.** A SOPS-encrypted file of the deployment's own,
  decrypted into the release's environment, as snapcards' staging does
  (`apps/snapcards/.say.cue`: `sops decrypt ... | load-env` before each
  release command).
- **Production.** The target's secret store, set there out of band; never the
  repository, SOPS or a publisher's environment.

## Where the value goes

| Step | Holds | Why nothing keeps the PIN |
|---|---|---|
| the form | the password input, until the submit settles | the terminal keeps no draft of a password, and clears a form's password inputs once its submit settles (`screen.js`) |
| the request | ciphertext | sealed by the store at its write boundary; a `server` entity's write is one request, with no collection, optimistic row or outbox |
| the row | NULL | the table's first trigger, `0_<table>_<field>_secret`, refuses what is not sealed without repeating it, holds the sealed value for the transaction and sets the column NULL before any other trigger, the interpreter included, sees it; a trigger after the write keeps it only for a row the write wrote, so an insert a conflict turned away onto another reader's row keeps nothing, and an insert offering one row twice, with a value or without, is refused; a `CHECK (<field> IS NULL)` refuses a write that bypasses triggers |
| `airlock.secret` | ciphertext, keyed by the row, five minutes | in the airlock's schema, which only its owner may use; logged, since what the WAL, a replica or a backup keeps opens for no one without the key, and an effect in flight then survives a crash or a failover |
| the claim | nothing | the ledger freezes `input`, which may not read the field, and its key may not name it |
| the run | the opened value, in the airlock's memory | opened just before the call and handed to the handler beside the environment's secrets |
| the outcome | nothing, by the handler's contract | the airlock records the handler's answer and error as they are, so a handler never echoes a value it was handed; the commit that first records the outcome deletes the sealed values its run opened, and no other (one typed since, for the row's next invocation, is that one's), once no other effect naming the field awaits its outcome for the row; until then, or five minutes, the value is kept for that one |

A replay answers the invoke from the ledger's outcome, so it needs no PIN, and
time travel over the row sees NULL in every version.

A sealed value that expires unread is swept by the airlock's housekeeping and by
every later write. A run that finds no value, or one that does not open, settles
`failed` with `{secrets, reason: "absent" | "unsealable"}` when nothing was asked
of the sink before, which is the payer's "the PIN expired", and `unknown` when an
earlier run may have reached it.

### At the edge

The edge's cluster is a Durable Object over PGlite, and its database is the
object's storage. So the object takes a secret field out of a crud write's body
before the database sees it, keeps the sealed value in the instance's memory for
five minutes, and keeps it only for the rows the write returned, which are the
rows the caller may write. A write to such a table is JSON, the body it reads. The claim hands it to the dispatcher Worker, which
holds `AIRLOCK_SEAL_KEY` and opens it; the last outcome of the effects naming it
on the row deletes it. An eviction before
the call loses the value, and its effect meets that as a value never written.

## The handler's contract

What a handler answers, throws or logs is recorded as it is: an outcome's data
in the ledger, an error in the queue's `last_error` and the airlock's log. So a
handler never puts a value it was handed in `secrets` into any of them, as
itself or transformed. The airlock does not rewrite what a handler records: a
recorded answer or error that showed whether some token equalled the secret
would tell whoever reads it about the value, which for a four-digit PIN is most
of what there is to know. A handler that echoes a secret has it recorded.

## Refusals

`cue vet` refuses a secret field

- on an entity that is not `server`: `live` and `offline` keep a copy of the row
  in every client, and `tab` and `device` are a client's copy;
- on an entity whose primary key is not one field, which the seal binds to;
- that is not an optional `string`, or that states `cel`, `generated`,
  `default`, `ref` or `unique`;
- read by the entity's `invariant`, a generated field, an index, a unique or a
  seed row;
- read by an effect's `input`, by `NEW.<field>` or inside `{raw}`, or named in
  its `key`;
- that no effect names in `secrets`, since nothing would read it;

and an effect that names `{field}` when the field is not a secret field of its
entity. The markup check refuses a form control for a secret field that is not
`<input type="password">`. A write that names no row by its key has no row to
seal to, and the store refuses it before anything leaves the page.

## What it does not cover

- **The page.** The PIN is in the clear in the password input and the page's
  memory until it is sealed. A script running in the page can read it, as it
  can read any password.
- **A write that bypasses triggers** (`session_replication_role = replica`) is
  refused by the column's check. Its error states the failing row, ciphertext
  included, to that session and the server log.
- **The handler.** A handler that echoes a secret into its answer or its error,
  as itself or transformed, gets it recorded in the ledger, the queue and the
  log.
- **Two effects on one field, one not yet claimed.** A value is kept while an
  effect naming its field awaits its outcome for the row, claimed and unsettled.
  One the row has not entered yet when the last claimed one settles finds none,
  as it finds none after five minutes.
- **The key's holder.** Whoever holds `AIRLOCK_SEAL_KEY` and the ciphertext,
  which the WAL and the backups keep until they expire, can open it. A rotation
  that discards the old key closes that.
- **The column** is in the entity's schema, types and sync shapes, always NULL:
  write-only by construction rather than absent.
- **A browser-side validation** reads the value the form holds; the cluster's
  reads NULL. Nothing refuses a validation that reads the field.

## Rejected

- **An entity kind or a durability** (`durability: "secret"`): a sixth rung that
  every switch over durability would have to learn, for a value that belongs to
  one call, not to a row anyone reads.
- **The value in the clear in an UNLOGGED table.** It keeps the PIN out of the
  WAL, but not out of the request, the trigger's and crud's errors, or the
  edge's storage, and a crash loses an in-flight payment's PIN. Sealing makes
  every carrier hold ciphertext, so the table can be durable.
- **A table written through an RPC before the move.** Two requests where the
  form makes one, not atomic with the transition, and an authorization written
  again where the row's own policies already decide the PATCH.
- **The value in `input`, redacted after the outcome.** The ledger is time
  travel's record and its input is frozen; rewriting it breaks both.
- **The job's payload.** Graphile's jobs are logged, and a dead letter keeps its
  payload.
- **Redacting what the handler records.** Replacing a handed value in an answer
  or an error tells whoever reads the record whether some token equalled it, an
  oracle on a value as small as a PIN; and a four-digit PIN is a token of order
  numbers, references and amounts, whose rewriting would falsify a result.
- **The public key as a second deployment variable** served by the door. It is
  derived from the private key wherever that is held, and published where the
  page already reads, so a release can never pair two keys that do not match.
  The edge is the exception: its object holds no private key, so the release
  sets the public half beside it.
