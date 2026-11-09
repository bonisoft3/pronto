// The compute batch machine (mecha-snapshot-fixture.ts) driving mecha's
// snapshot coordinator over PGlite: claims, captures, publication, replay
// and restart.
import { PGlite } from 'npm:@electric-sql/pglite@0.5.8';
import { assertEquals, assertRejects } from 'jsr:@std/assert@1.0.11';
import { machine } from './mecha-snapshot-fixture.ts';
import { createSnapshotCoordinator, type Computation, type Database, type Queryable, type Output, type Snapshot } from '../../libraries/mecha/packages/compute-snapshot/src/index.ts';

const spec: Computation = { name: 'totals', version: 'v1', reads: ['source'], to: ['sink'], coalesceMs: 10 };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}
async function fixture() {
  const db = new PGlite();
  await db.exec(`CREATE ROLE service; GRANT USAGE ON SCHEMA public TO service;
    CREATE TABLE source(id text PRIMARY KEY, amount numeric(30,4), payload json, happened timestamptz);
    CREATE TABLE sink(id text PRIMARY KEY, amount numeric(30,4), scope_id text GENERATED ALWAYS AS ('public:') STORED, txid bigint DEFAULT 1);
    CREATE TABLE second(id text PRIMARY KEY, amount numeric(30,4) CHECK(amount>=0));
    CREATE TABLE downstream(id text PRIMARY KEY, amount numeric(30,4));
    CREATE TABLE audit(id bigserial PRIMARY KEY, operation text);
    CREATE FUNCTION audit_sink() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      INSERT INTO audit(operation) VALUES(TG_OP); RETURN NULL; END $$;
    CREATE TRIGGER audit_sink AFTER INSERT OR UPDATE OR DELETE ON sink FOR EACH ROW EXECUTE FUNCTION audit_sink();
    GRANT ALL ON ALL TABLES IN SCHEMA public TO service; GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO service;
    INSERT INTO source VALUES ('one',9007199254740993.1234,'{"large":900719925474099312345}', '2026-01-02 03:04:05.123456Z');`);
  let tail: Promise<unknown> = Promise.resolve();
  const serialize = <T>(fn: () => Promise<T>): Promise<T> => {
    const operation = tail.then(fn);
    tail = operation.then(() => undefined, () => undefined);
    return operation;
  };
  let time = 100;
  const config = { db, serialize, machine, now: () => time, retryDelayMs: () => 20 };
  const output = (snapshot: Snapshot): Output => ({ sink: snapshot.tables.source.rows.map(row => ({ id: row.id, amount: row.amount })) });
  return { db, serialize, config, output, tick: (n: number) => { time += n; }, write: (sql: string) => serialize(() => db.exec(sql)) };
}

Deno.test('capture is lossless, immutable across retry and restart; bootstrap only once', async () => {
  const f = await fixture();
  const captured: Snapshot[] = [];
  let coordinator = await createSnapshotCoordinator({ ...f.config, computations: [spec], execute: async snapshot => {
    captured.push(snapshot); throw new Error('executor unavailable');
  } });
  assertEquals(await coordinator.wakeAt(), 110);
  f.tick(10);
  await assertRejects(() => coordinator.resume(), Error, 'executor unavailable');
  assertEquals(captured[0].tables.source.rows[0], { id: 'one', amount: '9007199254740993.1234', payload: '{"large":900719925474099312345}', happened: '2026-01-02 03:04:05.123456+00' });
  assertEquals(captured[0].tables.source.columns.find(c => c.name === 'amount')?.type, 'numeric(30,4)');
  assertEquals(await coordinator.wakeAt(), 130);
  await coordinator.stop();
  await f.write(`UPDATE source SET amount=7 WHERE id='one'`);
  coordinator = await createSnapshotCoordinator({ ...f.config, computations: [spec], execute: async snapshot => { captured.push(snapshot); return f.output(snapshot); } });
  f.tick(20);
  await coordinator.resume();
  assertEquals(captured[1], captured[0]);
  assertEquals(JSON.stringify(captured[1]), JSON.stringify(captured[0]));
  assertEquals((await f.db.query<{ amount: string }>('SELECT amount::text FROM sink')).rows[0].amount, '9007199254740993.1234');
  assertEquals(await coordinator.wakeAt(), 140);
  f.tick(10);
  await coordinator.resume();
  assertEquals((await f.db.query<{ amount: string }>('SELECT amount::text FROM sink')).rows[0].amount, '7.0000');
  await coordinator.stop();
  coordinator = await createSnapshotCoordinator({ ...f.config, computations: [spec], execute: async () => { throw new Error('unexpected reboot compute'); } });
  assertEquals(await coordinator.wakeAt(), null);
  await coordinator.resume();
  await coordinator.stop();
  await f.db.close();
});

Deno.test('writes during execution coalesce one following batch; unchanged output preserves owned columns and emits no changes', async () => {
  const f = await fixture();
  const started = deferred<void>();
  const release = deferred<void>();
  const seen: Snapshot[] = [];
  const coordinator = await createSnapshotCoordinator({ ...f.config, computations: [spec], execute: async snapshot => {
    seen.push(snapshot);
    if (seen.length === 1) { started.resolve(); await release.promise; }
    return f.output(snapshot);
  } });
  await coordinator.wakeAt(); f.tick(10);
  const running = coordinator.resume(); await started.promise;
  await f.write(`UPDATE source SET amount=2; UPDATE source SET amount=3;`);
  release.resolve(); await running;
  assertEquals(seen.length, 1);
  assertEquals(await coordinator.wakeAt(), 120);
  f.tick(10); await coordinator.resume();
  assertEquals(seen.length, 2);
  assertEquals((await f.db.query('SELECT amount::text,scope_id,txid::text FROM sink')).rows, [{ amount: '3.0000', scope_id: 'public:', txid: '1' }]);
  await f.write('UPDATE sink SET txid=42; DELETE FROM audit; UPDATE source SET amount=3');
  await coordinator.wakeAt(); f.tick(10); await coordinator.resume();
  assertEquals((await f.db.query('SELECT * FROM audit')).rows, []);
  assertEquals((await f.db.query('SELECT txid::text FROM sink')).rows, [{ txid: '42' }]);
  await coordinator.stop(); await f.db.close();
});

