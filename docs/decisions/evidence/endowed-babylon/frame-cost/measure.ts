// Frame cost: Apex Run's main-thread renderer (its showcase.html as of
// 571b964bd) against the same renderer in a worker drawing on a transferred
// OffscreenCanvas, same seed, same held input, over the same stretch of the
// first stage, against the app's running stack.
//   deno run -A --unsafely-ignore-certificate-errors=localhost measure.ts <baseline|worker> [seconds] [--fixed] [--raf]
// --fixed holds the resolution scale at 1 in both; --raf has the worker draw
// on its own animation frame instead of on the frame's arrival.
import { chromium } from "npm:playwright@1.61.1";
import { Buffer } from "node:buffer";
const mode = Deno.args[0];
const seconds = Number(Deno.args[1] ?? 20);
const BASE = "https://localhost:23221";
const here = new URL(".", import.meta.url);
const read = (f: string) => Deno.readTextFile(new URL(f, here));
const PINNED: Record<string, [string, string]> = {
  "babylon.js": ["https://cdn.jsdelivr.net/npm/babylonjs@9.31.0/babylon.js", "sha384-GbwOam+gaf7GWvN708CvUiGqRFPFMS/lpYod2JfIip04KMa4TIJ8HXRjhwvT9DMC"],
  "loaders.js": ["https://cdn.jsdelivr.net/npm/babylonjs-loaders@9.31.0/babylonjs.loaders.min.js", "sha384-4Lrx0JNQdcaB2SaX4xPoA2b15Fnq+ZEdBNyjRNds6RUVsA5oVRIh9GoVvIQLwBJ4"],
};
const pinned: Record<string, Uint8Array> = {};
for (const [name, [url, sri]] of Object.entries(PINNED)) {
  const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
  const digest = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest("SHA-384", bytes))));
  if (`sha384-${digest}` !== sri) throw new Error(`${url} is not the pinned file`);
  pinned[name] = bytes;
}

