---
type: decision
title: "Endowed Babylon: the kinetic plane's renderer in a worker realm that can only paint"
description: Accepted, the presenter role built — raw Babylon 9.31 renders with WebGPU in a worker whose globals are pruned to an allow-list and whose CSP forbids connections and stray code, and app code there reached no network, storage or document. It cannot also be sealed by SES (Babylon writes onto Array.prototype.push), so the state that reaches a machine is computed in the sealed realm and the worker only paints; a tamed facade and a name deny-list are rejected.
status: accepted, partially built
---

# Endowed Babylon

Apex Run's renderer and audio (`renderer.js`, `audio.js`, about 3,970 lines)
are plain JavaScript the app serves. In the
[[../component-contracts#Dual planes and the kinetic contract|kinetic plane]]
the rule is that code may paint pixels and play sound, and may change state
outside only through an event a cortex machine consumes. Plain JavaScript can
reach the network, storage and the DOM, so the plane cannot vouch for it.
Jessie in an SES compartment can be vouched for, but it needs Babylon.

The question is where to put the deny: on Babylon's surface, on the names a
module writes, or on the realm Babylon runs in.

## What was measured

Both scripts are in [[evidence/endowed-babylon/README|the evidence]]. They use
the pinned `babylonjs@9.31.0` with its SRI checked, omnishell's vendored SES,
and Playwright's Chromium 149 in headless mode, measured 2026-10-22.

**Babylon cannot run in a sealed realm.** `lockdown.ts` seals a page with
omnishell's own call and builds a scene.

| Load order | Override taming | First failure |
| --- | --- | --- |
| SES, then Babylon | moderate, severe | loading: the decorator polyfill defines `Symbol.metadata` on the frozen `Symbol`, and no `BABYLON.*Engine` is defined |
| SES, then Babylon, `Symbol.metadata` defined before the seal | severe | `new Scene`: `Cannot add property next, object is not extensible` |
| Babylon, then SES | moderate, severe | `new Scene`: the same |
| Babylon, then SES, in a worker (`probes.ts --lockdown`) | moderate | `new Scene`: the same |

The same failure appears with the Null, WebGL and WebGPU engines. `Scene`'s
`activeCameras` setter runs `_ObserveArray`. It wraps an array's `push`,
`splice`, `pop`, `shift` and `unshift`, and links each wrapper by writing
`next` and `previous` onto the method it replaced, which is
`Array.prototype.push` itself. Override taming does not apply: the write adds
an own property to a shared intrinsic rather than shadowing an inherited one.
Two compartments sharing that function could signal through it, which is the
channel the seal exists to close. Babylon runs only in an unsealed realm.

**The realm deny holds in an unsealed realm.** `probes.ts` loads Babylon in a
dedicated worker. It then deletes every global that is neither an ECMAScript
intrinsic nor on an allow-list, together with `navigator`'s writers (storage,
locks, sendBeacon and the device APIs). It renders 30 frames with WebGPU on a
transferred OffscreenCanvas. It then runs plain JavaScript, the worst case for
app code, against every exit. Its routes record any request that would have
reached the network.

| Probe | Pruned | Pruned, plus the worker's CSP |
| --- | --- | --- |
| `fetch`, also through `[].constructor.constructor` | gone | gone |
| `XMLHttpRequest`, `WebSocket`, `EventSource`, `WebTransport` | gone | gone |
| `importScripts`, `Worker`, `SharedWorker`, `BroadcastChannel` | gone | gone |
| `indexedDB`, `caches`, `navigator.storage`, `navigator.locks`, `sendBeacon` | gone | gone |
| `import()` (syntax, so no global to delete) | **reached the network** | refused by `script-src` |
| `engine.getRenderingCanvas().ownerDocument`, `dynamicTexture.getContext().canvas.ownerDocument` | undefined: an OffscreenCanvas has no document | same |
| `getEngine()._device` | a GPUDevice, which can paint and do nothing else | same |
| `new Texture(url)`, `Tools.LoadFile`, `Tools.LoadScript` | fail with no fetch, no XHR, no importScripts | same |
| `Tools.Download`, `Tools.CreateScreenshot`, `debugLayer.show()` | fail or never settle, with no `window` and no loader | same |
| `new Database(url)` (offline cache) | calls back without caching: no `indexedDB` | same |
| `postMessage` with an undeclared shape | sent; the host has to drop it | same |

Requests that reached the network: one without the CSP (`import()`), and none
with it. The CSP is `default-src 'none'; connect-src 'none'; script-src
<the declared files>; worker-src 'none'`, served as the worker script's own
header. Adding `'unsafe-eval'`, which SES compartments need, still refuses
`import()` of any URL outside `script-src`.

Four non-configurable globals cannot be deleted: Babylon's own
`_BabylonUMDDynamicImportUnsupported` and `_native` flags, and the constants
`TEMPORARY` and `PERSISTENT`. None of them grants anything.

**An unsealed realm cannot keep a module deterministic.** In a compartment
before `lockdown()`, `Math["ran" + "dom"]()` and
`[].constructor.constructor("return Date.now()")()` both return values: the
first defeats the name scan with a computed key, the second reaches the realm's
`Function`. After lockdown both throw. The worker's realm deny controls where
code can reach. It does not control what code computes.

## The design, in the effects hierarchy

```
main thread, sealed by lockdown                       presenter worker, unsealed, pruned, CSP'd
cortex machine ── seed, stage ──► kinetic host                Babylon (raw, endowed)
                                  step(state, input)  ── frame ──► paint(frame) → pixels
       ◄── checkpoint, fork, finish, out of time ──┘
                                  sound(state) → cues → AudioContext compartment
```

Code has no level; a write's level is where its row lands
([[../archive/2026-10-10-hatches|the hatches record]]). Placed there, each part
of the kinetic plane answers the hierarchy's two questions — where does what it
writes live, and what happens if it happens twice:

| Part | Writes | Level | Its obligation, and who keeps it |
| --- | --- | --- | --- |
| The renderer | pixels, nothing a rung reads back | 0, projection: painting a frame twice overwrites it | no ambient authority — here the worker's realm, not a compartment |
| The simulation | its state, below `tab`, in the kinetic host's ring | 1 without a row | the log replays: the seed and the inputs give every frame again, because the realm it runs in is sealed |
| The run | progress in a `tab` row; the high score in a `server` row | 1 and 3 | the chart draws them; the high score is the machine's write |
| — | nothing outside the cluster | no 4 | — |

The renderer is level 0 with a stateful, nondeterministic implementation:
its camera smoothing, particles and GPU buffers are a cache of the
projection, whose loss costs smoothness, not truth. Level 1 promises that
the log replays, which a multithreaded renderer cannot keep, so it does not
claim it: a frame scrubbed back to is a similar picture, not the same one,
and the game's pixel parity has a tolerance where its simulation has none.

**A presenter raises nothing.** An event from the worker would land in a
chart as a source, and a source is fine where it is something a person did
or a clock the platform holds. What the worker computes is a function of its
thread's timing, recorded by nobody, and an event from it would make that a
row. A tap on the painted surface is the terminal's own input, gathered on
the main thread, so the worker never needs one.

## The presenter role

Built in pronto and omnishell. The boundary stays `isolation`; the role is a
second axis, derived: an agent with a memo is a question, and one without is a
presenter (`schema.cue` `vendored.role`). A presenter that declares a raise is
refused, and only a presenter names `scripts`, the terminal's pinned
libraries with their integrity (`terminal.cue` `presenter.scripts`). The seat
and the worker are the terminal's contract
([the seats](https://github.com/bonisoft3/omnishell/blob/v0.19.1/docs/terminal.md#the-seats)):

- **The policy.** Both doors send `interpreter/presenter.js` with its own
  `Content-Security-Policy`: `default-src 'none'; script-src 'self'
  'unsafe-eval'; connect-src blob:; worker-src 'self'`. A worker takes
  its policy from its script's response, so this governs it, while the page
  keeps its own. `worker-src` is `'self'` and not `'none'` because Firefox and
  WebKit check a module worker's own imports against it, so `'none'` refuses
  the worker its bootstrap and its unit; a nested worker is still refused, by
  the prune, which deletes `Worker` and `SharedWorker`.
- **The pinned scripts.** The terminal fetches each against its integrity, so
  the page's `connect-src` names each file a presenter uses, and the worker
  evaluates them before anything else. A module worker has no
  `importScripts`, and a module import carries no integrity, which is why the
  bytes cross and why the policy needs `'unsafe-eval'` — an evaluator in a
  realm with no authority adds none.
- **The prune.** What a policy cannot reach — IndexedDB, the cache API,
  `navigator.storage` and `locks`, `BroadcastChannel`, `sendBeacon` — is
  deleted to an allow-list with a reason per entry (`presenter-realm.js`),
  keeping the globals the pinned scripts defined. `fetch` and
  `XMLHttpRequest` stay, because Babylon's loaders read bytes the worker holds
  through blob: URLs, and the policy confines both to blob:. Babylon
  decodes its own data: URIs (the BRDF lookup table among them), so the
  policy connects to none.
- **The port.** In: the canvas, frames, props and resizes. Out: `ready`, and
  `read` of a file the unit declares or an object a blob seed ships, which the
  terminal fetches and transfers. Anything else is refused as the app's bug.

The probes of the spike are now `omnishell/playwright-tests/presenter.pw.ts`,
against the terminal's own seat and worker. Each fails where it stands, and a
second server on another origin hears nothing. A Babylon loader may call its
success callback on a refused request, reading XHR's status 0 as a local file,
which reaches nothing.

### The residuals

What the policy still admits, each closed or argued:

- **A module import of this origin.** `script-src 'self'`, which the unit's
  own imports need, admits `import("/any/path?data")`: a credentialed GET to
  the app's own door. A GET of an upstream may act — a session's sign-in
  callback — so the import is an effect. Chromium, Firefox and WebKit all send
  it as `Sec-Fetch-Dest: script` (the probe pins it), and both doors answer a
  script's fetch from a static file only (`terminal.cue`
  `presenter.scripted`): the Caddyfile refuses it with 403 wherever no file
  under `/srv` answers, and the edge Worker, which no static asset reaches,
  refuses it outright. What is left is a GET of a static file carrying a
  query, which no file server reads: the door's access log is the one place
  the bytes land, the operator's and not a reader's. Naming the unit's files
  in `script-src` instead needs the deployment's origin in the policy, which
  an edge release without a domain does not know before it deploys.
- **`'unsafe-eval'`.** Kept: the worker evaluates the pinned scripts from
  bytes the seat checked, and an evaluator in a realm with no authority adds
  none. Importing those bytes from a blob: URL instead trades it for
  `script-src blob:`, the same power over the same bytes.
- **`connect-src blob:`.** Kept: the art reaches the worker as bytes through
  the seat, and Babylon's loaders read them back through blob: URLs the worker
  made. `data:` is closed: Babylon decodes its own.

## Frame cost

`evidence/endowed-babylon/frame-cost/measure.ts` drives Apex Run's
showcase as of 571b964bd against its running stack in headless Chromium 149
with WebGPU, 1280×720: the start, the held throttle and a nitro every 4 s, 20 s
of the first stage, the resolution scale held at 1 in both. The worker build
is the same renderer behind a module worker on a transferred OffscreenCanvas,
posted the kinetic host's two states and alpha each frame.

| 20 s of stage 1 | Presented fps | Intervals over 25 ms | p95 interval | Render CPU p50 |
| --- | --- | --- | --- | --- |
| Main thread (three runs) | 51.6, 53.1, 55.6 | 219, 205, 194 | 35.0 ms | 16.2–17.4 ms |
| Worker, drawing on arrival (two runs) | 59.6, 56.3 | 32, 21 | 22.5 ms | 15.9–16.8 ms |
| Worker, drawing on its own frame (three runs) | 45.0, 46.7, 47.4 | 274, 268, 308 | 42.8 ms | 17.4–18.5 ms |

Apex Run's renderer as the built presenter (`measure-presenter.ts`, the
resolution left adaptive, as it ships), two runs: 53.4 and 50.5 presented fps,
17 and 23 intervals over 25 ms, a 22.4 and 23.0 ms p95, 18.4 and 19.3 ms of
render at p50.

The post costs 0.1 ms at p95 for 11 KB of state. Drawing on the worker's own
animation frame adds a frame of latency, and a 17 ms render then misses every
other vsync; drawing on the frame's arrival does not, and takes the render off
the thread that runs the simulation and the HUD. That is the gate the port
holds: no regression, and in headless Chromium an improvement.

## The renderer is a view

GGPO's rule, across the worker's port: each frame the host posts
`{frame, state, prev, alpha, historical}`, and `frame` goes backwards on a
rewind or a seek. The renderer keeps only cosmetic state — a camera's easing,
a particle's flight, its GPU buffers — so a jump is at worst a snap, never a
throw, and it sends nothing back: no state, no input. The worker is not a peer;
nothing it computes is reconciled with anything. Apex Run's
`tests/renderer.test.ts` renders frames out of order and checks the car is
where each says; its boot gate seeks the running host back 280 frames and
counts the worker's draws after it.

**Pixel parity.** `parity.ts` shoots the showcase at sim ticks 360, 700 and
1100, stepped to the tick exactly, with the throttle held. Two runs of the
main-thread build differ from each other by 0–5% of pixels (mean |Δ| 0.3–6/255):
the camera's easing follows wall time. The presenter build against them: 0–5.6%
(mean |Δ| 1–6.4/255), inside that noise. One run first drew a twentieth of
its pixels: in a worker Babylon sizes its buffer from the canvas's own size,
the one it set last, so each adaptive step compounded; the renderer now fits
the canvas to its CSS size before each scaling, and a test pins it.

## Built since, and not built: the run as a machine

The simulation is Jessie: `surface.engines.apexrun` is a module graph, its
modules importing each other by relative path, linked at build time by Endo's
ModuleSource and stepped by the terminal's cage, endowed with nothing
([[../archive/2026-10-23-jessie-import|Jessie import]]). Apex Run's sync test
runs on that caged engine and ends where the same run on the plain module
does. The renderer's worker imports the same files as ordinary modules, so
the tables they share are one source. Stepping in the cage costs about
110 µs a tick against 45 µs plain (Deno, saveState included), under 0.1 ms
of a 16.7 ms frame.

What stays for the cortex machine, to be designed with 1v1 racing:

1. **A kinetic child for a cortex state.** Every `#CortexActor` is a fold over
   a Mecha machine (`cortex.cue`: `machine`, `via: session | sync | local`),
   and the kinetic host is still mounted by an app's own script, not by
   declaration. A state hosting the race needs an actor kind that starts a
   host with the machine's seed and stage and turns its events into the
   machine's.
2. **The run as a Mecha machine.** A `local` actor plays a hybrid's reducer,
   so title, stage, fork, ending, initials and saved would be a machine
   declared in `state.hybrids` beside its surface rows, the shape Truco's
   match has. Today those phases live inside the simulation's own
   `stageState`, which the HUD and the renderer both read.
3. **A HUD at 60 Hz.** The showcase's HUD is about 300 lines of DOM writes per
   committed tick (timer, gauges, the route matrix, banners, the cards). A
   screen's bindings render rows; a row per tick through the store is
   untested at that rate, and a Jessie `hud(state)` applied by the platform
   is a new binding nobody has drawn.
4. **Audio as Jessie.** No role is endowed with an `AudioContext`, and the
   radio's buttons and volume would become events.
5. **The initials editor.** The arcade's three-letter entry edits an input
   key by key (`boot.js`); a handler answers a form's events, not keys.

What remains plain JavaScript in Apex Run is what `check-facts`' served-script
rule names: the custom boot, the bridge, audio, the initials helpers and the
showcase.

## Measured since

- **Firefox and WebKit** (Playwright 1.61.1's builds, Firefox 151 and WebKit
  26.5, on macOS 14). The escape probes hold in both, once the presenter's
  `worker-src` is `'self'` (above). Headed Firefox renders the game with
  WebGPU in the worker; headless Firefox finds no adapter. WebKit has no
  `navigator.gpu` here, because Safari's WebGPU needs macOS 26, so the
  renderer takes its WebGL2 path in the worker. Shipping Safari 26 on macOS
  26 and shipping Firefox are not what these builds prove.
- **Port size.** The Jessie scan denies `this`, so a class is unusable even
  though `class` and `new` are not denied names. The renderer stays plain
  JavaScript, a presenter's declared files; the simulation, which has no
  `this`, moved to Jessie.

## Rejected

- **A tamed Babylon facade in the sealed realm.** Babylon cannot run there
  (above). Behind a realm of its own, every object crossing back carries that
  realm's mutable intrinsics, so the facade becomes a per-object membrane over
  71 names.
- **Denying names in the Jessie scan, like Intl.** Member access is excused,
  `o[k]` takes a computed key, and an object Babylon hands out leads to
  `document` through its canvas on the main thread. Deleting Babylon's own
  methods breaks Babylon.
- **The simulation in the worker.** It would emit machine events from an
  unsealed realm, where the measured escapes reach the clock and randomness.
- **Patching Babylon** to drop the `Symbol.metadata` polyfill and keep
  `_ObserveArray`'s links in a WeakMap. That is two sites today, re-audited at
  every upgrade, with the seal's safety resting on a third party not touching
  intrinsics.
- **Loosening the seal**, by not freezing `Array.prototype` or `Symbol`,
  reopens the shared channel for every compartment on the page.
- **A draw list painted by omnishell.** Nothing crosses back, but its
  vocabulary (WGSL materials, instancing, generated textures, fog, cascaded
  shadows, particles, post effects) is a new platform contract sized by one
  game. The pruned worker paints with Babylon's own vocabulary.