Deno.test('multi-table publication and receipt roll back together and retry the capture', async () => {
  const f = await fixture();
  let invalid = true;
  const seen: string[] = [];
  const coordinator = await createSnapshotCoordinator({ ...f.config, computations: [{ ...spec, to: ['sink', 'second'] }], execute: async snapshot => {
    seen.push(snapshot.id);
    return { ...f.output(snapshot), second: [{ id: 'one', amount: invalid ? '-1' : '1' }] };
  } });
  await coordinator.wakeAt(); f.tick(10);
  await assertRejects(() => coordinator.resume(), Error, 'check constraint');
  assertEquals((await f.db.query('SELECT * FROM sink')).rows, []);
  assertEquals((await f.db.query('SELECT * FROM compute_snapshot_private.receipts')).rows, []);
  assertEquals((await f.db.query('SELECT * FROM compute_snapshot_private.captures')).rows.length, 1);
  invalid = false; f.tick(20); await coordinator.resume();
  assertEquals(seen[0], seen[1]);
  assertEquals((await f.db.query('SELECT * FROM compute_snapshot_private.receipts')).rows.length, 1);
  assertEquals((await f.db.query('SELECT * FROM compute_snapshot_private.captures')).rows, []);
  await coordinator.stop(); await f.db.close();
});

Deno.test('dependency order follows producers regardless of declaration order', async () => {
  const f = await fixture();
  const calls: string[] = [];
  const downstream = { ...spec, name: 'downstream', reads: ['sink'], to: ['downstream'], coalesceMs: 0 };
  const coordinator = await createSnapshotCoordinator({ ...f.config, computations: [downstream, { ...spec, coalesceMs: 0 }], execute: async snapshot => {
    calls.push(snapshot.name);
    return snapshot.name === 'totals' ? f.output(snapshot) : { downstream: snapshot.tables.sink.rows.map(row => ({ id: row.id, amount: row.amount })) };
  } });
  await coordinator.resume();
  assertEquals(calls, ['totals', 'downstream']);
  assertEquals((await f.db.query('SELECT amount::text FROM downstream')).rows, [{ amount: '9007199254740993.1234' }]);
  await coordinator.stop(); await f.db.close();
});

Deno.test('late replaced-version response cannot overwrite newer publication', async () => {
  const f = await fixture();
  const started = deferred<void>(); const release = deferred<void>();
  const old = await createSnapshotCoordinator({ ...f.config, computations: [{ ...spec, coalesceMs: 0 }], execute: async snapshot => {
    started.resolve(); await release.promise; return f.output(snapshot);
  } });
  const running = old.resume(); await started.promise;
  const fresh = await createSnapshotCoordinator({ ...f.config, computations: [{ ...spec, version: 'v2', coalesceMs: 0 }], execute: async () => ({ sink: [{ id: 'one', amount: '99' }] }) });
  await fresh.resume(); release.resolve(); await running;
  assertEquals((await f.db.query('SELECT amount::text FROM sink')).rows, [{ amount: '99.0000' }]);
  assertEquals((await f.db.query('SELECT version FROM compute_snapshot_private.receipts')).rows, [{ version: 'v2' }]);
  await old.stop(); await fresh.stop(); await f.db.close();
});

Deno.test('duplicate replay after lost acknowledgment publishes once', async () => {
  const f = await fixture();
  const started = deferred<void>(); const release = deferred<void>();
  const first = await createSnapshotCoordinator({ ...f.config, computations: [{ ...spec, coalesceMs: 0 }], execute: async snapshot => {
    started.resolve(); await release.promise; return f.output(snapshot);
  } });
  const pending = first.resume(); await started.promise;
  const replay = await createSnapshotCoordinator({ ...f.config, computations: [{ ...spec, coalesceMs: 0 }], execute: async snapshot => f.output(snapshot) });
  await replay.resume(); release.resolve(); await pending;
  assertEquals((await f.db.query('SELECT * FROM audit')).rows.length, 1);
  assertEquals((await f.db.query('SELECT * FROM compute_snapshot_private.receipts')).rows.length, 1);
  await first.stop(); await replay.stop(); await f.db.close();
});

Deno.test('generated and undeclared sink columns fail before publication', async () => {
  const f = await fixture();
  const coordinator = await createSnapshotCoordinator({ ...f.config, computations: [{ ...spec, coalesceMs: 0 }], execute: async () => ({ sink: [{ id: 'one', amount: '1', scope_id: 'private:' }] }) });
  await assertRejects(() => coordinator.resume(), Error, 'cannot write sink.scope_id');
  assertEquals((await f.db.query('SELECT * FROM sink')).rows, []);
  await coordinator.stop(); await f.db.close();
});

Deno.test('exhaustion remains recorded after restart without scheduling and a new source revision starts fresh work', async () => {
  const f = await fixture();
  const exhausted = { ...spec, maxAttempts: 1, coalesceMs: 0 };
  let coordinator = await createSnapshotCoordinator({ ...f.config, computations: [exhausted], execute: async () => { throw new Error('broken executor'); } });
  await assertRejects(() => coordinator.resume(), Error, 'broken executor');
  await coordinator.stop();
  coordinator = await createSnapshotCoordinator({ ...f.config, computations: [exhausted], execute: async snapshot => f.output(snapshot) });
  assertEquals(await coordinator.wakeAt(), null);
  await coordinator.resume();
  assertEquals((await f.db.query('SELECT failures,error FROM compute_snapshot_private.batches')).rows, [{failures: 1, error: 'broken executor'}]);
  await f.write('UPDATE source SET amount=7');
  await coordinator.resume();
  assertEquals((await f.db.query('SELECT amount::text FROM sink')).rows, [{ amount: '7.0000' }]);
  assertEquals((await f.db.query('SELECT * FROM compute_snapshot_private.captures')).rows, []);
  await coordinator.stop(); await f.db.close();
});

