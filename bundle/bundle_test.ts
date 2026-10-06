// The derived rows a pages release ships: derived.ts's SQL, and bundle.ts
// carrying it into a page whose PGlite runs it after the migrations.
import assert from 'node:assert/strict'
import * as path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dependencyOrder, derivedSql, dollar, inputCompletions, pipelineState, Settlement, singleMessageInput, snapshotSql } from './derived.ts'

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
const direct = (received: number, sent = received, acknowledged = sent) => [
  metric('input_connection_up', 1), metric('input_received', received),
  metric('input_latency_ns_count', acknowledged), metric('output_sent', sent, 'refresh', 'root.output'),
  metric('output_error', 0, 'refresh', 'root.output'),
].join('\n')

Deno.test('completed periodic no-op refreshes settle across the full computation cadence', () => {
  const settlement = new Settlement(315, 0)
  for (let seconds = 0; seconds <= 316; seconds += 2) {
    const pipeline = pipelineState(direct(seconds / 2 + 1), ['refresh'], inputCompletions({generate:{}}, 'refresh'))
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
  assert.equal(settlement.observe({ ...state, ...pipelineState(direct(50, 49), ['refresh'], inputCompletions({generate:{}}, 'refresh')) }, 626000).settled, false)
  assert.equal(settlement.observe(state, 628000).settled, true)
  assert.equal(settlement.observe({ ...state, waiting: ['group events to drain'] }, 630000).settled, false)
  assert.equal(settlement.observe(state, 944000).settled, false)
  assert.equal(settlement.observe({ ...state, waiting: ['computation odds to run'] }, 945000).settled, false)
})

Deno.test('batched and filtered events finish by batch acknowledgments without equating messages with batches', () => {
  const events = (received: number, processed: number, batches: number, acknowledged: number) => [
    metric('input_connection_up', 1, 'events'), metric('input_received', received, 'events'),
    metric('input_latency_ns_count', acknowledged, 'events'),
    metric('processor_received', processed, 'events', 'root.input.processors.0'),
    metric('processor_batch_received', batches, 'events', 'root.input.processors.0'),
    metric('processor_batch_sent', 0, 'events', 'root.pipeline.processors.0'),
    metric('output_sent', 0, 'events', 'root.output'),
  ].join('\n')
  assert.deepEqual(pipelineState(events(10, 10, 1, 1), ['events']).active, [])
  assert.deepEqual(pipelineState(events(20, 20, 2, 1), ['events']).active, ['stream events to finish'])
  assert.deepEqual(pipelineState(events(20, 10, 1, 1), ['events']).active, ['stream events to finish'])
})

Deno.test('buffer acknowledgments cover work after inputs acknowledge storage', () => {
  const buffered = (completed: number) => direct(10, 0, 1) + '\n' + [
    metric('buffer_received', 10, 'refresh', 'root.buffer'),
    metric('buffer_batch_received', 1, 'refresh', 'root.buffer'),
    metric('buffer_latency_ns_count', completed, 'refresh', 'root.buffer'),
    metric('processor_received', 10, 'refresh', 'root.input.processors.0'),
    metric('processor_batch_received', 1, 'refresh', 'root.input.processors.0'),
  ].join('\n')
  assert.deepEqual(pipelineState(buffered(0), ['refresh']).active, ['stream refresh buffer to drain'])
  assert.deepEqual(pipelineState(buffered(1), ['refresh']).active, [])
  assert.throws(() => pipelineState(direct(1), ['refresh']), /batch-comparable completion metrics/)
  assert.ok(pipelineState('', ['refresh']).waiting.includes('stream refresh to start'))
})

Deno.test('a buffer drains independently of original input transactions that expand before storage', () => {
  const expanded = (received: number, inputCompleted: number, bufferCompleted: number) => [
    metric('input_connection_up', 1), metric('input_received', received),
    metric('input_latency_ns_count', inputCompleted),
    metric('processor_received', received, 'refresh', 'root.input.processors.0'),
    metric('processor_batch_received', received, 'refresh', 'root.input.processors.0'),
    metric('buffer_received', 14, 'refresh', 'root.buffer'),
    metric('buffer_batch_received', 14, 'refresh', 'root.buffer'),
    metric('buffer_latency_ns_count', bufferCompleted, 'refresh', 'root.buffer'),
  ].join('\n')
  const metadata = inputCompletions({generate:{}}, 'refresh')
  assert.deepEqual(pipelineState(expanded(1, 1, 14), ['refresh'], metadata).active, [])
  assert.deepEqual(pipelineState(expanded(1, 1, 13), ['refresh'], metadata).active, ['stream refresh buffer to drain'])
  assert.deepEqual(pipelineState(expanded(2, 1, 14), ['refresh'], metadata).active, ['stream refresh to finish'])
})

Deno.test('broker completion sums leaf message and batch counters without counting parents twice', () => {
  const broker = (completed: number) => [
    metric('input_connection_up', 1, 'events', 'root.input.broker.inputs.0'),
    metric('input_connection_up', 1, 'events', 'root.input.broker.inputs.1.broker.inputs.0'),
    metric('input_received', 10, 'events', 'root.input.broker.inputs.0'),
    metric('input_received', 2, 'events', 'root.input.broker.inputs.1'),
    metric('input_received', 2, 'events', 'root.input.broker.inputs.1.broker.inputs.0'),
    metric('input_latency_ns_count', 1, 'events', 'root.input.broker.inputs.0'),
    metric('input_latency_ns_count', completed, 'events', 'root.input.broker.inputs.1.broker.inputs.0'),
    metric('processor_received', 10, 'events', 'root.input.broker.inputs.0.processors.0'),
    metric('processor_batch_received', 1, 'events', 'root.input.broker.inputs.0.processors.0'),
  ].join('\n')
  assert.deepEqual(pipelineState(broker(2), ['events'], inputCompletions({broker:{inputs:[{}, {broker:{inputs:[{generate:{}}]}}]}}, 'events')).active, [])
  assert.deepEqual(pipelineState(broker(1), ['events'], inputCompletions({broker:{inputs:[{}, {broker:{inputs:[{generate:{}}]}}]}}, 'events')).active, ['stream events to finish'])
})

Deno.test('input expansion completes by its original transaction; Redis completion belongs to the bus drain gate', () => {
  const metrics = (completed: number) => [
    metric('input_connection_up', 1, 'events', 'root.input.broker.inputs.0'),
    metric('input_connection_up', 1, 'events', 'root.input.broker.inputs.1'),
    metric('input_received', 10, 'events', 'root.input.broker.inputs.0'),
    metric('input_latency_ns_count', 1, 'events', 'root.input.broker.inputs.0'),
    metric('input_received', 1, 'events', 'root.input.broker.inputs.1'),
    metric('input_latency_ns_count', completed, 'events', 'root.input.broker.inputs.1'),
    metric('processor_received', 1, 'events', 'root.input.broker.inputs.1.processors.0'),
    metric('processor_batch_received', 1, 'events', 'root.input.broker.inputs.1.processors.0'),
    metric('processor_received', 24, 'events', 'root.pipeline.processors.0'),
    metric('processor_batch_received', 15, 'events', 'root.pipeline.processors.0'),
  ].join('\n')
  const metadata = inputCompletions({broker:{inputs:[{redis_streams:{url:'${REDIS_URL}'}},{generate:{}}]}}, 'events', {url:'redis://redis:6379', aliases:new Set(['redis'])})
  assert.deepEqual(pipelineState(metrics(1), ['events'], metadata).active, [])
  assert.deepEqual(pipelineState(metrics(0), ['events'], metadata).active, ['stream events to finish'])
  assert.throws(() => pipelineState(metrics(1), ['events'], inputCompletions({broker:{inputs:[{redis_streams:{url:'redis://external:6379'}},{generate:{}}]}}, 'events', {url:'redis://redis:6379', aliases:new Set(['redis'])})), /batch-comparable/)
  assert.equal(inputCompletions({redis_streams:{url:'redis://redis:6379/0?db=1'}}, 'events', {url:'redis://redis:6379', aliases:new Set(['redis'])}).size, 0)
  assert.equal(inputCompletions({redis_streams:{url:'${REDIS_URL}'}}, 'events', {url:'redis://redis:6379?db=1', aliases:new Set(['redis'])}).size, 0)
  const settlement = new Settlement(315, 0)
  const state = {...pipelineState(metrics(1), ['events'], metadata), moving:'rows'}
  settlement.observe(state, 0)
  assert.equal(settlement.observe({...state, waiting:['Redis group to drain']}, 315000).settled, false)
})

Deno.test('direct acknowledgments require single-message metadata; recovered nacks settle and recurring failures restart quiet', () => {
  assert.equal(singleMessageInput({generate:{}}), true)
  assert.equal(singleMessageInput({generate:{batch_size:1}}), true)
  assert.equal(singleMessageInput({generate:{batch_size:10}}), false)
  assert.equal(singleMessageInput({}), false)
  const known = inputCompletions({generate:{}}, 'refresh')
  const inspected = (received: number, completed: number, failed: number) => pipelineState(
    direct(received, received - failed, completed).replace(metric('output_error', 0, 'refresh', 'root.output'), metric('output_error', failed, 'refresh', 'root.output')),
    ['refresh'], known,
  )
  const settlement = new Settlement(315, 0)
  const state = (received: number, completed: number, failed: number) => {
    const pipeline = inspected(received, completed, failed)
    return {...pipeline, moving: `${pipeline.failures}\nunchanged dirty queues and rows`}
  }
  settlement.observe(state(1, 1, 0), 0)
  assert.equal(settlement.observe(state(2, 2, 1), 10000).settled, false)
  assert.equal(settlement.observe(state(10, 10, 1), 325000).settled, true)
  assert.equal(settlement.observe(state(11, 10, 1), 326000).settled, false)
  assert.equal(settlement.observe(state(11, 11, 1), 327000).settled, true)
  assert.equal(settlement.observe(state(12, 12, 2), 328000).settled, false)
  assert.equal(settlement.observe(state(13, 13, 3), 640000).settled, false)
  assert.throws(() => pipelineState(direct(10), ['refresh'], new Map()), /batch-comparable/)
})

Deno.test('an authoritative restore suppresses derivation triggers, retains foreign keys and rolls back rows and trigger modes on failure', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'derived-restore-test-' })
  try {
    const browser = path.join(repo, 'libraries/mecha/packages/mecha-browser')
    await Deno.writeTextFile(path.join(dir, 'restore.ts'), `
      import assert from 'node:assert/strict'
      import { PGlite } from '@electric-sql/pglite'
      import { derivedSql } from ${JSON.stringify(String(pathToFileURL(path.join(here, 'derived.ts'))))}
      const db = await PGlite.create()
      await db.exec(\`CREATE TABLE source (id text PRIMARY KEY, saved text, t text);
        CREATE TABLE sink (id text PRIMARY KEY REFERENCES source(id), n integer);
        CREATE TABLE deferred_sink (id text PRIMARY KEY REFERENCES source(id) DEFERRABLE INITIALLY DEFERRED);
        CREATE TABLE trigger_hits (id text);
        CREATE FUNCTION derive() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
          INSERT INTO sink VALUES (NEW.id, 9); INSERT INTO trigger_hits VALUES (NEW.id); RETURN NEW; END $$;
        CREATE FUNCTION noop() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;
        CREATE TRIGGER derive AFTER INSERT ON source FOR EACH ROW EXECUTE FUNCTION derive();
        CREATE TRIGGER disabled BEFORE INSERT ON source FOR EACH ROW EXECUTE FUNCTION noop();
        CREATE TRIGGER replica BEFORE INSERT ON source FOR EACH ROW EXECUTE FUNCTION noop();
        CREATE TRIGGER always BEFORE INSERT ON source FOR EACH ROW EXECUTE FUNCTION noop();
        CREATE TRIGGER deferred_noop BEFORE INSERT ON deferred_sink FOR EACH ROW EXECUTE FUNCTION noop();
        ALTER TABLE source DISABLE TRIGGER disabled;
        ALTER TABLE source ENABLE REPLICA TRIGGER replica;
        ALTER TABLE source ENABLE ALWAYS TRIGGER always;
        INSERT INTO source (id) VALUES ('old'); TRUNCATE trigger_hits;\`)
      const modes = async () => (await db.query("SELECT tgname, tgenabled FROM pg_trigger WHERE NOT tgisinternal ORDER BY tgname")).rows
      const originalModes = await modes()
      const restore = (sink: string, deferred_sink = '[{"id":"a"}]') => derivedSql(['source', 'sink', 'deferred_sink'], {source:['id','saved','t'], sink:['id','n'], deferred_sink:['id']}, {
        source:'[{"id":"a","saved":"captured","t":"literal"}]', sink, deferred_sink,
      })
      await db.exec(restore('[{"id":"a","n":7}]'))
      assert.deepEqual((await db.query('SELECT * FROM source')).rows, [{id:'a', saved:'captured', t:'literal'}])
      assert.deepEqual((await db.query('SELECT * FROM sink')).rows, [{id:'a', n:7}])
      assert.deepEqual((await db.query('SELECT * FROM trigger_hits')).rows, [])
      assert.deepEqual((await db.query('SELECT * FROM deferred_sink')).rows, [{id:'a'}])
      assert.deepEqual(await modes(), originalModes)
      await db.exec("INSERT INTO source (id) VALUES ('b')")
      assert.deepEqual((await db.query("SELECT * FROM sink WHERE id = 'b'")).rows, [{id:'b', n:9}])
      assert.deepEqual((await db.query('SELECT * FROM trigger_hits')).rows, [{id:'b'}])
      const before = (await db.query('SELECT * FROM sink ORDER BY id')).rows
      await assert.rejects(() => db.exec(restore('[{"id":"missing","n":0}]')), /foreign key/)
      assert.deepEqual((await db.query('SELECT * FROM sink ORDER BY id')).rows, before)
      assert.deepEqual(await modes(), originalModes)
      await assert.rejects(() => db.exec(restore('[{"id":"a","n":7}]', '[{"id":"missing"}]')), /foreign key/)
      assert.deepEqual((await db.query('SELECT * FROM sink ORDER BY id')).rows, before)
      assert.deepEqual((await db.query('SELECT * FROM deferred_sink')).rows, [{id:'a'}])
      assert.deepEqual(await modes(), originalModes)
      await db.exec("INSERT INTO source (id) VALUES ('c')")
      assert.deepEqual((await db.query("SELECT * FROM sink WHERE id = 'c'")).rows, [{id:'c', n:9}])
      await db.close()
    `)
    const ran = await new Deno.Command(Deno.execPath(), {
      args: ['run', '-A', '--config', path.join(browser, 'cluster.deno.json'), '--lock', path.join(browser, 'deno.lock'), '--frozen', path.join(dir, 'restore.ts')],
      stdout: 'inherit', stderr: 'inherit',
    }).output()
    assert.equal(ran.success, true, 'the authoritative restore regression failed')
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
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
    await write('shell/shell.json', JSON.stringify({
      routes: [{ files: { css: 'shell/screens/home.css', shared: ['shell/shared/chrome.css'] } }],
      migrations: ['m/001.sql', 'm/900_seed.sql'], tables: ['tally', 'tally_read'],
      schema: { tally: { durability: 'live' }, tally_read: { durability: 'server' } },
    }))
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
      'CREATE VIEW tally_read WITH (security_invoker=true) AS SELECT * FROM tally;',
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
      await createCluster({ db, sql: payload.cluster.sql, tables: payload.cluster.tables, schema: JSON.parse(payload.files['shell/shell.json']).schema, log: console.error, fail: (e) => { throw e } })
      const rows = async (sql: string) => (await db.query(sql)).rows
      console.log(JSON.stringify({
        tally: await rows('SELECT id, n FROM tally ORDER BY id'),
        note: await rows('SELECT id, tally_id, note FROM tally_note'),
        read: await rows('SELECT id, n FROM tally_read ORDER BY id'),
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
      read: [{ id: 'a', n: 2 }, { id: 'b', n: 3 }],
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
