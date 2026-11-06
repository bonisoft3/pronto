import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(root, '../compiler/package.json'));
const { chromium } = require('playwright');
const { build } = require('esbuild');
const dist = dirname(require.resolve('@duckdb/duckdb-wasm'));
const versions = {
  wasm: JSON.parse(await readFile(join(dist, '../package.json'), 'utf8')).version,
  playwright: require('playwright/package.json').version,
  esbuild: require('esbuild/package.json').version,
};
assert.deepEqual(versions, {
  wasm: '1.33.1-dev57.0', playwright: '1.59.1', esbuild: '0.27.2',
});

const timestamp = seconds => new Date(seconds * 1000).toISOString();
const window = (start, end, count, total) => [
  timestamp(start), timestamp(end), String(count), total === null ? null : String(total),
];
const empty = { aggregate: [['0', null]], join_aggregate: [], tumble: [], hop: [] };
const cases = [
  { name: 'empty', mutation: '', expected: empty },
  {
    name: 'boundaries_nulls_and_duplicate_values',
    mutation: `
      INSERT INTO events VALUES
        (1, TIMESTAMP '1969-12-31 23:59:59.999999', 7),
        (2, TIMESTAMP '1970-01-01 00:00:00', 10),
        (3, TIMESTAMP '1970-01-01 00:00:04.999999', 20),
        (4, TIMESTAMP '1970-01-01 00:00:05', 30),
        (5, TIMESTAMP '1970-01-01 00:00:09.999999', NULL),
        (6, TIMESTAMP '1970-01-01 00:00:10', 40),
        (7, TIMESTAMP '1970-01-01 00:00:10', 40),
        (8, TIMESTAMP '1970-01-01 00:00:20', NULL);
      INSERT INTO accounts VALUES
        (1, 'west'), (2, 'north'), (3, 'north'), (4, 'south'),
        (5, 'south'), (6, 'east'), (7, 'east');
    `,
    expected: {
      aggregate: [['8', '147']],
      join_aggregate: [
        ['east', '2', '80'], ['north', '2', '30'],
        ['south', '1', '30'], ['west', '1', '7'],
      ],
      tumble: [
        window(-10, 0, 1, 7), window(0, 10, 4, 60),
        window(10, 20, 2, 80), window(20, 30, 1, null),
      ],
      hop: [
        window(-10, 0, 1, 7), window(-5, 5, 3, 37), window(0, 10, 4, 60),
        window(5, 15, 4, 110), window(10, 20, 2, 80),
        window(15, 25, 1, null), window(20, 30, 1, null),
      ],
    },
  },
  {
    name: 'correction_and_retraction',
    mutation: `
      DELETE FROM events WHERE id = 3;
      UPDATE events SET amount = NULL WHERE id = 2;
      UPDATE events SET ts = TIMESTAMP '1970-01-01 00:00:15', amount = -5 WHERE id = 6;
      DELETE FROM accounts WHERE id = 7;
    `,
    expected: {
      aggregate: [['7', '72']],
      join_aggregate: [['south', '1', '30'], ['west', '1', '7']],
      tumble: [
        window(-10, 0, 1, 7), window(0, 10, 3, 30),
        window(10, 20, 2, 35), window(20, 30, 1, null),
      ],
      hop: [
        window(-10, 0, 1, 7), window(-5, 5, 2, 7), window(0, 10, 3, 30),
        window(5, 15, 3, 70), window(10, 20, 2, 35),
        window(15, 25, 2, -5), window(20, 30, 1, null),
      ],
    },
  },
  {
    name: 'delete_all_removes_old_results',
    mutation: 'DELETE FROM events; DELETE FROM accounts;',
    expected: empty,
  },
  {
    name: 'bigint_above_javascript_safe_integer',
    mutation: `
      INSERT INTO events VALUES (9, TIMESTAMP '1970-01-01 00:00:00', 9007199254740993);
      INSERT INTO accounts VALUES (9, 'wide');
    `,
    expected: {
      aggregate: [['1', '9007199254740993']],
      join_aggregate: [['wide', '1', '9007199254740993']],
      tumble: [window(0, 10, 1, '9007199254740993')],
      hop: [window(-5, 5, 1, '9007199254740993'), window(0, 10, 1, '9007199254740993')],
    },
  },
];
const schemas = {
  aggregate: [['n', 'BIGINT'], ['total', 'BIGINT']],
  join_aggregate: [['region', 'VARCHAR'], ['n', 'BIGINT'], ['total', 'BIGINT']],
  tumble: [['window_start', 'TIMESTAMP'], ['window_end', 'TIMESTAMP'], ['n', 'BIGINT'], ['total', 'BIGINT']],
  hop: [['window_start', 'TIMESTAMP'], ['window_end', 'TIMESTAMP'], ['n', 'BIGINT'], ['total', 'BIGINT']],
};
const queries = {};
const generated = {};
for (const name of Object.keys(schemas)) {
  queries[name] = await readFile(join(root, 'planner/results', name, 'duckdb.sql'), 'utf8');
  generated[name] = {
    sha256: createHash('sha256').update(queries[name]).digest('hex'),
    typedPlan: JSON.parse(await readFile(join(root, 'planner/results', name, 'typed-plan.json'), 'utf8')),
  };
}