Deno.test('onComplete uses service authority and participates in atomic publication', async () => {
  const f = await fixture();
  await f.db.exec(`CREATE FUNCTION completed() RETURNS void LANGUAGE plpgsql AS $$ BEGIN
    IF current_user <> 'service' OR current_setting('request.jwt.claims')::json->>'role' <> 'service' THEN RAISE EXCEPTION 'wrong authority'; END IF;
    RAISE EXCEPTION 'completion failed'; END $$;`);
  const coordinator = await createSnapshotCoordinator({ ...f.config, computations: [{ ...spec, coalesceMs: 0, onComplete: 'completed' }], execute: async snapshot => f.output(snapshot) });
  await assertRejects(() => coordinator.resume(), Error, 'completion failed');
  assertEquals((await f.db.query('SELECT * FROM sink')).rows, []);
  assertEquals((await f.db.query('SELECT * FROM compute_snapshot_private.receipts')).rows, []);
  await f.db.exec(`CREATE OR REPLACE FUNCTION completed() RETURNS void LANGUAGE plpgsql AS $$ BEGIN
    IF current_user <> 'service' THEN RAISE EXCEPTION 'wrong authority'; END IF; END $$;`);
  f.tick(20); await coordinator.resume();
  assertEquals((await f.db.query('SELECT current_user AS role')).rows, [{ role: 'postgres' }]);
  assertEquals((await f.db.query('SELECT * FROM compute_snapshot_private.receipts')).rows.length, 1);
  await coordinator.stop(); await f.db.close();
});

Deno.test('JSON sink equality supports unchanged JSON and private state denies the service role', async () => {
  const f = await fixture();
  await f.db.exec('ALTER TABLE sink ADD COLUMN payload json');
  const coordinator = await createSnapshotCoordinator({ ...f.config, computations: [{ ...spec, coalesceMs: 0 }], execute: async snapshot => ({ sink: [{ ...f.output(snapshot).sink[0], payload: { count: '9007199254740993' } }] }) });
  await coordinator.resume();
  await f.write('DELETE FROM audit; UPDATE source SET amount=amount');
  await coordinator.resume();
  assertEquals((await f.db.query('SELECT * FROM audit')).rows, []);
  await assertRejects(() => f.db.transaction(async tx => {
    await tx.exec('SET LOCAL ROLE service');
    await tx.query('SELECT * FROM compute_snapshot_private.captures');
  }), Error, 'permission denied');
  await coordinator.stop(); await f.db.close();
});

Deno.test('completed captures are reclaimed and removing then reinstalling a version starts above its receipts', async () => {
  const f = await fixture();
  const revisions: number[] = [];
  const config = { ...f.config, computations: [{ ...spec, coalesceMs: 0 }], execute: async (snapshot: Snapshot) => {
    if (revisions.includes(snapshot.revision)) throw new Error('reused completed execution identity');
    revisions.push(snapshot.revision); return f.output(snapshot);
  } };
  let coordinator = await createSnapshotCoordinator(config);
  await coordinator.resume();
  for (const amount of [2, 3, 4]) {
    await f.write(`UPDATE source SET amount=${amount}`);
    await coordinator.resume();
    assertEquals((await f.db.query('SELECT * FROM compute_snapshot_private.captures')).rows, []);
  }
  assertEquals((await f.db.query('SELECT * FROM compute_snapshot_private.receipts')).rows.length, 4);
  await coordinator.stop();
  const removed = await createSnapshotCoordinator({ ...config, computations: [] });
  await removed.stop();
  await f.write('UPDATE source SET amount=9');
  coordinator = await createSnapshotCoordinator(config);
  await coordinator.resume();
  assertEquals(revisions, [1, 2, 3, 4, 5]);
  assertEquals(await coordinator.wakeAt(), null);
  assertEquals((await f.db.query('SELECT amount::text FROM sink')).rows, [{ amount: '9.0000' }]);
  await coordinator.stop(); await f.db.close();
});

Deno.test('removing an uncommitted capture releases its payload without permitting a late response after reinstall', async () => {
  const f = await fixture();
  const started = deferred<void>(); const release = deferred<void>();
  const old = await createSnapshotCoordinator({ ...f.config, computations: [{ ...spec, coalesceMs: 0 }], execute: async snapshot => {
    started.resolve(); await release.promise; return f.output(snapshot);
  } });
  const oldRun = old.resume(); await started.promise;
  const stopping = old.stop();
  const removed = await createSnapshotCoordinator({ ...f.config, computations: [], execute: async snapshot => f.output(snapshot) });
  await removed.stop();
  assertEquals((await f.db.query('SELECT * FROM compute_snapshot_private.captures')).rows, []);
  assertEquals((await f.db.query('SELECT * FROM compute_snapshot_private.receipts')).rows, []);
  await f.write('UPDATE source SET amount=17');
  const freshStarted = deferred<void>(); const freshRelease = deferred<void>();
  const fresh = await createSnapshotCoordinator({ ...f.config, computations: [{ ...spec, coalesceMs: 0 }], execute: async snapshot => {
    assertEquals(snapshot.revision, 2);
    freshStarted.resolve(); await freshRelease.promise; return f.output(snapshot);
  } });
  const freshRun = fresh.resume(); await freshStarted.promise;
  release.resolve(); await oldRun; await stopping;
  assertEquals((await f.db.query('SELECT * FROM sink')).rows, []);
  freshRelease.resolve(); await freshRun;
  assertEquals((await f.db.query('SELECT amount::text FROM sink')).rows, [{ amount: '17.0000' }]);
  assertEquals((await f.db.query('SELECT * FROM compute_snapshot_private.captures')).rows, []);
  assertEquals((await f.db.query('SELECT revision::int FROM compute_snapshot_private.receipts')).rows, [{ revision: 2 }]);
  await fresh.stop(); await f.db.close();
});

