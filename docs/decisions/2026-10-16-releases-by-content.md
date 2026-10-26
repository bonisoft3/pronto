---
type: decision
title: "Releases by content: one entry names every file a page runs"
description: Replaces the three ways a running page learns of a deployment — per-file revalidation, verified live-update releases, and the edge's content addresses — with the third for every target, so a page cannot run files from two deployments, a first visit never restarts, and a tab left open takes each deployment at the least disruptive level its changes allow.
status: accepted
---

# Releases by content

A tab kept by a browser across a relaunch ran the interpreter its service
worker had cached against the markup and database served now, and Truco's bar
never drew its switch. Mending it twice, first per deployment and then by
turning live updates on, found that each repair stood on a different mechanism
for the same question: **which files is this page running, and what changed
since?** This record settles one answer for every level of update and every
target, toward a tab that is never closed and is always current: rows by live
queries, everything else by the smallest change a deployment needs.

## Three mechanisms for one question

| | since | targets | how a page learns of a deployment | can mix two? |
|---|---|---|---|---|
| per-file revalidation | 2026-09-29 | every app but the edge's | the worker serves each `/shell/`, `/omnishell/`, `/messages/` file from cache and refetches it; it announces a changed template, stylesheet or catalogue (`PRONTO_*_UPDATED`); the shell compares `pronto-cas` and `pronto-words` hashes and refetches the config | yes: a changed script runs stale until the next load, file by file |
| verified releases (`liveUpdates`) | 2026-10-05 | opt-in, no app | `shell/release.json` digests every file; the page downloads and verifies the whole set, the worker pins the page to it, a planner morphs or restarts | no, but every first visit restarts, and the edge refuses it |
| content addresses | the edge release | `cloudflare` | `edge-addresses.ts` writes each file at `_immutable-<sha256>-<name>` and the entry's `pronto-assets` map names them | no: a URL's bytes never change; but a kept tab learns of nothing until it navigates, since the shell ignores the worker's announcements where the map exists (`shell.js:608`) and polls only under `liveUpdates` |

The third is the only one in which mixing is impossible by construction rather
than detected, and it already runs in production; what it lacks is an update
path for a tab that stays open.

## The design

**A deployment is its entry.** Every target builds its served tree the way the
edge does: each file a page may run or fetch is written at its content
address, and the entry document (`shell/index.html`, the root, and every
served or rendered document) carries the map from logical name to address. The
release's identity is the digest of that map. `pages` already inlines every
file into its one document, which is the same statement made smaller.

**Two maps with two lifetimes.** The interpreter and vendor modules are
resolved by the browser's import map, which a document cannot replace once a
module has loaded; they change only at the runtime level, which restarts.
Every other file the page fetches — screens, roles, catalogues, stylesheets —
is resolved by `assetURL`, a lookup in JavaScript (`preloads.js`). The shell
holds the release it runs as an object and `assetURL` reads it, so an update
below the runtime level swaps that object and the files it names arrive at
their new addresses; nothing replaces the document's map.

**Units are addressed as directories.** A unit is a classic worker that
`importScripts` its siblings and finds its `.wasm` beside its own URL, and
import maps do not reach into workers. A unit is therefore written whole under
one address, `<dir>/_immutable-<treehash>/…`, keeping the names inside it, so
its relative loads stay within one immutable tree; the map names its entry.

**An addressed file never changes.** Hosts serve addressed paths `immutable`,
and the worker answers them from its cache forever. The build verifies the
bytes behind every address it writes or retains (`edge-addresses.ts`), so the
worker verifies nothing and parses no map: addressed paths cache-first,
navigations as below, the data plane bypassed.

**The entry is stale-while-revalidate, at the level of a whole release.** A
navigation is answered from the worker's copy of the entry when it has one and
revalidated behind it. A kept entry is a complete earlier release, since every
file it names is addressed and cached, so painting it is instant and coherent;
when the revalidated entry names another map, the page takes it as an update.
Offline, the kept entry is the page.

