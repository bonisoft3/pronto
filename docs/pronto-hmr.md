---
type: concept
title: Pronto HMR
description: Direct presentation synchronization, the checks it defers, and the boundary between a working preview and a validated application.
---

# Pronto HMR

Pronto keeps presentation edits fast by serving authored HTML and CSS directly
inside an already generated application. The program declares the available
capabilities; HTML selects how to present and invoke them. Development
configuration covers those declarations independently of the exact bindings in
the current HTML. Saving a screen therefore does not require deriving another
program, regenerating IR, or rebuilding the application.

The tradeoff is **deferred validation**. A watch session can display source that
has not passed the compiler or the markup checks. A working preview is evidence
about an interaction, not evidence that the current source conforms to Pronto.
This distinction matters especially when an LLM authors the application: runtime
success must not become the agent's completion criterion.

## What happens on a save

1. `sayt launch --watch` generates/builds through the normal dependency graph,
   prepares a development serving tree, and starts the stack with Compose Watch.
2. The editor saves a declared HTML or CSS source. Compose Watch copies it to its
   served target. The save does not invoke Pronto, evaluate CUE, or inspect the
   meaning of the edit.
3. A browser reload requests those bytes. Runtime SSR reads the updated
   presentation on its next request. Neither Caddy nor the renderer needs to
   restart for these edits.

There is no resident compiler, custom semantic watcher, or Compose host bind
mount. Bayt's watch metadata describes file actions; ordinary stack tools own
restart/rebuild actions where needed. The Compose readiness message confirms
transport is working, not that every screen is valid. This is file synchronization,
not automatic browser module replacement: browser refresh is currently manual.

Independently edited presentation must live in files. CUE `markup` still needs
generation. Named actor charts remain program declarations referenced by HTML;
see [[screens]] for the binding syntax. `ir.html` and `program_derived.cue` are
compiler metadata, not application presentation to synchronize into the browser.
Explicit generation still refreshes derived facts and the generated IR views.

## Capability availability is not authorization

The development shell registers declared entities, handlers, and available
adapters more broadly than the ordinary shell configuration derived from current
screen usage. For example, adding a region for an existing entity can work after
a save even if the previous ordinary shell configuration did not include that
entity. That is the intended behavior: the capability was declared in the
program, but not previously selected by this screen.

Declared capabilities include composed Cortex handlers as well as authored
handlers. Adapter lookup preserves each route's explicit selection; otherwise,
an unambiguous app adapter takes precedence over the built-in of the same name.
If different routes declare different adapters with that name, another route
must declare its choice explicitly rather than inherit an arbitrary one.

This does not create a new entity, install a handler absent from the generated
configuration, or change database permissions. Schema, validation, access
metadata, actor constraints, and server authorization remain in force. A table
being available to the terminal does not authorize reading every row. Broader
client configuration is not an authorization boundary; server policy must remain
the authority for server-held data. See [[access]].

However, runtime enforcement does not cover every authoring rule. An undeclared
capability may fail when exercised, an invalid branch may remain unvisited, and
invalid CSS or inert markup can simply produce an apparently usable page. Some
runtime checks fail explicitly, such as an unknown named actor chart; that is not
a substitute for checking every screen. We do not promise that every invalid
watch edit fails visibly or immediately.

## Launch and its validation counterpart

The current Pronto builder makes launch depend on build, and build on generate.
Sayt's Bayt dispatch refreshes generation before invoking the launch target, with
incremental work skipped according to its input fingerprints. This applies to
ordinary launch and entry into watch mode. Generation performs derivation and
its own checks; it is not merely a file copy.

