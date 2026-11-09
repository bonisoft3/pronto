import assert from 'node:assert/strict'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { bridgeBuild, bridgeDockerfile, bridgeNames, type ClusterBridge, clusterBridges, onCloudflare } from './edge-bridges.ts'

const fixture = fileURLToPath(new URL('../testdata/edge-bridge/', import.meta.url))

Deno.test("a bridge's binding and class are its name, upper-cased and Pascal-cased", () => {
  assert.deepEqual(bridgeNames('sofascore'), { binding: 'BRIDGE_SOFASCORE', className: 'BridgeSofascore' })
  assert.deepEqual(bridgeNames('fetch-pages'), { binding: 'BRIDGE_FETCH_PAGES', className: 'BridgeFetchPages' })
})

// `fetch--pages` is a DNS label, and its empty segment read `undefined[0]`.
Deno.test('a bridge name with an empty segment, or two bridges meeting in one class, are refused', () => {
  assert.throws(() => bridgeNames('fetch--pages'), /empty segment/)
  const on = (name: string): ClusterBridge => ({ name, container: name, port: 8080, targets: ['cloudflare'], build: `${name}-appliance` })
  assert.equal(bridgeNames('a-1b').className, bridgeNames('a1b').className)
  assert.throws(() => onCloudflare([on('a-1b'), on('a1b')]), /bridges a-1b and a1b are both BridgeA1b/)
  assert.deepEqual(onCloudflare([on('a-1b'), on('a2b')]).map(b => b.name), ['a-1b', 'a2b'])
})

Deno.test('only the bridges naming cloudflare are containers of the dispatcher', async () => {
  const bridges = await clusterBridges(fixture)
  assert.deepEqual(bridges.map(b => b.name), ['fetch-pages', 'mail'])
  assert.deepEqual(onCloudflare(bridges).map(b => b.name), ['fetch-pages'])
})

// bayt's Dockerfile ends in packaging views, and `wrangler deploy` builds a
// Dockerfile's last stage: pointed at the whole file, the container shipped
// was a scratch image of the sources.
Deno.test("the shipped Dockerfile is the container's own stage alone, under bayt's frontend pin, with the compose file's environment", async () => {
  const [bridge] = onCloudflare(await clusterBridges(fixture))
  const build = await bridgeBuild(fixture, bridge)
  assert.deepEqual(build, {
    syntax: 'docker/dockerfile:1.27@sha256:4edf897a3ffa55b89f906fc8cc78afdb3f1834cc9c7083565e611a8a7d5fe99e',
    args: {},
    environment: { TRANSPORT_MODE: 'live', RUST_LOG: 'info' },
  })
  const text = await bridgeDockerfile(fixture, bridge, build)
  const lines = text.split('\n')
  assert.equal(lines[0], `# syntax=${build.syntax}`)
  assert.match(lines[1], /^FROM rust:1\.88\.0-bookworm@sha256:[0-9a-f]{64} AS transport-appliance$/)
  assert.equal(lines.filter(l => l.startsWith('FROM ')).length, 1)
  assert.ok(text.includes('RUN cargo build --release --locked'))
  assert.ok(text.endsWith('/usr/local/bin/transport\n'))
  assert.doesNotMatch(text, /_ctxs|_srcs|_bayt|scratch/)
})

const BUSYBOX = 'busybox:musl@sha256:03db190ed4c1ceb1c55d179a0940e2d71d42130636a780272629735893292223'
const SYNTAX = 'docker/dockerfile:1.27@sha256:4edf897a3ffa55b89f906fc8cc78afdb3f1834cc9c7083565e611a8a7d5fe99e'
const bridge: ClusterBridge = { name: 'x', container: 'x', port: 8080, targets: ['cloudflare'], build: 'x-appliance' }
/** A packaging view as bayt's _clampFlatten renders one. */
const view = (stage: string) => `FROM ${BUSYBOX} AS ${stage}_ctxs\nARG BAYT_DIR\nWORKDIR /monorepo/\${BAYT_DIR}\nCOPY --parents src/* ./\nFROM scratch AS ${stage}\nCOPY --from=${stage}_ctxs /monorepo /monorepo\n`
/** A bayt-shaped app whose Dockerfile and compose service are given. */
async function rendered(dockerfile: string, service = '', run: (app: string) => Promise<void> = async () => {}) {
  const app = await Deno.makeTempDir()
  try {
    await Deno.mkdir(path.join(app, '.bayt'))
    await Deno.writeTextFile(path.join(app, '.bayt/compose.x-appliance.yaml'), `services:\n  p-x-appliance:\n    build:\n      context: ..\n      dockerfile: .bayt/Dockerfile.x-appliance\n      target: x-appliance\n      args:\n        BAYT_DIR: \${MONOREPO_COMPOSE_MODE:+apps/p}\n        BUILDKIT_SYNTAX: >-\n          ${SYNTAX}\n${service}    scale: 0\n`)
    await Deno.writeTextFile(path.join(app, '.bayt/Dockerfile.x-appliance'), `# generated from bayt.cue — do not edit\n${dockerfile}`)
    await run(app)
  } finally {
    await Deno.remove(app, { recursive: true })
  }
}
const shipped = (dockerfile: string, service = '') => {
  let text = ''
  return rendered(dockerfile, service, async app => { text = await bridgeDockerfile(app, bridge, await bridgeBuild(app, bridge)) }).then(() => text)
}

