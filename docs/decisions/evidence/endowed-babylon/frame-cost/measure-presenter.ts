// Frame cost of Apex Run's built presenter against its running stack: the
// worker's draws, timed from inside it through the browser's own debugger,
// since a presenter sends nothing back.
//   deno run -A measure-presenter.ts [seconds]
import { chromium } from "npm:playwright@1.61.1";
const seconds = Number(Deno.args[0] ?? 20);
const browser = await chromium.launch({ channel: "chromium", args: ["--enable-unsafe-webgpu", "--ignore-certificate-errors"] });
const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 720 } });
const page = await context.newPage();
const errors: string[] = [];
page.on("pageerror", (e) => errors.push(e.message));
await page.goto("https://localhost:23221/");
await page.waitForFunction(() => (document.querySelector("[data-kinetic]") as any)?._prontoKinetic?.frames > 30, null, { timeout: 120_000 });
const worker = page.workers().find((w) => w.url().includes("presenter.js"))!;
await page.keyboard.press("Enter");
await page.keyboard.down("ArrowUp");
await page.waitForTimeout(7000);
await worker.evaluate(() => {
  const w = globalThis as any;
  const original = w.setTimeout;
  w.__draws = [];
  w.setTimeout = (f: () => void, ...rest: unknown[]) => original(() => { const t0 = performance.now(); f(); const dt = performance.now() - t0; if (dt > 3) w.__draws.push([t0, dt]); }, ...rest);
});
for (let t = 0; t < seconds; t += 4) {
  await page.keyboard.press("Space");
  await page.waitForTimeout(Math.min(4, seconds - t) * 1000);
}
const draws: [number, number][] = await worker.evaluate(() => (globalThis as any).__draws);
const pct = (a: number[], p: number) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const iv = draws.slice(1).map(([t], i) => t - draws[i][0]);
const ms = draws.map(([, d]) => d);
console.log(JSON.stringify({ seconds, "presented fps": +(draws.length / seconds).toFixed(1), "intervals over 25 ms": iv.filter((x) => x > 25).length, "p95 interval": +pct(iv, 0.95).toFixed(1), "render p50": +pct(ms, 0.5).toFixed(1), errors }));
await browser.close();
