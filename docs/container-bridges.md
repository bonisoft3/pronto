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
is granted by being a bridge. See [Airlock](https://github.com/bonisoft3/mecha/blob/v0.20.1/services/airlock/README.md)
for the ledger and transport contract.

This wiring is implemented by the Compose runtime. Declaring a bridge does not
add support for missing services in the Cloudflare, Kubernetes or Cloud Run
release targets.

## Mail

The SMTP implementation is a reusable container recipe. An app imports
`github.com/bonisoft3/pronto/clusters:mecha` and instantiates it as an ordinary hatch:

```cue
code: capabilities: hatches: smtp: {
    kind: "container"
    note: "SMTP transport with STARTTLS and connected-address validation"
}
code: state: bridges: mail: {container: "smtp"}
cluster: surface: targets: smtp: (mecha.#MailContainer & {
    image: cluster.meta.images.airlock
    server: "smtp.provider.example:587"
    domain: "mail.example"
    user: "SMTP_USER"
    password: "SMTP_PASSWORD"
}).target
```

Effects continue selecting `sink.bridge: "mail"`. The recipe preserves the mail
implementation's narrow Deno permissions, required credential variables and default
STARTTLS policy. Credentials must be supplied together. A custom bridge does not
inherit these SMTP-specific restrictions: its own implementation and container
capabilities determine its reach.

## Asynchronous acquisition

A crawler acknowledges durable acceptance promptly, then writes results through
CRUD with a separately supplied restricted token. CDC triggers application parsing.
Airlock's outcome records acceptance, not crawl completion. Assignment identity,
deduplication, response persistence and recovery belong to the application protocol.

Using a container role keeps deployment independent of application parsing. Jessie
computations can replay saved responses without repeating network acquisition. The
same role can host another integration engine without changing effect addressing;
changing an implementation still requires preserving its HTTP contract.