**Launch does not transitively require lint, test, or integrate.** Those are
explicit validation targets. This separation is intentional: execution verbs
prepare and run the application; their validation counterparts judge it. Launch
may succeed while lint fails. The implementation is in
[[../builders/bayt.cue|the Pronto builder]],
[Sayt dispatch](https://github.com/bonisoft3/sayt/blob/v0.45.3/bayt-task.nu), and
[the verb dependency defaults](https://github.com/bonisoft3/bayt/blob/v0.68.2/stacks/sayt/sayt.cue).

Ordinary launch does not select the broad development configuration or the live
presentation tree. It follows the generated application path. Watch launch
selects the development configuration; subsequent source saves bypass the gates
entirely. Starting a new launch re-enters the dependency graph, but does not turn
that graph into a full validation suite.

Consequently, “launch succeeded” means its generation/build/startup
requirements succeeded. It does not mean “the application is correct,” nor even
“all static Pronto checks passed.” A process becoming healthy cannot prove every
screen, event path, policy interaction, or acceptance requirement.

## Named tradeoffs

| Tradeoff | What can happen | Boundary that catches it |
| --- | --- | --- |
| Unvalidated presentation | A typo, invalid binding, forbidden markup, or CSS violation reaches the preview. | Explicit lint against current source, including its generation prerequisite; rendered checks where needed. |
| Broader development configuration | A binding works using a declared capability absent from the previous ordinary configuration. Development success can hide a derivation or packaging defect. | Regenerate and exercise the ordinary configuration with integration checks. |
| Stale derived facts | Reads, writes, handler usage, and IR neighbourhoods describe the last generation, not the live HTML. | Generate before treating metadata as current evidence. |
| Stale route policy | A changed screen still uses the generated access/rendering decision until regeneration. An SSR edit may fail or produce an unsuitable first document even if client navigation appears to work. | Generate/lint and route integration checks; server authorization remains required throughout. |
| Mixed revisions | Several saves, or an explicit configuration regeneration during watch, can temporarily expose files from different revisions. Sync is not an atomic application deployment. | Finish edits and validate a fresh ordinary launch; restart/relaunch after contract changes. |
| Different serving behavior | Development disables static validators and retained SSR documents; SSG routes use the browser shell. Cache, prerender, and release asset defects may be invisible. | Ordinary integration plus the release/verify path for the packaged target. |
| Different resource use | More declared modules/collections are available; development read modes follow program invariants and allow unused public collections to remain lazy. | Measure performance with ordinary/release configuration. |

These are preview relaxations. They do not waive source-language restrictions,
access policy, or the checks required to finish an agent turn. A successful click
in watch mode is not permission to accept an otherwise invalid program.

## Changes that leave the fast path

Binding an already declared capability and changing presentation use direct sync.
Adding an entity, handler declaration, chart, route, or source-file mapping needs
explicit generation. Changing route policy or backend contracts also needs the
appropriate restart/relaunch, migration, and owning checks. File transport cannot
make those semantic decisions from an HTML save.

## Validation gates

It is acceptable for launch to succeed with inconsistent presentation, provided
the owning validation gate rejects that source. Undeclared capabilities and
invalid bindings belong in lint; their appearing to work in a preview must not
make lint accept them. Generation can still reject inputs it cannot compile.

The important regression is a false green validation result, not a preview that
runs before validation. Checks must inspect current authored HTML/CSS, refresh
derived inputs as required, and enforce the declared program rather than infer
validity from the broader development configuration. If an invalid binding can
both run and pass its owning static check, that is a checker defect, not an
accepted HMR tradeoff. Not every defect is statically decidable; behavior and
rendered output still require test and integrate.

Use generate/lint for declarations and bindings, build/test for implementation,
and launch/integrate for rendered behavior and acceptance flows. Run these checks
against the ordinary configuration; release/verify checks the packaged target.
Saves after a successful check create a new, unvalidated revision.

## Native watch is deferred

`launch@host --watch` (including a forwarded `-w`) fails explicitly, directing the author
to `launch --watch`. Ordinary `launch@host` remains available. Sayt's default
platform is named `local`; in this Pronto builder it selects Docker, not native
services. The native target is `host`.

Docker launch gives the watch contract a clear boundary: the image supplies the
runtime and build environment, Compose delivers declared source changes, and
rebuild actions produce a new image. Native launch shares the machine's tools
and filesystem, so the equivalent lifecycle needs an explicit design.

Process Compose can supervise services, restart them on file changes, and cascade
restarts to dependents. Bayt already emits separate build processes that invoke
Taskfile targets. However, restarting a service does not rerun its upstream build
process, and Pronto's native launcher currently substitutes a no-op `task` after
the outer invocation has built the application. Watch-driven builds cannot rely
on that startup shortcut.

The same Process Compose emitter also serves other lifecycles. `release@docker`
must run packaged services without requiring Taskfile or a source/build toolchain.
Integration needs a deliberately selected, stable test subject; silently inheriting
development watchers would let source changes alter it during a check. Watch
behavior therefore cannot be added to every Process Compose process globally.

Options to evaluate before enabling native watch:

| Option | Mechanism | Cost or limitation |
| --- | --- | --- |
| Presentation-only host watch | Serve linked HTML/CSS using the shared development configuration. Require relaunch for other changes. | Small implementation, but a deliberately narrower contract than Docker watch; unsupported reactions must be rejected or clearly excluded. |
| Development build overlay | Put build-input watches on one-shot Bayt build processes and cascade to their consumers after successful builds. Use native watches for restart-only changes. | Must restore real Taskfile execution for development, avoid recursion into launch, and verify failure/recovery and dependency ordering. Release must exclude the overlay. |
| Build check on service restart | Run the service's Bayt build task before each service start; fingerprints decide whether work is needed. | Reuses incremental decisions but requires safe concurrent builds, correct signal handling, and separation of build tasks from orchestration tasks. Shared prerequisites may be checked repeatedly. |

Reload commands could remain separate Watchexec helpers or become watched
one-shot Process Compose commands. The latter needs tests for startup ordering,
repeated execution, command failures, and recovery before replacing Watchexec.
Tools/dependency changes also need defined rebuild behavior; restarting an old
executable is not equivalent to rebuilding its environment.

Any complete host projection must share Compose's reaction defaults, reject
unsupported declarations, keep generated outputs out of watched inputs, and
specify whether changed process topology requires relaunch. Test it separately
for development, integration, and packaged release. Until those policies are
settled, no host watch overlay or reload helpers are emitted.
