// Spike: the renderer on its own thread, drawing on a transferred OffscreenCanvas.
import "/spike/babylon.js"; // the pinned babylon.js, served beside this file
import "/spike/loaders.js"; // the pinned babylonjs.loaders.min.js

let renderer = null;
const stats = { renders: 0, renderMs: [], intervals: [], last: null };
const queue = [];
let scheduled = false;

addEventListener("message", async ({ data }) => {
  if (data.type === "init") {
    globalThis.devicePixelRatio = data.dpr;
    const { ApexrunRenderer } = await import("/shell/engine/renderer.js");
    data.canvas.width = data.width;
    data.canvas.height = data.height;
    renderer = await ApexrunRenderer.create(data.canvas, null, data.manifest);
    renderer._refreshMs = data.refreshMs;
    postMessage({ type: "ready", webgpu: renderer.isWebGPU });
    return;
  }
  if (data.type === "resize") {
    renderer.resize(data.w, data.h);
    return;
  }
  if (data.type === "frame") {
    // Latest frame wins: a frame the worker could not draw in time is dropped.
    queue.length = 0;
    queue.push(data);
    if (!scheduled) {
      scheduled = true;
      (globalThis.__sched === 'raf' ? requestAnimationFrame : (f) => setTimeout(() => f(performance.now()), 0))(draw);
    }
    return;
  }
  if (data.type === "sched") { globalThis.__sched = data.sched; return; }
  if (data.type === "fixed") {
    renderer.setAdaptiveResolution(false);
    return;
  }
  if (data.type === "stats") {
    postMessage({ type: "stats", stats, scale: renderer.getResolutionScale() });
  }
});

function draw(t) {
  scheduled = false;
  const f = queue.pop();
  if (!f || !renderer) return;
  const t0 = performance.now();
  renderer.render(f.curr ?? f.prev, f.hist, f.prev, f.alpha);
  stats.renderMs.push(performance.now() - t0);
  if (stats.last !== null) stats.intervals.push(t - stats.last);
  stats.last = t;
  stats.renders++;
}
