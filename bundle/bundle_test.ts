// The derived rows a pages release ships: derived.ts's SQL, and bundle.ts
// carrying it into a page whose PGlite runs it after the migrations.
import assert from 'node:assert/strict'
import * as path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dependencyOrder, derivedSql, dollar, pipelineState, Settlement, snapshotSql } from './derived.ts'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '../../..')

Deno.test('a table follows the tables it references, and a cycle is refused', () => {
  assert.deepEqual(dependencyOrder(['b', 'a', 'c'], [['a', 'b'], ['c', 'a'], ['c', 'game'], ['a', 'a']]), ['b', 'a', 'c'])
  assert.throws(() => dependencyOrder(['a', 'b'], [['a', 'b'], ['b', 'a']]), /cycle/)
})

Deno.test('a row carrying the quote tag is quoted under another', () => {
  assert.deepEqual(dollar('[]'), '$derived$[]$derived$')
  assert.deepEqual(dollar('["$derived$"]'), '$derived1$["$derived$"]$derived1$')
})

const metric = (name: string, value: number, stream = 'refresh', at = 'root.input') =>
  `${name}{label="",path="${at}",stream="${stream}"} ${value}`
const direct = (received: number, sent = received) => [
  metric('input_connection_up', 1), metric('input_received', received),
  metric('input_latency_ns_count', sent), metric('output_sent', sent, 'refresh', 'root.output'),
  metric('output_error', 0, 'refresh', 'root.output'),
].join('\n')

Deno.test('completed periodic no-op refreshes settle across the full computation cadence', () => {
  const settlement = new Settlement(315, 0)
  for (let seconds = 0; seconds <= 316; seconds += 2) {
    const pipeline = pipelineState(direct(seconds / 2 + 1), ['refresh'])
    assert.deepEqual(pipeline.active, [])
    const observed = settlement.observe({ ...pipeline, moving: `${pipeline.failures}\nunchanged rows` }, seconds * 1000)
    assert.equal(observed.settled, seconds >= 315)
  }
})

Deno.test('committed changes restart settlement; pending groups, first computations and unfinished requests block export', () => {
  const settlement = new Settlement(315, 0)
  const state = { waiting: [] as string[], active: [] as string[], moving: 'rows A' }
  settlement.observe(state, 0)
  assert.equal(settlement.observe({ ...state, moving: 'rows B' }, 310000).settled, false)
  state.moving = 'rows B'
  assert.equal(settlement.observe(state, 624000).settled, false)
  assert.equal(settlement.observe({ ...state, ...pipelineState(direct(50, 49), ['refresh']) }, 626000).settled, false)
  assert.equal(settlement.observe(state, 628000).settled, true)
  assert.equal(settlement.observe({ ...state, waiting: ['group events to drain'] }, 630000).settled, false)
  assert.equal(settlement.observe(state, 944000).settled, false)
  assert.equal(settlement.observe({ ...state, waiting: ['computation odds to run'] }, 945000).settled, false)
})

Deno.test('batched and filtered events finish by batch acknowledgments without equating messages with batches', () => {
  const events = (received: number, processed: number, batches: number, acknowledged: number) => [
    metric('input_connection_up', 1, 'events'), metric('input_received', received, 'events'),
    metric('input_latency_ns_count', acknowledged, 'events'),
    metric('processor_received', processed, 'events', 'root.pipeline.processors.0'),
    metric('processor_batch_received', batches, 'events', 'root.pipeline.processors.0'),
    metric('processor_batch_sent', 0, 'events', 'root.pipeline.processors.0'),
    metric('output_sent', 0, 'events', 'root.output'),
  ].join('\n')
  assert.deepEqual(pipelineState(events(10, 10, 1, 1), ['events']).active, [])
  assert.deepEqual(pipelineState(events(20, 20, 2, 1), ['events']).active, ['stream events to finish'])
  assert.deepEqual(pipelineState(events(20, 10, 1, 1), ['events']).active, ['stream events to finish'])
})