**A deployment is announced on the data plane.** Rather than every tab polling,
a deployment writes a row the page already syncs (a `deployment` entity the
store holds, as it holds any row); its arrival asks the page to fetch the
current map. A conditional request for the entry, whose ETag is the map's
digest, covers a page without a live store.

**An update is the difference between two maps**, and each kind of change has
one mechanism:

| what changed | level | what the page does |
|---|---|---|
| rows | data | nothing: live queries move them; never a release |
| a catalogue | words | rewords the screen in place |
| a screen's HTML or CSS | skeleton | morphs it in place (`morphScreen`), keeping focus, scroll and anything typed |
| a shared stylesheet | style | adds the new sheet and removes the old: a new address is a new sheet |
| a handler, renderer, validation or adapter | role | remounts the screens that use it, carrying drafts through the morph's `captureFields`/`restoreFields`; roles are text evaluated in a fresh compartment per mount (`jessie.js`), so nothing native is replaced |
| the routes | navigation | takes the new route table; a screen on show that no longer exists is left on the next navigation |
| the config's tables or auth, the interpreter, a vendor module | runtime | restarts into the new entry, recovering drafts and `tab` rows, as now |
| a Mecha machine's protocol | contract | `dispatch` refuses the old version (`protocol_version`); the refusal asks for the map, which changed with it |

Only the runtime level reloads the document, and only when its files changed.
The worker itself takes over running pages on its own (`skipWaiting`, `claim`)
and, holding no release state, needs no coordination with them.

**A first visit is its release.** The entry it loaded named its files by
address, so what it runs is that deployment's by construction: there is
nothing to adopt or verify, and nothing restarts.

**An open tab keeps its whole release.** After first paint, at idle, the
worker fetches the addresses its map names that it does not hold. Unchanged
files are the same addresses, so a deployment costs the bytes of what it
changed.

**The host keeps earlier releases.** A tab that has not finished precaching,
and a rendered document whose renderer was deployed before its assets, both
name addresses of a release the host may have replaced. A deployment publishes
its addresses beside the ones it retains (`edge.ts --assets-from`), in the
order assets, renderer, entry, and retains them for its rollout and the
lifetime of the tabs that use them.

**Caches are swept.** The worker keeps the addresses named by the entry it holds
and by the maps of its open clients, and deletes the rest; `generate` removes
the addresses an edit replaced, so the served tree of a development loop does
not grow without end.

## M-SSR

A document a renderer draws carries the renderer's map, as the edge's already
does (`worker-document.ts` renders from the addressed entry), and names its
release by that map and nothing else. Its adoption compares the document's
map with the current entry's and plans from their difference, as for a single
page; `pronto-cas`, `pronto-words`, the no-cache refetches at adoption and the
reload on a changed config go. The renderer and the entry are one release when
their names are derived from the same map digest; a renderer briefly ahead of
its entry draws documents whose addresses the host retains.

## Built

