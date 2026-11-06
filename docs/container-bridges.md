# Container bridges

A bridge is an HTTP endpoint of a declared container hatch, selected by an
Airlock effect. The hatch owns the implementation; the bridge role supplies
internal addressing, startup dependencies and outbound network placement.

```cue
code: capabilities: hatches: crawler: {
    kind: "container"
    note: "Crawlee and native TLS transport; responses return through restricted CRUD"
}
code: state: bridges: crawler: {container: "crawler", port: 8080}
code: state: effects: acquire: {
    sink: {bridge: "crawler", idempotent: false}
    reentry: "repeat"
    note: "The worker deduplicates accepted assignments; duplicate acquisition is tolerated"
}
```

The ordinary `cluster.surface.targets.crawler` definition supplies its image/build,
command, environment and resource limits. The port defaults to 8080. The compiler
rejects an undeclared hatch or one whose kind is not `container`; runtime lowering
rejects a missing container target. Each effect's Dapr HTTP binding addresses the
selected container and port, and Airlock's mesh waits for that container to start.

The role adds `airlock-out` and a dedicated `bridge-<name>-egress` network. It does
not implicitly join the default network. Additional networks are explicit hatch
capabilities. No database credential, host port publication or callback permission
is granted by being a bridge. See [Airlock](https://github.com/bonisoft3/mecha/blob/v0.20.6/services/airlock/README.md)
for the ledger and transport contract.

## Where a bridge runs

A bridge's container reaches outside the stack, so the local stack — what
`sayt launch` and every check bring up — never runs it. It runs the bridge's
`simulator` instead, under the container's name, port, networks and bridge
wiring; the simulator's fields replace the container target's of the same
name:

```cue
code: state: bridges: crawler: {
    container: "crawler"
    simulator: {
        dockerfile: from: name: "denoland/deno:alpine-2.9.7@sha256:…"
        srcs: globs: ["simulators/crawler/**"]
    }
}
```

A simulator is the expected local default: it answers the bridge's contract
from fixtures, so a launched app shows plausible data and a check drives the
real Airlock path against known answers, one fixture path per case. `{}` runs
the container itself, for one whose own reach stays inside the stack, such as a
runner a test points at a local SMTP server. Snapcards wires its checkout,
Prodigi and Mailpit stand-ins by hand in `program_commerce.cue`; a bridge's
simulator is that pattern as a declaration.

`targets` names the release targets the real container is deployed on. No
release target lowers a bridge's container yet — the docker appliance runs no
airlock and Cloudflare Containers is not built — so `targets` stays empty and
naming one is refused.

Where a bridge does not run, the program still releases and its effects exist,
but each fails at once: the airlock settles the claimed effect `failed` with
`{bridge, target, reason: "not deployed"}` and calls neither handler nor sink,
so the row takes its `onError` arrow, no run is spent and no dead letter is left
([Airlock](https://github.com/bonisoft3/mecha/blob/v0.20.6/services/airlock/README.md#a-bridge-not-deployed)).
That is the local stack for a bridge without a simulator, and every release
target it does not name. The edge never dials a bridge's internal address. An
explicitly declared [[edge-hatches|edge hatch implementation]] can instead
provide a trusted Worker route; that route is separate from the bridge transport
and grants its own privileged execution boundary.

A target with effects still declares its clock where `meta.clocks` asks for one:
the failure is settled in the airlock's ordinary run, which a cluster scaled to
zero only reaches when the ticker wakes it.

## Activepieces

A container hatch may declare an `activepieces` specialization containing both
local and pinned catalogue pieces, selected action aliases, fixed inputs, contracts
and operator credential references. Pronto generates the container target and
immutable registry; the app authors no separate integration registry. A bridge
selects one action alias from that hatch. See [[activepieces-hatches|the contract]]
for CUE, packaging, lock updates and delivery semantics. The
[[decisions/2026-10-28-integrations|integration decision]] explains why this host
replaces Camel by default and which trigger/target capabilities remain planned.

The optional standard mail piece uses the same path as application-authored pieces;
there is no dedicated mail service or image. The framework runner image is built
from `libraries_mecha:activepieces-image` in a checkout. It has no published release
digest yet; release distribution must publish and pin that image before a mirror
can use the recipe. No digest is inferred from a source build.

## Asynchronous acquisition

A crawler acknowledges durable acceptance promptly, then writes results through
CRUD with a separately supplied restricted token. CDC triggers application parsing.
Airlock's outcome records acceptance, not crawl completion. Assignment identity,
deduplication, response persistence and recovery belong to the application protocol.

Using a container role keeps deployment independent of application parsing. Jessie
computations can replay saved responses without repeating network acquisition. The
same role can host another integration engine without changing effect addressing;
changing an implementation still requires preserving its HTTP contract.