// The first stage was taken for the container's and the next FROM for its
// view, which a multi-arch `add` (fetch stages first), a `finalCopy` (the
// build stage first, the container flattened last) and a heredoc holding a
// FROM line all broke; a target without sources has only its outs and bayt
// views.
Deno.test('the stages kept are every one before the first packaging view, whichever view bayt renders first', async () => {
  const own = `FROM alpine AS x-appliance\nARG BAYT_DIR\nWORKDIR /app\nCMD ["x"]\n`
  assert.equal(await shipped(`${own}\n${view('x-appliance_srcs').replace(/x-appliance_srcs_ctxs/g, 'x-appliance_ctxs')}\n${view('x-appliance_bayt')}`), `# syntax=${SYNTAX}\n${own}`)
  assert.equal(await shipped(`${own}\n${view('x-appliance_outs')}\n${view('x-appliance_bayt')}`), `# syntax=${SYNTAX}\n${own}`)
  assert.equal(await shipped(`${own}\n${view('x-appliance_bayt')}`), `# syntax=${SYNTAX}\n${own}`)
  const multiArch = `FROM scratch AS fetch_x-appliance_0_amd64\nADD --checksum=sha256:aa https://example.test/x-amd64 /x\nFROM scratch AS fetch_x-appliance_0_arm64\nADD --checksum=sha256:bb https://example.test/x-arm64 /x\nFROM fetch_x-appliance_0_$TARGETARCH AS fetch_x-appliance_0\n${own.replace('CMD', 'COPY --from=fetch_x-appliance_0 /x /usr/local/bin/x\nCMD')}`
  assert.equal(await shipped(`${multiArch}\n${view('x-appliance_bayt')}`), `# syntax=${SYNTAX}\n${multiArch}`)
  const finalCopy = `FROM alpine AS x-appliance_build\nARG BAYT_DIR\nWORKDIR /app\nRUN make /out/x\nFROM scratch AS x-appliance\nCOPY --from=x-appliance_build /out/x /out/x\n`
  assert.equal(await shipped(`${finalCopy}\n${view('x-appliance_bayt')}`), `# syntax=${SYNTAX}\n${finalCopy}`)
  const heredoc = `FROM alpine AS x-appliance\nARG BAYT_DIR\nWORKDIR /app\nCOPY <<'SQL' /app/q.sql\nFROM pages SELECT 1\nSQL\nRUN <<EOF <<-'EOT' cat\nFROM nothing AS x-appliance_ctxs\nEOF\n\tFROM scratch AS other\n\tEOT\nCMD ["x"]\n`
  assert.equal(await shipped(`${heredoc}\n${view('x-appliance_bayt')}`), `# syntax=${SYNTAX}\n${heredoc}`)
})

Deno.test('a Dockerfile not shaped as bayt renders one is refused', async () => {
  await rendered('FROM alpine AS other\nCMD ["x"]\n', '', app => assert.rejects(bridgeDockerfile(app, bridge, { syntax: SYNTAX, args: {}, environment: {} }), /no packaging view/))
  await rendered(`FROM alpine AS other\nCMD ["x"]\n${view('x-appliance_bayt')}`, '', app => assert.rejects(bridgeDockerfile(app, bridge, { syntax: SYNTAX, args: {}, environment: {} }), /no stage is named x-appliance before its packaging views/))
  await rendered(`FROM alpine AS x-appliance\nRUN <<EOF\necho\n`, '', app => assert.rejects(bridgeDockerfile(app, bridge, { syntax: SYNTAX, args: {}, environment: {} }), /heredoc EOF never ends/))
})

// wrangler pipes the Dockerfile into `docker build` with the app dir as its
// one context: a stage bayt wired to another service, or a value compose
// would expand at `up`, has nothing to resolve against there.
Deno.test('a container built from other contexts, or interpolating its build args or environment, is refused', async () => {
  const own = `FROM p-dep AS x-appliance\nCOPY --from=p-dep /out /out\n${view('x-appliance_bayt')}`
  await rendered(own, '      additional_contexts:\n        p-dep: service:p-dep\n', app => assert.rejects(bridgeBuild(app, bridge), /builds from other contexts \(p-dep\), which wrangler's docker build cannot be given/))
  await rendered(own, '        APP_VERSION: ${APP_VERSION:-1}\n', app => assert.rejects(bridgeBuild(app, bridge), /build arg APP_VERSION interpolates/))
  await rendered(own, '    environment:\n      SMTP_AUTH_JSON: ${SMTP_AUTH_JSON:?required}\n', app => assert.rejects(bridgeBuild(app, bridge), /environment variable SMTP_AUTH_JSON interpolates/))
  await rendered(own, '        APP_VERSION: "1.2"\n        PORT: 8080\n    environment:\n      PORT: "8080"\n      MODE: live\n', async app => {
    assert.deepEqual(await bridgeBuild(app, bridge), { syntax: SYNTAX, args: { APP_VERSION: '1.2', PORT: '8080' }, environment: { PORT: '8080', MODE: 'live' } })
  })
})