const browser = await chromium.launch({ channel: "chromium", args: ["--enable-unsafe-webgpu", "--ignore-certificate-errors"] });
const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 720 } });
await context.addInitScript(() => {
  // deno-lint-ignore no-explicit-any
  const w = globalThis as any;
  w.__raf = [];
  const sample = (t: number) => { if (w.__sampling) w.__raf.push(t); requestAnimationFrame(sample); };
  requestAnimationFrame(sample);
});
const js = "text/javascript; charset=utf-8";
await context.route(`${BASE}/spike/**`, async (r) => {
  const p = new URL(r.request().url()).pathname.slice("/spike/".length);
  if (p === "main.html") {
    const html = (await (await fetch(`${BASE}/showcase.html`)).text()).replace(/<script type="module" src="[^"]*showcase\.js"><\/script>/, '<script type="module" src="/spike/main.js"></script>');
    return r.fulfill({ contentType: "text/html", body: html });
  }
  if (p === "main.js") {
    let src = await (await fetch(`${BASE}/showcase.js`)).text();
    src = src.replace('"./shell/engine/bridge.js"', '"/spike/bridge.js"').replace('"./shell/engine/simulation.js"', '"/shell/engine/simulation.js"');
    src = src.replace(/canvas\.width = Math\.floor\(w \* dpr\);\n\s*canvas\.height = Math\.floor\(h \* dpr\);\n\s*if \(game && game\.renderer\) \{\n\s*game\.renderer\.resize\(canvas\.width, canvas\.height\);/,
      "if (game && game.renderer) {\n    game.renderer.resize(Math.floor(w * dpr), Math.floor(h * dpr));");
    return r.fulfill({ contentType: js, body: src });
  }
  if (pinned[p]) return r.fulfill({ contentType: js, body: Buffer.from(pinned[p]) });
  return r.fulfill({ contentType: js, body: await read(p) });
});
// The stack serves https with a local CA; Deno's fetch above needs it trusted.
const page = await context.newPage();
const errors: string[] = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
await page.goto(mode === "baseline" ? `${BASE}/showcase.html` : `${BASE}/spike/main.html`);
await page.waitForFunction(() => (globalThis as any).game?.host, null, { timeout: 120_000 });
const webgpu = await page.evaluate(() => (globalThis as any).game.renderer.isWebGPU);
const fixed = Deno.args.includes("--fixed");
const raf = Deno.args.includes("--raf");
await page.evaluate(({ fixed, raf }) => { const g = (globalThis as any).game; if (fixed) { if (g.renderer.worker) g.renderer.worker.postMessage({ type: "fixed" }); else g.renderer.setAdaptiveResolution(false); }
  if (raf && g.renderer.worker) g.renderer.worker.postMessage({ type: "sched", sched: "raf" });
  if (!g.renderer.worker) { const r = g.renderer, orig = r.render.bind(r); (globalThis as any).__rms = []; r.render = (...a: any[]) => { const t0 = performance.now(); orig(...a); if ((globalThis as any).__sampling) (globalThis as any).__rms.push(performance.now() - t0); }; } g.startRace(); g.keyState.up = true; }, { fixed, raf });
// The swoop and the countdown, then the measured stretch.
await page.waitForTimeout(7000);
await page.evaluate(() => {
  const w = globalThis as any;
  w.__sampling = true;
  w.__frame0 = w.game.renderer.engine?.frameId ?? 0;
  w.__nitro = setInterval(() => { w.game.keyState.nitro = true; setTimeout(() => { w.game.keyState.nitro = false; }, 100); }, 4000);
  if (w.game.renderer.post) { w.game.renderer.post.ms.length = 0; }
});
const before = mode === "worker" ? await page.evaluate(() => (globalThis as any).game.renderer.stats()) : null;
await page.waitForTimeout(seconds * 1000);
const out = await page.evaluate(async () => {
  const w = globalThis as any;
  w.__sampling = false;
  const g = w.game;
  const st = g.host.getState();
  const player = st.karts.find((k: any) => k.isPlayer);
  const base = { raf: w.__raf, stage: st.stageState, z: player.z, speed: player.speed };
  if (g.renderer.stats) return { ...base, worker: await g.renderer.stats(), post: g.renderer.post };
  return { ...base, rms: w.__rms, frames: g.renderer.engine.frameId - w.__frame0, scale: g.renderer.getResolutionScale() };
});
const gaps = (t: number[]) => t.slice(1).map((v, i) => v - t[i]);
const pct = (a: number[], p: number) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const summary = (label: string, iv: number[]) => ({
  [label]: { n: iv.length, p50: +pct(iv, 0.5).toFixed(2), p95: +pct(iv, 0.95).toFixed(2), p99: +pct(iv, 0.99).toFixed(2), dropped: iv.filter((x) => x > 25).length },
});
const report: Record<string, unknown> = { mode, webgpu, seconds, stage: out.stage, z: Math.round(out.z), speed: Math.round(out.speed), ...summary("main rAF interval ms", gaps(out.raf)) };
if (mode === "worker") {
  const s = out.worker.stats, s0 = before.stats;
  const iv = s.intervals.slice(s0.intervals.length), rm = s.renderMs.slice(s0.renderMs.length);
  Object.assign(report, summary("worker frame interval ms", iv), summary("worker render ms", rm), { "presented fps": +(iv.length / seconds).toFixed(1), scale: out.worker.scale, "post ms p95": +pct(out.post.ms, 0.95).toFixed(3), "state bytes (JSON, prev+curr)": out.post.bytes });
} else {
  Object.assign(report, summary("render ms", out.rms ?? []), { "presented fps": +(out.frames / seconds).toFixed(1), scale: out.scale });
}
console.log(JSON.stringify(report, null, 1));
if (errors.length) console.log("errors:", errors.slice(0, 5));
await browser.close();
