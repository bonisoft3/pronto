// Spike: bridge.js with the renderer behind a worker.
import { apexrunEngine } from '/shell/engine/simulation.js';
import { createKineticHost, createKineticInput } from '/omnishell/interpreter/kinetic.js';
import { ApexrunAudio } from '/shell/engine/audio.js';

export async function createApexrunGame(options = {}) {
  const canvas = options.canvas;
  const response = await fetch('/assets/manifest.json');
  const manifest = await response.json();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const worker = new Worker('/spike/worker.js', { type: 'module' });
  const off = canvas.transferControlToOffscreen();
  const webgpu = await new Promise((resolve, reject) => {
    worker.onerror = (e) => reject(new Error(`worker: ${e.message}`));
    worker.onmessage = ({ data }) => { if (data.type === 'ready') resolve(data.webgpu); };
    worker.postMessage({ type: 'init', canvas: off, manifest, dpr, width: Math.floor(innerWidth * dpr), height: Math.floor(innerHeight * dpr), refreshMs: 16.67 }, [off]);
  });
  const post = { ms: [], bytes: 0, count: 0 };
  const renderer = {
    isWebGPU: webgpu,
    worker,
    post,
    resize: (w, h) => worker.postMessage({ type: 'resize', w, h }),
    calibrateRefresh: async () => {},
    art: { ready: () => true, loadStage: async () => {} },
    stats: () => new Promise((resolve) => {
      const prev = worker.onmessage;
      worker.onmessage = ({ data }) => { if (data.type === 'stats') { worker.onmessage = prev; resolve(data); } };
      worker.postMessage({ type: 'stats' });
    }),
  };
  const audio = new ApexrunAudio();

  const kineticInput = createKineticInput({
    element: canvas,
    bindings: {
      up: ['KeyW', 'ArrowUp', 'w', 'arrowup'],
      down: ['KeyS', 'ArrowDown', 's', 'arrowdown'],
      left: ['KeyA', 'ArrowLeft', 'a', 'arrowleft'],
      right: ['KeyD', 'ArrowRight', 'd', 'arrowright'],
      drift: ['ShiftLeft', 'shift'],
      nitro: ['Space', ' '],
      enter: ['Enter', 'enter'],
      escape: ['Escape', 'escape'],
      gear: ['KeyG', 'g'],
    },
  });

  const host = createKineticHost({
    engine: apexrunEngine,
    initOptions: options.initialPhase ? { stageState: options.initialPhase } : {},
    rateHz: 60,
    historyLimit: 1200,
    getInput: () => {
      const p = kineticInput.poll();
      return { up: !!p.up, down: !!p.down, left: !!p.left, right: !!p.right, drift: !!p.drift, nitro: !!p.nitro, enter: !!p.enter, escape: !!p.escape, gear: p.gear ? 'high' : undefined };
    },
    onCommit: (state, tick) => {
      const player = state.karts.find((k) => k.isPlayer);
      if (player) audio.update(player, state.stageState === 'racing' || state.stageState === 'checkpoint');
      if (state.events?.length) audio.handleEvents(state.events);
      options.onStateChange?.(state, tick);
    },
    onRender: (prevState, currState, alpha, tick, isHistorical) => {
      const t0 = performance.now();
      worker.postMessage({ type: 'frame', prev: prevState, curr: currState, alpha, hist: isHistorical });
      post.ms.push(performance.now() - t0);
      if (post.count++ === 0) post.bytes = JSON.stringify({ prevState, currState }).length;
    },
  });

  return {
    host, renderer, audio, input: kineticInput, keyState: kineticInput.inputs.state,
    start: () => host.start(), stop: () => host.stop(), reset: () => host.reset(),
    startRace: () => { host.reset(0x1337, { stageState: 'warmup' }); host.start(); },
  };
}
