// Pixel parity: the showcase at fixed sim ticks, held throttle, same seed.
//   deno run -A --unsafely-ignore-certificate-errors=localhost parity.ts <outdir>
//   deno run -A parity.ts --compare <dirA> <dirB>
import { chromium } from "npm:playwright@1.61.1";
import { PNG } from "npm:pngjs@7.0.0";
import pixelmatch from "npm:pixelmatch@6.0.0";
import { Buffer } from "node:buffer";

const TICKS = [360, 700, 1100];

if (Deno.args[0] === "--compare") {
  const [a, b] = Deno.args.slice(1);
  for (const name of ["title", ...TICKS.map((t) => `tick${t}`)]) {
    const A = PNG.sync.read(Buffer.from(await Deno.readFile(`${a}/${name}.png`)));
    const B = PNG.sync.read(Buffer.from(await Deno.readFile(`${b}/${name}.png`)));
    const diff = new PNG({ width: A.width, height: A.height });
    const n = pixelmatch(A.data, B.data, diff.data, A.width, A.height, { threshold: 0.1 });
    let sum = 0;
    for (let i = 0; i < A.data.length; i += 4) for (let c = 0; c < 3; c++) sum += Math.abs(A.data[i + c] - B.data[i + c]);
    await Deno.writeFile(`${b}/${name}.diff.png`, PNG.sync.write(diff));
    console.log(`${name}: ${(100 * n / (A.width * A.height)).toFixed(2)}% pixels differ, mean |Δ| ${(sum / (A.width * A.height * 3)).toFixed(2)}/255`);
  }
  Deno.exit(0);
}

const out = Deno.args[0];
await Deno.mkdir(out, { recursive: true });
const browser = await chromium.launch({ channel: "chromium", args: ["--enable-unsafe-webgpu", "--ignore-certificate-errors"] });
const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 720 } });
const page = await context.newPage();
const errors: string[] = [];
page.on("pageerror", (e) => errors.push(e.message));
await page.goto("https://localhost:23221/showcase.html");
await page.waitForFunction(() => (globalThis as any).game?.host, null, { timeout: 120_000 });
await page.waitForTimeout(3000);
await page.screenshot({ path: `${out}/title.png` });
await page.evaluate(() => { const g = (globalThis as any).game; g.startRace(); g.keyState.up = true; });
for (const t of TICKS) {
  await page.waitForFunction((t) => (globalThis as any).game.host.getState().tick >= t - 20, t, { timeout: 120_000, polling: 1 });
  await page.evaluate(async (t) => {
    const g = (globalThis as any).game;
    g.host.pause();
    // The last ticks one at a time, a frame apart, so the shot is of tick t.
    while (g.host.getState().tick < t) {
      g.host.stepTick({ up: true });
      await new Promise((r) => requestAnimationFrame(r));
    }
  }, t);
  await page.waitForTimeout(1500);
  const tick = await page.evaluate(() => (globalThis as any).game.host.getState().tick);
  await page.screenshot({ path: `${out}/tick${TICKS[TICKS.indexOf(t)]}.png` });
  console.log(`shot at tick ${tick}`);
  await page.evaluate(() => (globalThis as any).game.host.play());
}
if (errors.length) console.log("errors:", errors);
await browser.close();