Deno.test('revision metadata upgrades from retained receipts before obsolete captures are reclaimed', async () => {
  const f = await fixture();
  const config = { ...f.config, computations: [{ ...spec, coalesceMs: 0 }], execute: async (snapshot: Snapshot) => f.output(snapshot) };
  let coordinator = await createSnapshotCoordinator(config);
  await coordinator.resume(); await coordinator.stop();
  await f.db.exec('DROP TABLE compute_snapshot_private.revisions; DELETE FROM compute_snapshot_private.batches');
  await f.write('UPDATE source SET amount=23');
  coordinator = await createSnapshotCoordinator(config);
  await coordinator.resume();
  assertEquals((await f.db.query('SELECT revision::int FROM compute_snapshot_private.receipts ORDER BY revision')).rows, [{ revision: 1 }, { revision: 3 }]);
  assertEquals((await f.db.query('SELECT amount::text FROM sink')).rows, [{ amount: '23.0000' }]);
  await coordinator.stop(); await f.db.close();
});

Deno.test('an exhausted computation does not prevent independent work and late rejection cannot undo a receipt', async () => {
  const f = await fixture();
  await f.db.exec('CREATE TABLE other(id text PRIMARY KEY, amount numeric(30,4)); GRANT ALL ON other TO service;');
  const coordinator = await createSnapshotCoordinator({ ...f.config, computations: [
    { ...spec, maxAttempts: 1, coalesceMs: 0 },
    { ...spec, name: 'independent', to: ['other'], coalesceMs: 0 },
  ] });
  const failed = (await coordinator.claim())!;
  assertEquals(Object.keys(failed).sort(), ['id', 'name', 'revision', 'version']);
  assertEquals((await coordinator.snapshot(failed)).tables.source.rows[0].id, 'one');
  await assertRejects(() => coordinator.snapshot({ ...failed, revision: failed.revision + 1 }), Error, 'capture is no longer available');
  await coordinator.reject(failed, 'permanent failure');
  const independent = (await coordinator.claim())!;
  assertEquals(independent.name, 'independent');
  await coordinator.publish(independent, { other: [{id: 'one', amount: '42'}] });
  await coordinator.reject(independent, 'response lost after commit');
  assertEquals((await f.db.query('SELECT amount::text FROM other')).rows, [{amount: '42.0000'}]);
  assertEquals(await coordinator.wakeAt(), null);
  assertEquals((await f.db.query("SELECT failures,error FROM compute_snapshot_private.batches WHERE name='independent'")).rows, [{failures: 0, error: null}]);
  await coordinator.stop(); await f.db.close();
});

async function captureRelations(db: PGlite) {
  return (await db.query<{ name: string }>(`SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='compute_snapshot_private' AND c.relkind='r' AND c.relname ~ '^(capture|output)_[0-9a-f]{32}$' ORDER BY c.relname`)).rows;
}

Deno.test('relational captures export bounded immutable chunks without source column collisions', async () => {
  const f = await fixture();
  await f.write(`ALTER TABLE source ADD COLUMN sequence text DEFAULT 'source sequence'; ALTER TABLE source ADD COLUMN c0 text DEFAULT 'source c0';
    INSERT INTO source(id,amount,payload) SELECT 'row-'||i, i, to_json(repeat('é',400)) FROM generate_series(1,300) i`);
  const coordinator = await createSnapshotCoordinator({ ...f.config, computations: [{ ...spec, coalesceMs: 0 }] });
  const identity = (await coordinator.claim())!;
  const manifest = await coordinator.manifest(identity);
  assertEquals(manifest.tables.source.rows, 301);
  assertEquals(manifest.tables.source.columns.map(c => c.name), ['id', 'amount', 'payload', 'happened', 'sequence', 'c0']);
  assertEquals((await f.db.query('SELECT snapshot FROM compute_snapshot_private.captures')).rows, [{ snapshot: null }]);
  await f.write(`DELETE FROM source; INSERT INTO source(id,amount) VALUES ('replacement',8)`);
  const first = await coordinator.chunk(identity, 'source', 0, { maxBytes: 3000, maxRows: 3 });
  assertEquals(await coordinator.chunk(identity, 'source', 0, { maxBytes: 3000, maxRows: 3 }), first);
  const rows = [];
  let after = 0;
  for (;;) {
    const part = await coordinator.chunk(identity, 'source', after, { maxBytes: 3000, maxRows: 3 });
    assertEquals(part.rows.length <= 3, true);
    assertEquals(new TextEncoder().encode(JSON.stringify(part.rows)).length <= 3000, true);
    assertEquals(part.next, after + part.rows.length);
    rows.push(...part.rows);
    if (part.done) break;
    after = part.next;
  }
  assertEquals(rows.length, 301);
  assertEquals((await coordinator.snapshot(identity)).tables.source.rows, rows);
  assertEquals(rows.every(row => row.sequence === 'source sequence' && row.c0 === 'source c0'), true);
  assertEquals(rows.some(row => row.id === 'replacement'), false);
  assertEquals((await coordinator.chunk(identity, 'source', 301)).rows, []);
  await assertRejects(() => coordinator.chunk(identity, 'source', 302), Error, 'cursor exceeds');
  await assertRejects(() => coordinator.chunk(identity, 'source', 0, { maxRows: 129 }), Error, 'chunk bounds');
  await assertRejects(() => coordinator.chunk(identity, 'source', 0, { maxBytes: 262145 }), Error, 'chunk bounds');
  await assertRejects(() => coordinator.chunk(identity, 'sink'), Error, 'has no table');
  await assertRejects(() => coordinator.manifest({ ...identity, name: 'other' }), Error, 'no longer available');
  await assertRejects(() => coordinator.manifest({ ...identity, revision: NaN }), Error, 'invalid compute capture identity');
  await coordinator.publish(identity, { sink: [] });
  assertEquals(await captureRelations(f.db), []);
  await assertRejects(() => coordinator.chunk(identity, 'source'), Error, 'no longer available');
  await coordinator.stop(); await f.db.close();
});