Deno.test('buffer acknowledgments cover work after inputs acknowledge storage; errors fail loudly', () => {
  const buffered = (completed: number) => direct(10, 0) + '\n' + [
    metric('buffer_received', 10, 'refresh', 'root.buffer'),
    metric('buffer_batch_received', 1, 'refresh', 'root.buffer'),
    metric('buffer_latency_ns_count', completed, 'refresh', 'root.buffer'),
  ].join('\n')
  assert.deepEqual(pipelineState(buffered(0), ['refresh']).active, ['stream refresh buffer to drain'])
  assert.deepEqual(pipelineState(buffered(1), ['refresh']).active, [])
  assert.throws(() => pipelineState(direct(1) + '\n' + metric('output_error', 1, 'refresh', 'root.output'), ['refresh']), /output_error/)
  assert.throws(() => pipelineState(direct(1) + '\n' + metric('processor_error', 1, 'refresh', 'root.pipeline.processors.0'), ['refresh']), /processor_error/)
  assert.throws(() => pipelineState(metric('input_received', 1), ['refresh']), /completion metrics/)
  assert.ok(pipelineState('', ['refresh']).waiting.includes('stream refresh to start'))
})

Deno.test('a committed-content snapshot sees changes immediately and preserves numeric JSON text', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'derived-snapshot-test-' })
  try {
    const browser = path.join(repo, 'libraries/mecha/packages/mecha-browser')
    await Deno.writeTextFile(path.join(dir, 'snapshot.ts'), `
      import assert from 'node:assert/strict'
      import { PGlite } from '@electric-sql/pglite'
      import { snapshotSql, derivedSql } from ${JSON.stringify(String(pathToFileURL(path.join(here, 'derived.ts'))))}
      const db = await PGlite.create()
      await db.exec(\`CREATE TABLE source (id bigint PRIMARY KEY, amount numeric, stamp timestamptz);
        CREATE TABLE sink (id bigint PRIMARY KEY REFERENCES source(id), amount numeric);
        CREATE SCHEMA other; CREATE TABLE other.trigger (id integer PRIMARY KEY, n integer);
        INSERT INTO source VALUES (9007199254740993, 123456789.123456789123456789, '2026-10-06Z');
        INSERT INTO sink SELECT id, amount FROM source; INSERT INTO other.trigger VALUES (1, 0);\`)
      const all = [{schema:'public',name:'source'}, {schema:'public',name:'sink'}, {schema:'other',name:'trigger'}]
      const read = async () => (await db.query(snapshotSql(all, ['source', 'sink']))).rows[0].json_build_object
      const before = await read()
      assert.match(before.rows.source, /9007199254740993/)
      assert.match(before.rows.source, /123456789\\.123456789123456789/)
      await db.exec('UPDATE source SET amount = amount')
      assert.equal((await read()).fingerprint, before.fingerprint)
      await db.exec('UPDATE other.trigger SET n = 1')
      const triggered = await read()
      assert.notEqual(triggered.fingerprint, before.fingerprint)
      await db.exec(\`BEGIN; UPDATE source SET amount = 7; UPDATE sink SET amount = 7; COMMIT;\`)
      const changed = await read()
      assert.notEqual(changed.fingerprint, triggered.fingerprint)
      assert.match(changed.rows.source, /"amount":7/)
      assert.match(changed.rows.sink, /"amount":7/)
      await db.exec(derivedSql(['source','sink'], {source:['id','amount','stamp'],sink:['id','amount']}, before.rows))
      assert.equal((await read()).rows.source, before.rows.source)
      assert.equal((await read()).rows.sink, before.rows.sink)
      await db.close()
    `)
    const ran = await new Deno.Command(Deno.execPath(), {
      args: ['run', '-A', '--config', path.join(browser, 'cluster.deno.json'), '--lock', path.join(browser, 'deno.lock'), '--frozen', path.join(dir, 'snapshot.ts')],
      stdout: 'inherit', stderr: 'inherit',
    }).output()
    assert.equal(ran.success, true, 'the database snapshot regression failed')
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})