const assets = new Map();
for (const name of ['duckdb-browser-eh.worker.js', 'duckdb-eh.wasm']) {
  assets.set('/' + name, await readFile(join(dist, name)));
}
const bundle = await build({
  entryPoints: [join(dist, 'duckdb-browser.mjs')], bundle: true, format: 'esm', write: false,
});
assets.set('/duckdb-browser.mjs', bundle.outputFiles[0].contents);
assets.set('/', Buffer.from('<!doctype html><title>DuckStream browser contract</title>'));
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
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
let browser;
try {
  browser = await chromium.launch();
  const page = await browser.newPage();
  const origin = `http://127.0.0.1:${server.address().port}`;
  const externalRequests = [];
  await page.route('**/*', async route => {
    if (new URL(route.request().url()).origin !== origin) {
      externalRequests.push(route.request().url());
      await route.abort();
      return;
    }
    await route.continue();
  });
  await page.goto(origin);
  const result = await page.evaluate(async ({ queries, cases }) => {
    const duckdb = await import('/duckdb-browser.mjs');
    const db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), new Worker('/duckdb-browser-eh.worker.js'));
    await db.instantiate('/duckdb-eh.wasm');
    const connection = await db.connect();
    try {
      await connection.query(`
        CREATE TABLE events (id INTEGER PRIMARY KEY, ts TIMESTAMP NOT NULL, amount BIGINT);
        CREATE TABLE accounts (id INTEGER PRIMARY KEY, region VARCHAR NOT NULL);
      `);
      const result = { engine: await db.getVersion(), schemas: {}, cases: [] };
      for (const [name, sql] of Object.entries(queries)) {
        const description = await connection.query('DESCRIBE ' + sql);
        result.schemas[name] = description.toArray().map(row => [row.column_name, row.column_type]);
      }
      for (const fixture of cases) {
        if (fixture.mutation) await connection.query(fixture.mutation);
        const snapshots = {};
        for (const [name, sql] of Object.entries(queries)) {
          const table = await connection.query(sql);
          snapshots[name] = {
            arrowSchema: table.schema.fields.map(field => [field.name, field.type.toString()]),
            rows: table.toArray().map(row => table.schema.fields.map(field => {
              const value = row[field.name];
              if (value === null) return null;
              if (field.type.toString().startsWith('Timestamp')) {
                if (typeof value !== 'number' || !Number.isFinite(value)) {
                  throw new Error(`Unexpected timestamp representation: ${field.name}`);
                }
                return new Date(value).toISOString();
              }
              if (typeof value === 'bigint') return value.toString();
              if (typeof value === 'string') return value;
              throw new Error(`Unexpected result representation: ${field.name} ${field.type}`);
            })),
          };
        }
        result.cases.push({ name: fixture.name, queries: snapshots });
      }
      return result;
    } finally {
      await connection.close();
      await db.terminate();
    }
  }, { queries, cases: cases.map(({ name, mutation }) => ({ name, mutation })) });
  assert.deepEqual(externalRequests, []);
  assert.deepEqual(result.schemas, schemas);
  const ordered = rows => rows.toSorted((left, right) => {
    const a = JSON.stringify(left), b = JSON.stringify(right);
    return a < b ? -1 : a > b ? 1 : 0;
  });
  for (let i = 0; i < cases.length; i++) {
    assert.equal(result.cases[i].name, cases[i].name);
    for (const [name, expected] of Object.entries(cases[i].expected)) {
      const actual = result.cases[i].queries[name];
      actual.rows = ordered(actual.rows);
      assert.deepEqual(actual.rows, ordered(expected), `${cases[i].name}/${name}`);
    }
  }
  result.versions = { ...versions, chromium: browser.version() };
  result.compiler = JSON.parse(await readFile(join(root, 'planner/results/compiler.json'), 'utf8'));
  result.generated = generated;
  result.assertions = { cases: cases.length, querySnapshots: cases.length * Object.keys(queries).length };
  await mkdir(join(root, 'results'), { recursive: true });
  await writeFile(join(root, 'results/browser.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({ ...result.versions, engine: result.engine, ...result.assertions }));
} finally {
  await browser?.close();
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