Deno.test('oversized capture rows fail before chunk export but remain readable by full snapshot hosts', async () => {
  const f = await fixture();
  await f.write(`UPDATE source SET payload=to_json(repeat('x',300000))`);
  let exported = false;
  const db = {
    query: f.db.query.bind(f.db), exec: f.db.exec.bind(f.db),
    transaction: <T>(fn: (tx: Queryable) => Promise<T>) => f.db.transaction(tx => fn({
      exec: tx.exec.bind(tx),
      query: (sql: string, params?: unknown[]) => {
        if (sql.includes(' AS row FROM compute_snapshot_private.')) exported = true;
        return tx.query(sql, params);
      },
    })),
  };
  const coordinator = await createSnapshotCoordinator({ ...f.config, db, computations: [{ ...spec, coalesceMs: 0 }] });
  const identity = (await coordinator.claim())!;
  await assertRejects(() => coordinator.chunk(identity, 'source'), Error, 'exceeds chunk byte limit');
  assertEquals(exported, false);
  assertEquals((await coordinator.manifest(identity)).tables.source.rows, 1);
  const snapshot = await coordinator.snapshot(identity);
  assertEquals(snapshot.tables.source.rows[0].payload, JSON.stringify('x'.repeat(300000)));
  assertEquals(snapshot.tables.source.rows[0].happened, '2026-01-02 03:04:05.123456+00');
  await assertRejects(() => coordinator.chunk(identity, 'source'), Error, 'exceeds chunk byte limit');
  await coordinator.stop(); await f.db.close();
});

Deno.test('legacy JSON captures migrate without changing their retained values', async () => {
  const f = await fixture();
  const config = { ...f.config, computations: [{ ...spec, coalesceMs: 0 }] };
  let coordinator = await createSnapshotCoordinator(config);
  const identity = (await coordinator.claim())!;
  const original = await coordinator.snapshot(identity);
  await coordinator.stop();
  for (const row of await captureRelations(f.db)) await f.db.exec(`DROP TABLE compute_snapshot_private."${row.name}"`);
  await f.db.exec('DELETE FROM compute_snapshot_private.capture_tables');
  await f.db.query('UPDATE compute_snapshot_private.captures SET snapshot=$1::jsonb', [JSON.stringify(original)]);
  await f.write('UPDATE source SET amount=1');
  coordinator = await createSnapshotCoordinator(config);
  assertEquals(await coordinator.snapshot(identity), original);
  assertEquals((await f.db.query('SELECT snapshot FROM compute_snapshot_private.captures')).rows, [{ snapshot: null }]);
  assertEquals((await captureRelations(f.db)).length, 1);
  await coordinator.stop();
  coordinator = await createSnapshotCoordinator({ ...config, computations: [] });
  assertEquals(await captureRelations(f.db), []);
  await coordinator.stop(); await f.db.close();
});

Deno.test('output staging requires complete sealed chunks and replays publication exactly once', async () => {
  const f = await fixture();
  const config = { ...f.config, computations: [{ ...spec, coalesceMs: 0 }] };
  let coordinator = await createSnapshotCoordinator(config);
  const identity = (await coordinator.claim())!;
  const one = [{ id: 'one', amount: '3' }];
  await coordinator.outputChunk(identity, 'attempt', 'sink', 0, one);
  await coordinator.outputChunk(identity, 'attempt', 'sink', 0, one);
  await assertRejects(() => coordinator.outputChunk(identity, 'attempt', 'sink', 0, [{ id: 'one', amount: '4' }]), Error, 'replay differs');
  await assertRejects(() => coordinator.outputChunk(identity, 'attempt', 'sink', 1, one), Error, 'duplicate key');
  await assertRejects(() => coordinator.sealOutput(identity, 'attempt', { sink: { chunks: 2, rows: 2 } }), Error, 'incomplete output');
  await assertRejects(() => coordinator.publishStaged(identity, 'attempt'), Error, 'not sealed');
  assertEquals((await f.db.query('SELECT * FROM sink')).rows, []);
  await coordinator.outputChunk(identity, 'attempt', 'sink', 1, [{ id: 'two', amount: '5' }]);
  await coordinator.sealOutput(identity, 'attempt', { sink: { chunks: 2, rows: 2 } });
  await coordinator.stop();
  coordinator = await createSnapshotCoordinator(config);
  await coordinator.sealOutput(identity, 'attempt', { sink: { chunks: 2, rows: 2 } });
  await coordinator.outputChunk(identity, 'attempt', 'sink', 0, one);
  await assertRejects(() => coordinator.outputChunk(identity, 'attempt', 'sink', 2, [{ id: 'three', amount: '8' }]), Error, 'sealed');
  await coordinator.publishStaged(identity, 'attempt');
  await coordinator.publishStaged(identity, 'attempt');
  assertEquals((await f.db.query('SELECT id,amount::text FROM sink ORDER BY id')).rows, [{ id: 'one', amount: '3.0000' }, { id: 'two', amount: '5.0000' }]);
  assertEquals((await f.db.query('SELECT * FROM audit')).rows.length, 2);
  assertEquals((await f.db.query('SELECT * FROM compute_snapshot_private.receipts')).rows.length, 1);
  assertEquals((await f.db.query('SELECT * FROM compute_snapshot_private.outputs')).rows, []);
  assertEquals(await captureRelations(f.db), []);
  await coordinator.stop(); await f.db.close();
});

Deno.test('staged multi-sink publication rolls back all changes and permits a corrected attempt', async () => {
  const f = await fixture();
  const coordinator = await createSnapshotCoordinator({ ...f.config, computations: [{ ...spec, coalesceMs: 0, to: ['sink', 'second'] }] });
  const identity = (await coordinator.claim())!;
  const seal = { sink: { chunks: 1, rows: 1 }, second: { chunks: 1, rows: 1 } };
  await coordinator.outputChunk(identity, 'bad', 'sink', 0, [{ id: 'one', amount: '2' }]);
  await coordinator.outputChunk(identity, 'bad', 'second', 0, [{ id: 'one', amount: '-1' }]);
  await coordinator.sealOutput(identity, 'bad', seal);
  await assertRejects(() => coordinator.publishStaged(identity, 'bad'), Error, 'check constraint');
  assertEquals((await f.db.query('SELECT * FROM sink')).rows, []);
  assertEquals((await f.db.query('SELECT * FROM audit')).rows, []);
  assertEquals((await f.db.query('SELECT * FROM compute_snapshot_private.receipts')).rows, []);
  await coordinator.outputChunk(identity, 'good', 'sink', 0, [{ id: 'one', amount: '2' }]);
  await coordinator.outputChunk(identity, 'good', 'second', 0, [{ id: 'one', amount: '1' }]);
  await coordinator.sealOutput(identity, 'good', seal);
  await coordinator.publishStaged(identity, 'good');
  assertEquals((await f.db.query('SELECT amount::text FROM second')).rows, [{ amount: '1.0000' }]);
  assertEquals(await captureRelations(f.db), []);
  await coordinator.stop(); await f.db.close();
});