Deno.test('a page bundled with derived rows boots holding them in place of the seed', async () => {
  const app = await Deno.makeTempDir({ prefix: 'bundle-test-' })
  try {
    const write = async (p: string, text: string) => {
      await Deno.mkdir(path.dirname(path.join(app, p)), { recursive: true })
      await Deno.writeTextFile(path.join(app, p), text)
    }
    await write('shell/shell.json', JSON.stringify({ routes: [{ files: { css: 'shell/screens/home.css', shared: ['shell/shared/chrome.css'] } }], migrations: ['m/001.sql', 'm/900_seed.sql'], tables: [] }))
    await write('shell/shell.css', '')
    await write('shell/design.css', '')
    await write('shell/screens/home.css', '')
    await write('shell/shared/chrome.css', 'body { padding-top: 72px; }')
    await write('shell/index.html', [
      '<!doctype html><html><head>',
      '<link rel="stylesheet" href="./shell.css">',
      '<link rel="stylesheet" href="./design.css">',
      '<link rel="stylesheet" href="../shell/shared/chrome.css">',
      '</head><body><div id="app"></div>',
      '<script type="module" src="./boot.js"></script>',
      '</body></html>',
    ].join('\n'))
    await write('m/001.sql', [
      // The one user's row, which the cluster mints at boot.
      'CREATE TABLE app_user (id uuid PRIMARY KEY, handle text NOT NULL);',
      "CREATE TABLE tally (id text PRIMARY KEY, n int NOT NULL, scope_id text GENERATED ALWAYS AS ('public:') STORED);",
      'CREATE TABLE tally_note (id text PRIMARY KEY, tally_id text NOT NULL REFERENCES tally(id), note text);',
    ].join('\n'))
    // A seeded row the derivation no longer produces, which the page must not keep.
    await write('m/900_seed.sql', "INSERT INTO tally VALUES ('gone', 9);")
    const order = dependencyOrder(['tally_note', 'tally'], [['tally_note', 'tally']])
    await write('dist/derived.sql', derivedSql(order, { tally: ['id', 'n'], tally_note: ['id', 'tally_id', 'note'] }, {
      tally: JSON.stringify([{ id: 'a', n: 2 }, { id: 'b', n: 3 }]),
      tally_note: JSON.stringify([{ id: 'x', tally_id: 'b', note: "it's $derived$" }]),
    }))

    const bundled = await new Deno.Command(Deno.execPath(), {
      args: [
        'run', '-A', '--config', path.join(here, 'deno.json'), path.join(here, 'bundle.ts'), app,
        '--omnishell', path.join(repo, 'plugins/omnishell'), '--mecha', path.join(repo, 'libraries/mecha'),
        '--derived', path.join(app, 'dist/derived.sql'),
      ],
      stdout: 'inherit',
      stderr: 'inherit',
    }).output()
    assert.deepEqual(bundled.success, true, 'bundle.ts failed')
    const html = await Deno.readTextFile(path.join(app, 'dist/browser/index.html'))
    assert.ok(html.includes('<style>body { padding-top: 72px; }</style>'))
    assert.ok(!/<link rel="stylesheet"/.test(html))

    // The page's own boot, minus the browser: its payload read from the
    // document, PGlite under the cluster's pins, and createCluster running the sql.
    const browser = path.join(repo, 'libraries/mecha/packages/mecha-browser')
    await write('boot.ts', `
      import { PGlite } from '@electric-sql/pglite'
      import { createCluster } from ${JSON.stringify(String(pathToFileURL(path.join(browser, 'cluster.ts'))))}
      const html = await Deno.readTextFile(Deno.args[0])
      const b64 = /<script type="application\\/octet-stream" id="pronto-payload">([^<]*)<\\/script>/.exec(html)![1]
      const payload = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))))
      const db = await PGlite.create()
      await createCluster({ db, sql: payload.cluster.sql, tables: payload.cluster.tables, log: console.error, fail: (e) => { throw e } })
      const rows = async (sql: string) => (await db.query(sql)).rows
      console.log(JSON.stringify({
        tally: await rows('SELECT id, n FROM tally ORDER BY id'),
        note: await rows('SELECT id, tally_id, note FROM tally_note'),
      }))
    `)
    const booted = await new Deno.Command(Deno.execPath(), {
      args: [
        'run', '-A', '--config', path.join(browser, 'cluster.deno.json'), '--lock', path.join(browser, 'deno.lock'), '--frozen',
        path.join(app, 'boot.ts'), path.join(app, 'dist/browser/index.html'),
      ],
      stdout: 'piped',
      stderr: 'inherit',
    }).output()
    assert.deepEqual(booted.success, true, 'the page did not boot')
    assert.deepEqual(JSON.parse(new TextDecoder().decode(booted.stdout)), {
      tally: [{ id: 'a', n: 2 }, { id: 'b', n: 3 }],
      note: [{ id: 'x', tally_id: 'b', note: "it's $derived$" }],
    })
  } finally {
    await Deno.remove(app, { recursive: true })
  }
})

