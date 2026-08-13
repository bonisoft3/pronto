# The connection ceiling, and the cheapest way out of it

Every pronto app on the plain-http door pays a write latency measured in
seconds, and none of them show it, because every toggle is optimistic. This is
the measurement, the mechanism, and a fix that needs neither TLS nor a rewrite
of how shapes are subscribed.

## What it costs

Measured 2026-08-09 on the running `realworld` cluster with
`PerformanceResourceTiming` — `requestStart - startTime` is time queued for a
connection, `responseStart - requestStart` is time the server had it:

| screen | live shapes | write | stalled | server |
|---|---|---|---|---|
| settings | 2 | PATCH app_user, 183 ms | 1 ms | 181 ms |
| home | 6 | POST favorite, 7 855 ms | — | — |
| tag | 7 | POST bookmark, 12 151 ms | 12 073 ms | 78 ms |

Seventy-eight milliseconds of work behind twelve seconds of queue. The server is
not slow and Postgres is not slow: the request never leaves the browser.

## Why

Chrome allows six concurrent HTTP/1.1 connections **per origin**. An Electric
live shape is a long-poll, so each one holds a connection for its whole timeout.
One shape per *table*, however many regions or cards read it — so the count is
the screen's table count, not its region count:

- `settings` — app_user, me → 2
- `home` — article, app_user, article_tag, article_stats, favorite, tag_count,
  bookmark → 7
- `article` — the same plus follow, comment, me → 9

At six the pool is exhausted and every write waits for a long-poll to time out.
Above six the shapes queue behind each other as well, which is what
`check-visual` has been reporting on `/article/:slug` as a 20-second
`waitForFunction` timeout on every run that predates this note.

Electric's own client warns about exactly this on every boot
(`[Electric] Using HTTP (not HTTPS) typically limits browsers to ~6 concurrent
connections per origin`), and the advice it gives — use HTTPS for HTTP/2 — is
right and is not free: it needs a certificate the browser trusts, which on a
developer's laptop means installing Caddy's internal CA.

## The first answer: give the long-polls their own origin

The cap is per origin. Nothing requires the shapes and the writes to share one.
Serving `/electric/*` from a second origin gives the sync plane its own pool of
six and hands all six of the app's back to reads and writes.

Verified in isolation before proposing it. The harness is twenty lines: two
Deno servers on neighbouring ports, each answering `/hang` after thirty seconds
and `/write` immediately; a page opens six hangs against one origin and times a
trivial POST to the app origin, twice, varying only which origin holds the
hangs.

| arrangement | write total | stalled | server |
|---|---|---|---|
| six long-polls on the app origin (today) | 29 215 ms | 29 212 ms | 2 ms |
| six long-polls on a second origin | 3 ms | 1 ms | 2 ms |

The write path comes back completely. No TLS, no certificate trust, no change to
how or when shapes are subscribed.

## What shipped, in the end: one door, and it is h2

The origin split worked and was still the wrong shape. It buys twelve sockets
where the problem wants none: `/article` subscribes nine tables, so it overflowed
its six on the sync origin too and kept failing the battery. Partitioning is
arithmetic somebody has to keep redoing every time a screen grows a table.

h2 multiplexes every stream over one connection, so the count stops existing.
Same nine tables, same origin, transport the only variable:

| | plain http (HTTP/1.1) | TLS (h2) |
|---|---|---|
| article rendered | 1 552 ms | **647 ms** |
| slowest shape | 20 027 ms | **142 ms** |
| worst shape stall | 19 459 ms | **1 ms** |
| write from that screen | 445 ms (359 queued) | **43 ms (1 queued)** |

So the plain door is gone — not redirected, unpublished. The listener still
exists inside the container because the healthcheck uses it; nothing outside can
reach it, so there is no second transport to drift onto and no dev-only code
path. And with one origin the split's whole apparatus goes with it: no
`stream.<host>`, no CORS grant, no `Vary: Origin`.

Browsers speak h2 only over TLS — none of them implement cleartext h2 — so the
door needs a certificate the browser trusts. `tls internal` cannot supply one:
Caddy's root would live inside the container where no host browser can see it,
and an *untrusted* certificate is worse than plain http, because the
interstitial blocks WebAuthn where `http://localhost` is a secure context and
passkeys work. mkcert is the answer, and the cluster now asks for it:

```
checks: certs: {verb: "setup", cmds: [...]}     # libraries/mecha/cluster.cue
```

`just setup` issues the pair into `apps/<app>/.certs` (gitignored). Trusting it
is the one step left to a human, because it writes to the system keychain:

```
mise exec -- mkcert -install
```

CI never pays that: `check-visual` drives the door with `ignoreHTTPSErrors`.

### The platform seam this needed

`setup` was not a layer a runtime could declare into — the loop bucketed checks
into `lint`/`test`/`integrate` only. It is now, with one wrinkle worth knowing:
a setup declaration must APPEND to the `builtin` rule rather than sit beside it.
`config.cue` gives `builtin` `stop: true`, so a sibling rule is emitted, sorted
after it, and never runs; and `builtin: {stop: false}` fails the default
disjunct, which resolves builtin with no cmds at all — `mise install` would
quietly stop happening. The emitter re-declares the builtin's own cmd first.

Two traps cost real time here and are worth writing down. `len()` over the
struct a comprehension builds reads as incomplete, so the setup guard silently
never fired and the rule vanished from `.say.yaml` with no error; the guard is a
list comprehension now. And the caddy lint had to move from `validate` to
`adapt` — validate also provisions, which loads the certificate at a path that
only exists inside the container, so it failed on every host.

## The origin split, and why it is not here

Serving `/electric/*` from a second origin was tried, shipped, measured
(`POST bookmark` from home went 12 151 ms → 42 ms) and then deleted, because it
buys twelve sockets where the problem wants none: `/article` subscribes nine
tables, so it overflowed its six on the sync origin too. Partitioning is
arithmetic somebody has to redo every time a screen grows a table.

**Do not re-attempt it.** `stream.<host>`, its CORS reasoning and the
`Vary: Origin` header it needed are gone and should stay gone. Two findings from
it are worth keeping regardless: Electric answers cross-origin by itself, so a
second grant breaks every shape with "Access-Control-Allow-Origin contains
multiple values"; and its shape responses are `public, max-age=604800` with the
allow-origin echoed from the request, so without `Vary: Origin` one cache entry
serves every origin — opening a shape URL in a tab poisons it for the shell.