Deno.test('replacing a capture reclaims its input and unpublished output and fences stale mutations', async () => {
  const f = await fixture();
  let coordinator = await createSnapshotCoordinator({ ...f.config, computations: [{ ...spec, coalesceMs: 0 }] });
  const identity = (await coordinator.claim())!;
  await coordinator.outputChunk(identity, 'attempt', 'sink', 0, [{ id: 'one', amount: '2' }]);
  await assertRejects(() => coordinator.outputChunk({ ...identity, id: 'forged' }, 'attempt', 'sink', 1, [{ id: 'two', amount: '3' }]), Error, 'no longer available');
  await assertRejects(() => coordinator.publish({ ...identity, id: 'forged' }, { sink: [] }), Error, 'no longer available');
  await coordinator.stop();
  coordinator = await createSnapshotCoordinator({ ...f.config, computations: [{ ...spec, version: 'v2', coalesceMs: 0 }] });
  assertEquals(await captureRelations(f.db), []);
  await assertRejects(() => coordinator.outputChunk(identity, 'attempt', 'sink', 0, [{ id: 'one', amount: '2' }]), Error, 'no longer available');
  await coordinator.publishStaged(identity, 'attempt');
  assertEquals((await f.db.query('SELECT * FROM sink')).rows, []);
  await coordinator.stop(); await f.db.close();
});

Deno.test('staged JSON equality skips unchanged writes and empty seals delete existing rows', async () => {
  const f = await fixture();
  await f.write(`ALTER TABLE sink ADD COLUMN payload json`);
  const coordinator = await createSnapshotCoordinator({ ...f.config, computations: [{ ...spec, coalesceMs: 0 }] });
  const rows = [{ id: 'one', amount: '2', payload: { large: '900719925474099312345' } }];
  for (let cycle = 0; cycle < 2; cycle++) {
    const identity = (await coordinator.claim())!;
    await coordinator.outputChunk(identity, 'attempt', 'sink', 0, rows);
    await coordinator.sealOutput(identity, 'attempt', { sink: { chunks: 1, rows: 1 } });
    const before = (await f.db.query('SELECT xmin::text,xmax::text,ctid::text FROM sink')).rows;
    await coordinator.publishStaged(identity, 'attempt');
    if (cycle > 0) assertEquals((await f.db.query('SELECT xmin::text,xmax::text,ctid::text FROM sink')).rows, before);
    assertEquals((await f.db.query('SELECT * FROM audit')).rows.length, cycle === 0 ? 1 : 0);
    await f.write(`DELETE FROM audit; UPDATE source SET amount=2`);
  }
  const identity = (await coordinator.claim())!;
  await coordinator.sealOutput(identity, 'empty', { sink: { chunks: 0, rows: 0 } });
  await coordinator.publishStaged(identity, 'empty');
  assertEquals((await f.db.query('SELECT * FROM sink')).rows, []);
  assertEquals((await f.db.query('SELECT operation FROM audit')).rows, [{ operation: 'DELETE' }]);
  assertEquals(await captureRelations(f.db), []);
  await f.db.transaction(async tx => {
    await tx.exec('SET LOCAL ROLE service');
    await assertRejects(() => tx.query('SELECT * FROM compute_snapshot_private.captures'), Error, 'permission denied');
  });
  await coordinator.stop(); await f.db.close();
});

Deno.test('publication status fences the full identity and survives removal, restart and supersession', async () => {
  const f = await fixture();
  const config = { ...f.config, computations: [{ ...spec, coalesceMs: 0, maxAttempts: 1 }] };
  let coordinator = await createSnapshotCoordinator(config);
  const first = (await coordinator.claim())!;
  assertEquals(await coordinator.publication(first), 'pending');
  for (const change of [{ id: 'forged' }, { name: 'other' }, { version: 'v2' }, { revision: first.revision + 1 }]) {
    assertEquals(await coordinator.publication({ ...first, ...change }), 'obsolete');
  }
  await assertRejects(async () => await coordinator.publication({ ...first, revision: NaN }), Error, 'invalid compute capture identity');
  await coordinator.publish(first, { sink: [{ id: 'one', amount: '1' }] });
  assertEquals(await coordinator.publication(first), 'published');
  for (const change of [{ name: 'other' }, { version: 'v2' }, { revision: first.revision + 1 }]) {
    assertEquals(await coordinator.publication({ ...first, ...change }), 'obsolete');
  }
  await coordinator.stop();
  coordinator = await createSnapshotCoordinator({ ...config, computations: [] });
  assertEquals(await coordinator.publication(first), 'published');
  await coordinator.stop();
  coordinator = await createSnapshotCoordinator(config);
  const second = (await coordinator.claim())!;
  assertEquals(await coordinator.publication(first), 'published');
  assertEquals(await coordinator.publication(second), 'pending');
  await coordinator.reject(second, 'executor unavailable');
  assertEquals(await coordinator.publication(second), 'pending');
  await f.write('UPDATE source SET amount=2');
  await coordinator.wakeAt();
  assertEquals(await coordinator.publication(second), 'obsolete');
  const third = (await coordinator.claim())!;
  assertEquals(await coordinator.publication(third), 'pending');
  await coordinator.stop();
  coordinator = await createSnapshotCoordinator({ ...config, computations: [] });
  assertEquals(await coordinator.publication(third), 'obsolete');
  assertEquals(await coordinator.publication(first), 'published');
  await coordinator.stop(); await f.db.close();
});

