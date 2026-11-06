import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const root = dirname(fileURLToPath(import.meta.url));
const dist = dirname(require.resolve('@duckdb/duckdb-wasm'));
const wasmPackage = JSON.parse(await readFile(join(dist, '..', 'package.json'), 'utf8'));
assert.equal(wasmPackage.version, '1.33.1-dev57.0');
assert.equal(require('playwright/package.json').version, '1.59.1');
assert.equal(require('esbuild/package.json').version, '0.27.2');
const assets = new Map();
for (const name of ['duckdb-browser-eh.worker.js', 'duckdb-eh.wasm']) {
  assets.set('/' + name, await readFile(join(dist, name)));
}
const bundle = await build({
  entryPoints: [join(dist, 'duckdb-browser.mjs')], bundle: true, format: 'esm', write: false,
});
assets.set('/duckdb-browser.mjs', bundle.outputFiles[0].contents);
assets.set('/', Buffer.from('<!doctype html><title>DuckStream compiler browser check</title>'));
const server = createServer((request, response) => {
  const body = assets.get(request.url);
  if (!body) {
    response.writeHead(404).end();
    return;
  }
  response.setHeader('Content-Type', request.url.endsWith('.wasm') ? 'application/wasm' :
    request.url.endsWith('.js') || request.url.endsWith('.mjs') ? 'text/javascript' : 'text/html');
  response.end(body);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const summary = JSON.parse(await readFile(join(root, 'results', 'summary.json'), 'utf8'));
  const queries = {};
  for (const [name, result] of Object.entries(summary.fixtures)) {
    if (result.status === 'executed' || result.status === 'duckdb_rejected') {
      queries[name] = await readFile(join(root, 'results', name, 'duckdb.sql'), 'utf8');
    }
  }
  const setup = await readFile(join(root, 'fixtures', 'data.sql'), 'utf8');
  const result = await page.evaluate(async ({ setup, queries }) => {
    const duckdb = await import('/duckdb-browser.mjs');
    const db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), new Worker('/duckdb-browser-eh.worker.js'));
    await db.instantiate('/duckdb-eh.wasm');
    const connection = await db.connect();
    await connection.query(setup);
    const result = { engine: await db.getVersion(), fixtures: {} };
    for (const [name, sql] of Object.entries(queries)) {
      try {
        const table = await connection.query(sql);
        const rows = table.toArray().map(row => Object.values(row.toJSON()).map((value, index) => {
          if (value instanceof Uint32Array && 'scale' in table.schema.fields[index].type) {
            let integer = 0n;
            for (let i = value.length - 1; i >= 0; i--) integer = (integer << 32n) | BigInt(value[i]);
            integer = BigInt.asIntN(32 * value.length, integer);
            if (integer > BigInt(Number.MAX_SAFE_INTEGER) || integer < BigInt(Number.MIN_SAFE_INTEGER)) {
              throw new Error('Fixture decimal exceeds exact numeric comparison range');
            }
            return Number(integer) / 10 ** table.schema.fields[index].type.scale;
          }
          return typeof value === 'bigint' ? Number(value) : value;
        }));
        rows.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
        result.fixtures[name] = { status: 'executed', rows,
          schema: table.schema.fields.map(field => [field.name, field.type.toString()]) };
      } catch (error) {
        result.fixtures[name] = { status: 'duckdb_rejected', error: String(error) };
      }
    }
    await connection.close();
    await db.terminate();
    return result;
  }, { setup, queries });
  result.package = wasmPackage.version;
  result.browser = browser.version();
  await writeFile(join(root, 'results', 'browser.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
  assert.deepEqual(result.fixtures.join_aggregate.rows, [['north', 3, 37], ['south', 1, 5]]);
  for (const name of ['tumble', 'hop']) {
    assert.equal(result.fixtures[name].status, 'duckdb_rejected');
    assert.match(result.fixtures[name].error, /syntax error at or near "TABLE"/);
  }
} finally {
  await browser?.close();
  server.close();
}
