// Babylon 9.31 in a page sealed by omnishell's lockdown: which load order and
// which engine get as far as a rendered frame.
//
//   deno run -A lockdown.ts <ses-first|babylon-first> <null|webgl|webgpu> [moderate|severe] [--metadata]
import { chromium } from "npm:playwright@1.61.1"

const [order = "ses-first", engine = "null", overrideTaming = "moderate"] = Deno.args.filter((a) => !a.startsWith("--"))
const metadata = Deno.args.includes("--metadata")
const BABYLON = "https://cdn.jsdelivr.net/npm/babylonjs@9.31.0/babylon.js"
const SRI = "sha384-GbwOam+gaf7GWvN708CvUiGqRFPFMS/lpYod2JfIip04KMa4TIJ8HXRjhwvT9DMC"
const ses = await Deno.readTextFile(new URL("../../../../../omnishell/interpreter/vendor/ses.umd.min.js", import.meta.url))
const babylon = new Uint8Array(await (await fetch(BABYLON)).arrayBuffer())
const digest = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest("SHA-384", babylon))))
if (`sha384-${digest}` !== SRI) throw new Error(`${BABYLON} is not the pinned file`)

const seal = `${metadata ? `<script>Object.defineProperty(Symbol, "metadata", { value: Symbol("Symbol.metadata") })</script>` : ""}
<script src="/ses.js"></script>
<script>lockdown({ errorTaming: "unsafe", overrideTaming: ${JSON.stringify(overrideTaming)} }); __log.push("locked")</script>`
const page = `<!doctype html><html><body><canvas id="c" width="640" height="360"></canvas>
<script>window.__log = []; window.onerror = (m) => __log.push("onerror: " + m)</script>
${order === "ses-first" ? seal + `<script src="/babylon.js"></script>` : `<script src="/babylon.js"></script>` + seal}
<script>
(async () => {
  try {
    const B = BABYLON, kind = ${JSON.stringify(engine)}, canvas = document.getElementById("c")
    const engine = kind === "null" ? new B.NullEngine() : kind === "webgl" ? new B.Engine(canvas, true) : new B.WebGPUEngine(canvas)
    if (kind === "webgpu") await engine.initAsync()
    const scene = new B.Scene(engine)
    const camera = new B.TargetCamera("camera", new B.Vector3(0, 5, -10), scene)
    camera.setTarget(B.Vector3.Zero())
    new B.HemisphericLight("sky", new B.Vector3(0, 1, 0), scene)
    const box = B.MeshBuilder.CreateBox("box", { size: 2 }, scene)
    box.material = new B.StandardMaterial("paint", scene)
    const texture = new B.DynamicTexture("sign", { width: 64, height: 64 }, scene, false)
    texture.getContext().fillRect(0, 0, 64, 64)
    texture.update()
    await scene.whenReadyAsync()
    for (let i = 0; i < 30; i++) { box.rotation.y += 0.05; scene.render() }
    __log.push("rendered 30 frames")
  } catch (e) { __log.push("error: " + (e && e.stack || e)) }
  window.__done = true
})()
</script></body></html>`

// WebGPU needs a secure context; the routes answer before any network.
const browser = await chromium.launch({ channel: "chromium", args: ["--enable-unsafe-webgpu"] })
const tab = await browser.newPage()
await tab.route("https://spike.test/**", (route) => {
  const at = new URL(route.request().url()).pathname
  const js = "text/javascript; charset=utf-8"
  if (at === "/") return route.fulfill({ contentType: "text/html; charset=utf-8", body: page })
  if (at === "/ses.js") return route.fulfill({ contentType: js, body: ses })
  if (at === "/babylon.js") return route.fulfill({ contentType: js, body: new TextDecoder().decode(babylon) })
  return route.fulfill({ status: 404 })
})
await tab.goto("https://spike.test/")
await tab.waitForFunction(() => (globalThis as unknown as { __done?: boolean }).__done, null, { timeout: 60_000 })
console.log(JSON.stringify({ order, engine, overrideTaming, metadata, log: await tab.evaluate(() => (globalThis as unknown as { __log: string[] }).__log) }))
await browser.close()