Deno.test('publication remains pending across a failed sink transaction and reports committed receipts after retry', async () => {
  const f = await fixture();
  const config = { ...f.config, computations: [{ ...spec, coalesceMs: 0, to: ['sink', 'second'] }] };
  let coordinator = await createSnapshotCoordinator(config);
  const identity = (await coordinator.claim())!;
  await assertRejects(() => coordinator.publish(identity, {
    sink: [{ id: 'one', amount: '1' }], second: [{ id: 'one', amount: '-1' }],
  }), Error, 'check constraint');
  assertEquals(await coordinator.publication(identity), 'pending');
  await coordinator.stop();
  coordinator = await createSnapshotCoordinator(config);
  assertEquals(await coordinator.publication(identity), 'pending');
  await coordinator.publish(identity, { sink: [{ id: 'one', amount: '1' }], second: [{ id: 'one', amount: '1' }] });
  assertEquals(await coordinator.publication(identity), 'published');
  assertEquals((await f.db.query('SELECT count(*)::int AS count FROM audit')).rows, [{ count: 1 }]);
  await coordinator.publish(identity, { sink: [], second: [] });
  assertEquals(await coordinator.publication(identity), 'published');
  assertEquals((await f.db.query('SELECT count(*)::int AS count FROM audit')).rows, [{ count: 1 }]);
  await coordinator.stop(); await f.db.close();
});

for (const staged of [false, true]) Deno.test(`${staged ? 'staged' : 'direct'} upsert sinks retain history and empty outputs while replacement and stale fences remain`, async () => {
  const f = await fixture();
  await f.write(`INSERT INTO sink(id,amount) VALUES('old',1),('current',2); INSERT INTO second VALUES('old',1),('current',2)`);
  const definition: Computation = { ...spec, coalesceMs: 0, to: ['sink', 'second'], sinkWrites: { sink: 'upsert' } };
  let coordinator = await createSnapshotCoordinator({ ...f.config, computations: [definition] });
  const first = (await coordinator.claim())!;
  const apply = async (identity: typeof first, output: Output) => {
    if (!staged) return await coordinator.publish(identity, output);
    const seal: Record<string, { chunks: number; rows: number }> = {};
    for (const [sink, rows] of Object.entries(output)) {
      if (rows.length) await coordinator.outputChunk(identity, 'attempt', sink, 0, rows);
      seal[sink] = { chunks: rows.length ? 1 : 0, rows: rows.length };
    }
    await coordinator.sealOutput(identity, 'attempt', seal);
    await coordinator.publishStaged(identity, 'attempt');
  };
  await apply(first, { sink: [{ id: 'current', amount: '3' }], second: [{ id: 'current', amount: '3' }] });
  assertEquals((await f.db.query('SELECT id,amount::text FROM sink ORDER BY id')).rows, [{ id: 'current', amount: '3.0000' }, { id: 'old', amount: '1.0000' }]);
  assertEquals((await f.db.query('SELECT id FROM second')).rows, [{ id: 'current' }]);
  await f.write('UPDATE source SET amount=2');
  const second = (await coordinator.claim())!;
  await apply(second, { sink: [], second: [] });
  assertEquals((await f.db.query('SELECT id FROM sink ORDER BY id')).rows, [{ id: 'current' }, { id: 'old' }]);
  assertEquals((await f.db.query('SELECT id FROM second')).rows, []);
  await f.write('UPDATE source SET amount=3');
  const obsolete = (await coordinator.claim())!;
  if (staged) {
    await coordinator.outputChunk(obsolete, 'stale', 'sink', 0, [{ id: 'current', amount: '99' }]);
    await coordinator.sealOutput(obsolete, 'stale', { sink: { chunks: 1, rows: 1 }, second: { chunks: 0, rows: 0 } });
  }
  await coordinator.stop();
  coordinator = await createSnapshotCoordinator({ ...f.config, computations: [{ ...definition, version: 'v2' }] });
  if (staged) await coordinator.publishStaged(obsolete, 'stale');
  else await coordinator.publish(obsolete, { sink: [{ id: 'current', amount: '99' }], second: [] });
  assertEquals((await f.db.query("SELECT amount::text FROM sink WHERE id='current'")).rows, [{ amount: '3.0000' }]);
  assertEquals(await coordinator.publication(obsolete), 'obsolete');
  await coordinator.stop(); await f.db.close();
});

Deno.test('external capture freezes committed metadata before releasing source writes and retries the retained image', async () => {
  const f = await fixture();
  let image: Blob | undefined;
  let calls = 0;
  const entered = deferred<void>();
  const release = deferred<void>();
  const coordinator = await createSnapshotCoordinator({ ...f.config, computations: [spec], retainSnapshot: async () => {
    calls++;
    image ??= await f.db.dumpDataDir();
    if (calls === 1) {
      entered.resolve();
      await release.promise;
      throw new Error('lost snapshot acknowledgement');
    }
  } });
  await coordinator.wakeAt(); f.tick(10);
  const claim = assertRejects(() => coordinator.claim(), Error, 'lost snapshot acknowledgement');
  await entered.promise;
  let written = false;
  const write = f.write(`UPDATE source SET amount=7 WHERE id='one'`).then(() => { written = true; });
  await Promise.resolve();
  assertEquals(written, false);
  release.resolve();
  await claim; await write;
  const identity = (await coordinator.claim())!;
  assertEquals(calls, 2);
  assertEquals((await f.db.query('SELECT * FROM compute_snapshot_private.capture_tables')).rows, []);
  const reader = new PGlite({ loadDataDir: image! });
  const isolated = await createSnapshotCoordinator({ ...f.config, db: reader, computations: [spec] });
  await isolated.materialize(identity);
  await isolated.materialize(identity);
  const snapshot = await isolated.snapshot(identity);
  assertEquals(snapshot.tables.source.rows[0].amount, '9007199254740993.1234');
  await coordinator.publish(identity, f.output(snapshot));
  assertEquals(await coordinator.publication(identity), 'published');
  assertEquals((await f.db.query<{ amount: string }>('SELECT amount::text FROM source')).rows[0].amount, '7.0000');
  await isolated.stop(); await reader.close();
  await coordinator.stop(); await f.db.close();
});

