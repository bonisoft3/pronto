// Mermaid 11.4.1 (the version ir.html pins) rendered to SVG the only way it can be: in a browser.
const { chromium } = require("/Users/davi/code/trash/node_modules/playwright");
const fs = require("fs");
const path = require("path");
const dir = __dirname;
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.setContent(`<!doctype html><html><body><script src="https://cdn.jsdelivr.net/npm/mermaid@11.4.1/dist/mermaid.min.js"></script></body></html>`);
  await page.waitForFunction(() => typeof window.mermaid !== "undefined");
  await page.evaluate(() => window.mermaid.initialize({ startOnLoad: false, theme: "neutral" }));
  for (const name of ["entities", "payment", "beat"]) {
    const src = fs.readFileSync(path.join(dir, `${name}.mmd`), "utf8");
    const svg = await page.evaluate(async ([id, text]) => (await window.mermaid.render(id, text)).svg, [`m_${name}`, src]);
    fs.writeFileSync(path.join(dir, `${name}.mermaid.svg`), svg);
    console.log(name, "mermaid", svg.length, "bytes");
  }
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