// Regression: the page's cluster answered a refused subset `{message}`, and the
// store counts a 400 a refusal only when Electric's `errors.subset` names it.
// Every predicate the program stated wrong was then asked again forever, its
// read never settled, and the region over it stayed loading with the cause on
// the console alone, where the stack raises a ProgramError naming the table.
Deno.test("the page's store behind its cluster raises a refused subset as the program's error", async () => {
  const dir = await Deno.makeTempDir({ prefix: 'page-store-test-' })
  try {
    const browser = path.join(repo, 'libraries/mecha/packages/mecha-browser')
    const interpreter = path.join(repo, 'plugins/omnishell/interpreter')
    const at = (p: string) => JSON.stringify(String(pathToFileURL(p)))
    await Deno.writeTextFile(path.join(dir, 'page.ts'), `
      import { PGlite } from '@electric-sql/pglite'
      import { createCluster } from ${at(path.join(browser, 'cluster.ts'))}
      const rls = await Deno.readTextFile(${JSON.stringify(path.join(repo, 'libraries/mecha/services/database/rls/rls.sql'))})
      const db = await PGlite.create()
      const cluster = await createCluster({
        db, tables: ['item'], log: console.error, fail: (e) => { throw e },
        sql: [rls, \`CREATE TABLE app_user (id uuid PRIMARY KEY, handle text NOT NULL);
          CREATE TABLE item (id text PRIMARY KEY, game int NOT NULL, txid bigint NOT NULL DEFAULT txid_current(),
            scope_id text GENERATED ALWAYS AS ('public:') STORED NOT NULL);
          INSERT INTO item (id, game) VALUES ('a', 7), ('b', 8);\`],
      })
      // The page's shim, and the window the store's client touches.
      globalThis.fetch = (input, init) => {
        const url = new URL(String(input instanceof Request ? input.url : input))
        return cluster.handle(new Request(\`http://cluster.local\${url.pathname}\${url.search}\`, init))
      }
      const backing = new Map()
      const storage = { getItem: (k) => backing.get(k) ?? null, setItem: (k, v) => void backing.set(k, v), removeItem: (k) => void backing.delete(k),
        key: (i) => [...backing.keys()][i] ?? null, get length() { return backing.size } }
      Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true })
      globalThis.document = { addEventListener: () => {}, removeEventListener: () => {} }
      globalThis.window = { localStorage: storage, location: { origin: 'http://page' }, addEventListener: () => {}, removeEventListener: () => {},
        setTimeout, clearTimeout, setInterval, clearInterval }
      const { createStore } = await import(${at(path.join(interpreter, 'data-sync.js'))})
      const { ProgramError } = await import(${at(path.join(interpreter, 'fragment.js'))})
      const { FIXTURE_CARRIERS } = await import(${at(path.join(interpreter, 'fixture-types.js'))})
      const store = createStore('http://page', {
        carriers: FIXTURE_CARRIERS, appBase: 'http://page/app/', tables: ['item'], sync: { item: 'on-demand' },
        // A field the program declares and the database lacks.
        schema: { item: { fields: [{ name: 'id', type: 'string' }, { name: 'game', type: 'int32' }, { name: 'ghost', type: 'string' }] } },
      })
      const read = async (filter) => {
        const stop = store.subscribe('item', () => {}, { filter })
        try {
          return await store.query('item', null, { filter }).then((rows) => rows.map((r) => r.id), (e) => e)
        } finally {
          stop()
        }
      }
      const loaded = await read('game=eq.7')
      const refused = await Promise.race([read('ghost=eq.x'), new Promise((r) => setTimeout(() => r('still waiting'), 3000))])
      console.log(JSON.stringify({ loaded, refused: refused instanceof ProgramError ? refused.message : String(refused) }))
      Deno.exit(0)
    `)
    const ran = await new Deno.Command(Deno.execPath(), {
      args: ['run', '-A', '--config', path.join(browser, 'cluster.deno.json'), '--lock', path.join(browser, 'deno.lock'), '--frozen', path.join(dir, 'page.ts')],
      stdout: 'piped',
      stderr: 'inherit',
    }).output()
    assert.deepEqual(ran.success, true, 'the page did not run')
    const { loaded, refused } = JSON.parse(new TextDecoder().decode(ran.stdout))
    assert.deepEqual(loaded, ['a'])
    assert.match(refused, /the stack refused a subset of item: .*ghost/)
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})