Deno.test('chunk sizing reads only the requested indexed page despite its numeric output alias', async () => {
  const f = await fixture();
  await f.db.exec(`INSERT INTO source(id,amount) SELECT 'row-'||i, i FROM generate_series(1,4096) AS t(i)`);
  let sizing: { sql: string; params?: unknown[] } | undefined;
  const observe = (tx: Queryable): Queryable => ({
    query<T>(sql: string, params?: unknown[]) {
      if (sql.includes('octet_length(')) sizing = { sql, params };
      return tx.query<T>(sql, params);
    },
    exec: sql => tx.exec(sql),
  });
  const db: Database = { ...observe(f.db), transaction: fn => f.db.transaction(tx => fn(observe(tx))) };
  const coordinator = await createSnapshotCoordinator({ ...f.config, db, computations: [{ ...spec, coalesceMs: 0 }] });
  try {
    f.tick(10);
    const identity = (await coordinator.claim())!;
    const page = await coordinator.chunk(identity, 'source', 0);
    assertEquals(page.rows.length, 128);
    assertEquals(page.next, 128);
    assertEquals(page.done, false);
    if (!sizing) throw new Error('chunk sizing query was not observed');
    const plan = await f.db.query<{ 'QUERY PLAN': { Plan: unknown }[] }>(`EXPLAIN (ANALYZE,FORMAT JSON) ${sizing.sql}`, sizing.params);
    const scans: { 'Actual Rows': number }[] = [];
    const visit = (node: unknown) => {
      if (!node || typeof node !== 'object') return;
      const value = node as Record<string, unknown>;
      if (typeof value['Relation Name'] === 'string' && value['Relation Name'].startsWith('capture_')) scans.push(value as { 'Actual Rows': number });
      if (Array.isArray(value.Plans)) value.Plans.forEach(visit);
    };
    visit(plan.rows[0]['QUERY PLAN'][0].Plan);
    assertEquals(scans.length > 0, true);
    assertEquals(scans.every(scan => scan['Actual Rows'] <= 128), true);
    assertEquals(await coordinator.chunk(identity, 'source', 0), page);
    assertEquals((await coordinator.chunk(identity, 'source', page.next)).next, 256);
  } finally { await coordinator.stop(); await f.db.close(); }
});

Deno.test('source statements mark once per nonempty transition and ignore zero-row writes', async () => {
  const f = await fixture();
  const coordinator = await createSnapshotCoordinator({ ...f.config, computations: [spec] });
  await f.db.exec(`CREATE TABLE mark_calls(table_name text);
    CREATE FUNCTION count_mark() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      INSERT INTO public.mark_calls VALUES(NEW.table_name); RETURN NEW; END $$;
    CREATE TRIGGER count_mark BEFORE INSERT ON compute_snapshot_private.inbox FOR EACH ROW EXECUTE FUNCTION count_mark();`);
  const changed = async (sql: string, marks: number) => {
    await f.db.exec('DELETE FROM compute_snapshot_private.inbox; DELETE FROM mark_calls');
    await f.write(sql);
    assertEquals((await f.db.query('SELECT * FROM mark_calls')).rows, Array.from({ length: marks }, () => ({ table_name: 'source' })));
    assertEquals((await f.db.query('SELECT table_name FROM compute_snapshot_private.inbox')).rows, marks ? [{ table_name: 'source' }] : []);
  };
  await changed("INSERT INTO source(id) SELECT 'bulk-'||n FROM generate_series(1,1000) n", 1);
  await changed('UPDATE source SET amount=4', 1);
  await changed("INSERT INTO source(id) SELECT 'bulk-'||n FROM generate_series(1,1000) n ON CONFLICT DO NOTHING", 0);
  await changed("INSERT INTO source(id) SELECT 'none' WHERE false", 0);
  await changed('UPDATE source SET amount=5 WHERE false', 0);
  await changed('DELETE FROM source WHERE false', 0);
  await changed("INSERT INTO source(id,amount) VALUES('one',1) ON CONFLICT(id) DO UPDATE SET amount=EXCLUDED.amount WHERE false", 0);
  await changed("INSERT INTO source(id,amount) VALUES('one',1),('new',2) ON CONFLICT(id) DO UPDATE SET amount=EXCLUDED.amount", 2);
  await changed("DELETE FROM source WHERE id LIKE 'bulk-%'", 1);
  await changed('TRUNCATE source', 1);
  await changed('TRUNCATE source', 1);
  await changed("BEGIN; INSERT INTO source(id) VALUES('rolled-back'); ROLLBACK", 0);
  await coordinator.stop(); await f.db.close();
});

Deno.test('statement notifications replace legacy triggers and are removed with the last reader', async () => {
  const f = await fixture();
  let coordinator = await createSnapshotCoordinator({ ...f.config, computations: [spec] });
  await coordinator.stop();
  await f.db.exec(`DROP TRIGGER compute_snapshot_inserted ON source; DROP TRIGGER compute_snapshot_updated ON source;
    DROP TRIGGER compute_snapshot_deleted ON source;
    CREATE TRIGGER compute_snapshot_changed AFTER INSERT OR UPDATE OR DELETE ON source
      FOR EACH ROW EXECUTE FUNCTION compute_snapshot_private.changed();`);
  const installed = () => f.db.query('SELECT tgname,(tgtype & 1)=1 AS row_trigger FROM pg_trigger WHERE tgrelid=\'source\'::regclass ORDER BY tgname');
  for (let restart = 0; restart < 2; restart++) {
    coordinator = await createSnapshotCoordinator({ ...f.config, computations: [spec] });
    assertEquals((await installed()).rows, ['deleted', 'inserted', 'truncated', 'updated'].map(name => ({ tgname: `compute_snapshot_${name}`, row_trigger: false })));
    await coordinator.stop();
  }
  coordinator = await createSnapshotCoordinator({ ...f.config, computations: [] });
  assertEquals((await installed()).rows, []);
  await coordinator.stop(); await f.db.close();
});
