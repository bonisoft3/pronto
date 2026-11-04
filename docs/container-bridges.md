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

This wiring is implemented by the Compose runtime. Declaring a bridge does not
add support for missing services in the Cloudflare, Kubernetes or Cloud Run
release targets. An explicitly declared [[edge-hatches|edge hatch implementation]]
can instead provide a trusted Worker route; that route is separate from the
Compose bridge transport and grants its own privileged execution boundary.

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