The first phase is built, and its contract is the references':
[release targets](../release-targets.md#a-release-is-its-entry) and
[screen updates](https://github.com/bonisoft3/omnishell/blob/v0.19.1/docs/screen-updates.md#when-a-deployment-lands).

- The edge's addressing is omnishell's `server/release-addresses.ts`, which
  every target runs: every document that boots the terminal is an entry,
  a prerendered or rendered one included, and its script hashes are the
  door's `script-src`.
- The container door addresses its tree in a stage of its own image (the
  `served` target), not at `generate`: the result follows from the committed
  sources, nothing hashed is committed, and nothing ignored is required. An
  edit under `launch --watch` is a rebuild of the door.
- The worker answers addresses forever and navigations from the entry it
  kept; per-file revalidation, the verified releases, `pronto-words` and the
  worker's messages are gone.
- A page asks its own address for the entry, past the worker, when it is shown
  again and every five minutes, and plans from the two maps: templates,
  screen styles and catalogues in place, anything else a restart that drops the
  kept entries first.
- `accept-upgrade` passes on Truco: a browser whose worker kept an earlier
  deployment ends running the one served now.

Not yet built, each its own step:

- **Levels between morph and restart.** A shared stylesheet, a role, the
  routes restart; the style, role and navigation levels above are unbuilt.
- **Announcement on the data plane.** The page asks on a timer.
- **Retention.** A container deployment keeps no earlier release, so a tab
  reaching an address only the previous one held fails that fetch; a dev
  rebuild does the same.
- **Sweeping.** The worker's address cache grows with every release a reader
  sees.
- **Units as directories.** A unit's files are addressed one by one, so a
  classic worker importing a sibling loads it unaddressed.
- **A prefixed app's map.**

## What goes, what stays

Goes:

- `shell/release.json`, the verified-release cache, client and target pins,
  the `PRONTO_RELEASE_*` protocol, `?pronto-release`, `startupReleaseId`,
  `prepareRestartRelease`'s pinned navigation and `adoptRelease`;
- per-file revalidation, the `PRONTO_SKELETON_UPDATED`, `_STYLE_`,
  `_MESSAGES_` and `_ASSET_UPDATED` messages, the `pronto-cas` and
  `pronto-words` comparisons and the config's no-cache recheck;
- the worker's digest verification of release bodies;
- `terminal.liveUpdates`, and the edge's refusal of live updates.

Stays: `morphScreen` and the screen handle's `morph`, the restart's draft and
`tab` recovery, the planner (re-expressed over two maps), and
`edge-addresses.ts`, run for every target rather than the edge alone.

## Costs

- **Every target builds addresses.** The container's caddy serves the
  addressed tree `generate` writes, `immutable` for addressed paths, which ends
  the conditional request it now pays per file on every revisit; the k8s and
  docker images carry it. A local edit is a deployment, which a dev tab takes at
  its level: the development loop is the update path.
- **A revisit paints an earlier release first** when a deployment landed since,
  and takes the new one as an update; a code-level change then restarts once.
- **Retention is part of every deployment's contract**, not an option.
- **Installed apps** take it when they upgrade to the toolchain that carries
  it; the monorepo's apps take it at once.

## Open questions

- A prefixed app (served under `/<repo>/`) needs its map keyed with the prefix;
  `assetURL` matches pathnames literally.
- `edge-addresses.ts` writes any other `.html` under its tree as `.txt`, which a
  prerendered document must not become.
- Adding a table to a running store is possible in principle; until it is
  built, a change to the config's tables is a runtime update.
- The server's half — keeping old pages working across a schema migration — is
  unbuilt and its own decision: `migrate.sh` completes every pgroll migration as
  it starts, so two schema versions never coexist; PostgREST lists one schema;
  Electric shapes base tables. A data-plane refusal that asks for the map exists
  only for Mecha's `dispatch`.

## Alternatives

- **A worker per deployment** (cache names stamped with a hash of the
  deployment, a reload when it takes over). Tried in this branch and abandoned
  before it was committed: the browser hands a page to the new worker before
  the page can listen, so the worker must navigate it, which reloads the page
  for every deployment whatever changed.
- **Verified releases for every app.** Correct, and costs a restart on every
  first visit, a protocol of pins between page and worker, and a second
  identity the edge's addresses cannot share.
- **Network first for the entry.** Always current at load, one round trip
  slower on every revisit, and no better than the kept entry offline; the kept
  entry is coherent, so it paints first.
- **Polling the entry.** One request per tab every 30 seconds for an event the
  data plane already carries.

## Verification

`accept-upgrade` in Truco's acceptance is the gate, rewritten for two served
entries: a reader whose browser kept an earlier deployment runs the one served
now. Beside it, each level's case in a tab that stays open: a catalogue and a
screen change morph without a navigation, a role change remounts its screen
with a draft intact, a runtime change restarts once with drafts, and a first
visit navigates once.
