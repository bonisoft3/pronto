# Published HTTP piece catalogue spike

Status: local experiment. The static registry in [[runner.ts]] opts two actions from
`@activepieces/piece-http@0.13.0` into an engine-free runner. It passes only
`auth` and `propsValue`, rejecting other context reads. This is an application
selection boundary, not a sandbox: package code still has ambient runtime access.
It does not provide universal OAuth, refresh, store, files, triggers, or other
Activepieces context services. Each additional action and its required capabilities
need separate qualification.

## Reproduce

Tested on macOS arm64 with Deno 2.9.7. In this directory, run:

```sh
deno task --frozen-lockfile check
deno task --frozen-lockfile test
deno task --frozen-lockfile test:isolation
```

The lock pins the published npm package and integrity. An initial package download
requires registry access; tests send requests only to a local loopback server.
The test grants loopback network access and access to the
`NODE_TLS_REJECT_UNAUTHORIZED` environment variable, which the HTTP client writes;
without the latter, the request fails before reaching the server. This permission
is process-wide and is not evidence of safe TLS behavior or isolation.

## Observed behavior

- `parse_url` declares `returnArrays` default `true`, but raw `run` with the
  property omitted returns the first value as a string. Passing `true` returns
  an array. SDK property metadata is not automatically applied by this runner.
- The HTTP actions reject a missing URL or method in the tested cases, through
  their own code. That does not establish general schema or required-field
  validation for all actions; the host needs an explicit input contract.
- A POST receiving HTTP 503 produces one request with `retry_none` and three
  with `retry_all`. These are retries inside the piece; outer retries could
  multiply effects. The test does not establish behavior for other status codes
  or transport failures.
- A thrown error contains the request and response bodies; `continue_all`
  returns them too. The package also logs those fixture bodies under a message
  labelled sanitized. Treat results, errors, and package logs as potentially
  sensitive; a runner cannot assume secrets are hidden by the piece.
- Racing a slow invocation against an outer timer returns the timer result, then
  the same invocation completes. An outer timeout does not guarantee cancellation
  or prevent side effects. This test does not establish a cancellation mechanism
  or the piece's own timeout behavior.

The checks establish behavior for this pinned action and fixture only. They do
not establish portability to another runtime, safe arbitrary URLs, credential
isolation, or a production execution boundary.

## Worker and process isolation

[[isolation_test.ts]] invokes the registered published `parse_url` action in a
fresh Deno Worker. In a separate synthetic worker test, termination before a
scheduled fetch prevented that request from reaching loopback. Termination cannot
undo a request or side effect already sent, and this does not prove cancellation
for all native operations.

A worker writing a fixture environment variable changed the value seen by the
host and a sibling worker. A `clearEnv` subprocess did not inherit the marker,
and its subsequent mutation did not change the host value. Thus a Worker alone
does not isolate the HTTP client's environment mutation in this runtime; a
separately configured subprocess is a candidate for process-environment isolation.
The synthetic marker tests do not exercise TLS settings, establish a complete
sandbox, or prove how a terminated process affects already-sent requests. The
isolation test additionally grants local read and subprocess execution to its
parent test harness.
