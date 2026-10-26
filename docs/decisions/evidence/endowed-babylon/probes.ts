// The kinetic worker's realm deny: Babylon 9.31 renders on a transferred
// OffscreenCanvas with WebGPU in a worker whose globals are pruned to an
// allow-list, then plain JavaScript — the worst case for app code — tries every
// way out. The routes count each request that would have reached the network.
//
//   deno run -A probes.ts [--csp] [--eval] [--lockdown]
//
// --csp serves the worker with connect-src 'none' and script-src limited to
// babylon.js; --eval adds 'unsafe-eval', which SES compartments need; --lockdown
// seals the worker with SES after Babylon loads, before the scene.
import { chromium } from "npm:playwright@1.61.1";
const csp = Deno.args.includes("--csp");
const unsafeEval = Deno.args.includes("--eval");
const seal = Deno.args.includes("--lockdown");
const BABYLON = "https://cdn.jsdelivr.net/npm/babylonjs@9.31.0/babylon.js";
const SRI = "sha384-GbwOam+gaf7GWvN708CvUiGqRFPFMS/lpYod2JfIip04KMa4TIJ8HXRjhwvT9DMC";
const ses = await Deno.readTextFile(new URL("../../../../../omnishell/interpreter/vendor/ses.umd.min.js", import.meta.url));
const babylonBytes = new Uint8Array(await (await fetch(BABYLON)).arrayBuffer());
const digest = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest("SHA-384", babylonBytes))));
if (`sha384-${digest}` !== SRI) throw new Error(`${BABYLON} is not the pinned file`);
const babylon = new TextDecoder().decode(babylonBytes);
const ES = ["Object","Function","Array","Number","parseFloat","parseInt","Infinity","NaN","undefined","Boolean","String","Symbol","Date","Promise","RegExp","Error","AggregateError","EvalError","RangeError","ReferenceError","SyntaxError","TypeError","URIError","globalThis","JSON","Math","Intl","ArrayBuffer","Atomics","Uint8Array","Int8Array","Uint16Array","Int16Array","Uint32Array","Int32Array","BigUint64Array","BigInt64Array","Uint8ClampedArray","Float32Array","Float64Array","Float16Array","DataView","Map","BigInt","Set","WeakMap","WeakSet","Proxy","Reflect","FinalizationRegistry","WeakRef","decodeURI","decodeURIComponent","encodeURI","encodeURIComponent","escape","unescape","eval","isFinite","isNaN","Iterator","SharedArrayBuffer","console"];
// What Babylon's WebGPU path and a worker's one channel need, each with why.
const ALLOW = {
  BABYLON: "the endowment",
  self: "Babylon's UMD wrapper and feature checks read it",
  navigator: "navigator.gpu, the adapter; its writers are deleted below",
  OffscreenCanvas: "the surface the host transferred",
  OffscreenCanvasRenderingContext2D: "DynamicTexture's 2D drawing",
  ImageData: "DynamicTexture uploads", ImageBitmap: "texture uploads", createImageBitmap: "texture uploads from preloaded bytes",
  performance: "Babylon's frame timing; pixels only",
  setTimeout: "Babylon's deferred work", clearTimeout: "", setInterval: "", clearInterval: "", queueMicrotask: "",
  requestAnimationFrame: "the frame loop", cancelAnimationFrame: "",
  postMessage: "the one channel out, which the host filters", onmessage: "the host's channel in", addEventListener: "", removeEventListener: "", dispatchEvent: "",
  Event: "", EventTarget: "", MessageEvent: "", ErrorEvent: "",
  TextDecoder: "WGSL source handling", TextEncoder: "",
  Blob: "Babylon builds blobs from bytes it holds", URL: "Babylon's URL parsing; no fetch survives to use one",
  location: "Babylon reads the base URL",
  WebGL2RenderingContext: "Babylon's feature probe", WebGLRenderingContext: "",
};
const prune = `
const ES = new Set(${JSON.stringify(ES)}); const ALLOW = new Set(${JSON.stringify(Object.keys(ALLOW))});
const removed = [];
for (let o = self; o && o !== Object.prototype; o = Object.getPrototypeOf(o)) {
  for (const k of Reflect.ownKeys(o)) {
    if (typeof k !== "string" || ES.has(k) || ALLOW.has(k) || k.startsWith("GPU") || k === "constructor") continue;
    if (delete o[k]) removed.push(k); else removed.push("KEPT:" + k);
  }
}
for (const k of ["storage", "locks", "serviceWorker", "permissions", "connection", "usb", "hid", "serial", "bluetooth", "wakeLock", "sendBeacon", "mediaCapabilities", "ml"]) {
  for (let o = navigator; o && o !== Object.prototype; o = Object.getPrototypeOf(o)) if (Object.prototype.hasOwnProperty.call(o, k)) delete o[k];
}
`;
const worker = `
const log = (m) => postMessage(String(m));
importScripts("/babylon.js");
${seal ? `importScripts("/ses.js"); lockdown({ errorTaming: "unsafe" }); log("locked");` : ""}
${prune}
log("pruned " + removed.length + " globals; still configurable-kept: " + removed.filter(k => k.startsWith("KEPT")).join(","));
log("left: " + Object.getOwnPropertyNames(self).filter(k => !ES.has(k)).concat(Object.getOwnPropertyNames(Object.getPrototypeOf(self))).join(","));
addEventListener("messageerror", (e) => log("messageerror")); addEventListener("message", async ({ data: canvas }) => {
  const B = BABYLON; const out = {};
  try {
    const engine = new B.WebGPUEngine(canvas); await engine.initAsync(); log("init");
    const scene = new B.Scene(engine);
    const camera = new B.TargetCamera("c", new B.Vector3(0, 5, -10), scene); camera.setTarget(B.Vector3.Zero());
    new B.HemisphericLight("h", new B.Vector3(0, 1, 0), scene);
    const box = B.MeshBuilder.CreateBox("b", { size: 2 }, scene); const mat = new B.StandardMaterial("m", scene); box.material = mat;
    const dt = new B.DynamicTexture("dt", { width: 64, height: 64 }, scene, false); dt.getContext().fillRect(0,0,64,64); dt.update();
    await scene.whenReadyAsync(); for (let i = 0; i < 30; i++) scene.render();
    log("rendered after prune");
    // App code below: plain JS, the worst case for what reaches out.
    const F = [].constructor.constructor;
    const probes = {
      "fetch": () => fetch("https://spike.test/beacon?fetch"),
      "Function('return fetch')": () => F("return fetch")()("https://spike.test/beacon?ctor"),
      "XMLHttpRequest": () => new XMLHttpRequest(),
      "WebSocket": () => new WebSocket("wss://spike.test/"),
      "EventSource": () => new EventSource("/beacon?es"),
      "WebTransport": () => new WebTransport("https://spike.test/"),
      "importScripts": () => importScripts("/beacon?importScripts"),
      "dynamic import()": () => F("return import('https://spike.test/beacon?import')")(),
      "indexedDB": () => indexedDB.open("x"),
      "caches": () => caches.open("x"),
      "BroadcastChannel": () => new BroadcastChannel("x").postMessage(1),
      "Worker": () => new Worker("/beacon?worker"),
      "SharedWorker": () => new SharedWorker("/beacon?shared"),
      "navigator.storage": () => navigator.storage.getDirectory(),
      "navigator.locks": () => navigator.locks.request("x", () => {}),
      "navigator.sendBeacon": () => navigator.sendBeacon("/beacon?sb"),
      "canvas.ownerDocument": () => { const d = engine.getRenderingCanvas().ownerDocument; if (!d) throw new Error("undefined"); return d; },
      "dt ctx.canvas.ownerDocument": () => { const d = dt.getContext().canvas.ownerDocument; if (!d) throw new Error("undefined"); return d; },
      "mesh.getScene().getEngine()._device": () => { const d = box.getScene().getEngine()._device; return "reachable GPUDevice (pixels only): " + typeof d; },
      "B.Texture(url)": () => new Promise((ok, no) => { new B.Texture("https://spike.test/beacon?texture.png", scene, false, true, 1, () => ok("loaded"), (m, e) => no(new Error(m || e))); }),
      "B.Tools.LoadFile": () => new Promise((ok, no) => B.Tools.LoadFile("https://spike.test/beacon?loadfile", ok, undefined, undefined, false, (r, e) => no(e || new Error("failed")))),
      "B.Tools.LoadScript": () => new Promise((ok, no) => B.Tools.LoadScript("https://spike.test/beacon?loadscript.js", ok, (m) => no(new Error(m)))),
      "B.Tools.Download": () => B.Tools.Download(new Blob(["x"]), "x.txt"),
      "B.Tools.CreateScreenshot": () => new Promise((ok, no) => { try { B.Tools.CreateScreenshot(engine, camera, 64, ok); setTimeout(() => no(new Error("no callback")), 2000); } catch (e) { no(e); } }),
      "scene.debugLayer.show": () => scene.debugLayer.show().then(() => "shown"),
      "B.Database (offline)": () => new Promise((ok, no) => { new B.Database("https://spike.test/beacon?db.babylon", () => ok("opened"), () => no(new Error("no IndexedDB")), true); setTimeout(() => no(new Error("never opened")), 2000); }),
      "postMessage undeclared": () => { postMessage({ kind: "exfil", secret: 1 }); return "sent (the host must drop it)"; },
    };
    for (const [name, probe] of Object.entries(probes)) {
      try { const r = await Promise.race([Promise.resolve().then(probe), new Promise((ok) => setTimeout(() => ok("pending 3s"), 3000))]); out[name] = "REACHED: " + String(r).slice(0, 80); }
      catch (e) { out[name] = "blocked: " + String(e && e.message || e).slice(0, 90); }
    }
  } catch (e) { out.error = String(e && e.stack || e).slice(0, 500); }
  log(JSON.stringify(out)); log("done");
});
log("ready");
`;
const page = `<!doctype html><body><canvas id=c width=640 height=360></canvas><script>
window.__log=[]; const w = new Worker("/w.js"); w.onmessage = (e) => { __log.push(e.data); if (e.data === "ready") { const off = document.getElementById("c").transferControlToOffscreen(); w.postMessage(off, [off]); } if (e.data === "done") window.__done = true; };
w.onerror = (e) => { __log.push("worker error: " + e.message); window.__done = true; };
</script></body>`;
const b = await chromium.launch({ channel: "chromium", args: ["--enable-unsafe-webgpu"] });
const p = await b.newPage(); const beacons: string[] = [];
p.on("console", (m) => { if (/Content Security|Refused/.test(m.text())) beacons.push("csp: " + m.text().slice(0, 120)); });
await p.route("https://spike.test/**", async (r) => {
  const u = new URL(r.request().url()); const js = "text/javascript; charset=utf-8";
  if (u.pathname === "/") return r.fulfill({ contentType: "text/html", body: page });
  if (u.pathname === "/w.js") return r.fulfill({ contentType: js, body: worker, headers: csp ? { "content-security-policy": `default-src 'none'; connect-src 'none'; script-src ${unsafeEval ? "'unsafe-eval' " : ""}https://spike.test/babylon.js https://spike.test/ses.js; worker-src 'none'` } : {} });
  if (u.pathname === "/babylon.js") return r.fulfill({ contentType: js, body: babylon });
  if (u.pathname === "/ses.js") return r.fulfill({ contentType: js, body: ses });
  beacons.push(u.search || u.pathname); return r.fulfill({ status: 200, contentType: "text/plain", body: "x" });
});
await p.goto("https://spike.test/");
await p.waitForFunction(() => (window as any).__done, null, { timeout: 40000 }).catch(() => {});
for (const l of await p.evaluate(() => (window as any).__log)) console.log(String(l).slice(0, 4000));
console.log("requests that reached the network:", JSON.stringify(beacons));
await b.close();
