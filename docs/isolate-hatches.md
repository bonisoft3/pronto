# Isolate hatches

An isolate hatch is a container of another shape: a module in the Workers
format that pronto bundles and serves itself, instead of an image the
program builds. A bridge reaches it as it reaches a container
([[container-bridges]]); what differs is how each release runs it.

```cue
code: capabilities: hatches: pdf: {
    kind:       "isolate"
    note:       "renders documents from plain data"
    entrypoint: "isolates/pdf/main.ts"
    files:      ["isolates/pdf/main.ts", "isolates/pdf/deno.json", "isolates/pdf/deno.lock"]
    memory:     96 // MiB of V8's old space, from 16 to 128; 128 when unset
}
code: state: bridges: pdf: {isolate: "pdf", targets: ["docker", "cloudflare"]}
code: state: effects: render: {
    sink:    {bridge: "pdf", idempotent: false}
    reentry: "repeat"
}
```

## The module

`entrypoint` is the module the bundle starts from, one of `files`, which hold
everything it imports beside its packages: its `deno.json` and lock among
them. A `deno.json` beside the entrypoint resolves its imports; without one,
no other is read. The module exports the Workers format and uses Web APIs only:

```ts
export default {
  async fetch(request: Request): Promise<Response> {
    return Response.json({ answered: await request.json() })
  },
}
```

Its configuration arrives in the request. It reads no `env` or `ctx`
argument, which Deno and Cloudflare pass differently, and imports no `Deno.*`,
`cloudflare:*` or `node:*`.

Every release builds it the same way, once, by one script (`#IsolateBuild`):
`deno bundle --platform=browser --packages=bundle`, so a package resolves to
its browser build and the module ships as one file. Elsewhere Deno serves that
build; on Cloudflare it is uploaded as it is, with wrangler's own bundling
off, so every release runs the same files.

**WebAssembly** reaches the module through a shim, `<name>.wasm.js` beside
its `.wasm`, which the bundle leaves outside itself:

```js
import source module from "./add.wasm"
export default module
```

A source import is a `WebAssembly.Module` under Deno and on a Worker alike.
The other forms are not portable: Cloudflare refuses to compile bytes at
load, which is what `deno bundle` makes of a `.wasm` it inlines, and a plain
`.wasm` import is an instance under Deno and a module on a Worker. The shim
and its `.wasm` are among `files`, anywhere in them, and a module imports the
shim as it imports anything, by a relative path or an alias of its
`deno.json`. The bundler never reads a shim: it bundles a copy of the sources
in which each shim takes its module from a registry, `shims.js`, which
imports the real shims beside it, and the build's `entry.js` loads that
registry before the bundle. The build lands in one directory of the hatch's,
where a shim and its `.wasm` are found by their names, so no two of an
isolate's WebAssembly files share a name.

## Where it runs

| Where | Runs as | Memory | Time |
|---|---|---|---|
| the local stack, under its `simulator` or `simulator: {}` | a bayt target pronto generates (`#IsolateContainer`), whose one cmd builds the module and whose process serves it: bayt runs both in the image (Debian, Deno from its pinned image) and on the host alike | V8's old-space limit, `memory` | the host's deadline |
| docker | a process of the appliance: the airlock's own Deno running the host and the build copied from the `<hatch>-appliance` image, on a port from 9100; the appliance refuses to start with its door's `PORT` on that port | V8's old-space limit, `memory` | the host's deadline |
| cloudflare | a Worker of its own, `<dispatcher>-<bridge>` (past 63 characters, its head and a hash of the whole), with no route, deployed before the dispatcher that binds it by service | the platform's 128 MB per isolate | the platform's CPU limit |

Outside Cloudflare the build runs behind a host (`#IsolateHost`), a
supervisor whose module runs in a process of its own (`#IsolateRunner`). That
process reads its build alone, holds the hatch's `memory`, and reaches the
network but for the machine's own addresses, by number or by name: in the
docker appliance, where the database, daprd and the airlock listen on
loopback, the module reaches none of them, as a Worker reaches nothing of the
dispatcher's. A request reaches the module as a service binding hands it on
Cloudflare: one with an empty body, as HTTP carries a bodyless POST, has none.

A call has the deadline (`#IsolateDeadlineMs`, 50 s, past the airlock's own
45 s call timeout, so the airlock gives the call up first and its run errs as
on a transport's failure) from when the module takes it up, so calls waiting
behind a busy one spend none of it. A call that outlives it, a module that
takes up no call for as long, or a module's process that dies, past its heap
or otherwise, has the host replace that process: terminating a worker would
leave a loop it is in running, and ending a process ends it. The calls in it
break their connections before any status, as a crashed container's would, so
the airlock counts each as a transport's failure and runs it again, and no
status stands for an answer the module never gave. A module that throws, or
answers `Response.error()`, fails its call the same way; on Cloudflare the
service binding's call fails alike.

k8s and gcp run no airlock, so a bridge names `docker` and `cloudflare` only, as a
container bridge does.

An isolate reaches the internet as a container bridge does: `--allow-net`
outside Cloudflare, on the bridge's own egress network, and a Worker's
outbound access there. The local stack runs it as any bridge: its
`simulator`, or the module itself under `simulator: {}`. There the build lands beside the sources, under
`.isolate/<hatch>/`, which pronto's `.isolate/.gitignore` keeps out of the
repository.

The bridge's container, port (8080) and appliance form are derived, so an
isolate bridge sets none of them, nor `instance_type`, which sizes a
Cloudflare Container. A bridge names an isolate hatch by `isolate` and a
container hatch by `container`; naming one by the other is refused. Several
bridges may share an isolate, as they share a container: on docker it is one
process. On cloudflare a container is one bridge's, and an isolate is too: a
bridge naming cloudflare shares its isolate with no other.

## Why an isolate

A library run inside the caller's own sandbox, as an endowment is, can only be
bounded by checking its input, and a renderer or a parser has more loops and
allocations its input drives than a check can enumerate. In an isolate the
bound is the isolate's, whatever the module does: a library whose work grows
with its input belongs in one.
