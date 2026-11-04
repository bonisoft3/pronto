# Action routing through Dapr

The test runs the same pinned Dapr 1.16.1 image used by Mecha against a local
HTTP fixture. A binding rooted at `/actions/sendMail` sends metadata path `/`
to `/actions/sendMail/`, and `/other` to `/actions/sendMail/other`. The fixture
accepts only the exact first path. Both outcomes pass through Dapr's status metadata.

Run from this directory with Deno 2.9.7 and Docker:

```sh
deno test --no-config --no-lock --allow-run=docker --allow-net --allow-read --allow-write test.ts
```

This validates base-path joining, not a complete production authorization boundary.
The existing Airlock `sinkPath` validator must continue rejecting traversal,
encoded paths, absolute URLs and empty segments. The future runner must reject
all suffixes and methods except the declared POST route. Trusted containers on
the bridge network are outside this handler-level scope restriction.
