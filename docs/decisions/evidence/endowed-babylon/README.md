# Babylon in sealed and pruned realms, for the endowed-Babylon record

[The record](../../2026-10-22-endowed-babylon.md)'s measurements, 2026-10-22,
with the pinned `babylonjs@9.31.0` (its SRI checked) and omnishell's vendored
SES in Playwright's Chromium.

`lockdown.ts` seals a page with omnishell's lockdown call and builds one scene:

    deno run -A lockdown.ts <ses-first|babylon-first> <null|webgl|webgpu> [moderate|severe] [--metadata]

`probes.ts` renders on a transferred OffscreenCanvas with WebGPU in a worker
whose globals are pruned to `ALLOW`, then tries every way out:

    deno run -A probes.ts [--csp] [--eval] [--lockdown]

Each prints the page's log and, for `probes.ts`, every request that would have
reached the network.
