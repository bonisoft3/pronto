// The compute batch machine over mecha's snapshot coordinator, as
// mecha-snapshot.test.ts, for a capture materialized in physical ranges
// from a PGlite data directory on disk.
import { PGlite } from 'npm:@electric-sql/pglite@0.5.8';
import { assert, assertEquals, assertRejects } from 'jsr:@std/assert@1.0.11';
import { machine } from './mecha-snapshot-fixture.ts';
import { createSnapshotCoordinator, MATERIALIZE_BLOCKS, type Computation, type Database, type Queryable } from '../../libraries/mecha/packages/compute-snapshot/src/index.ts';

const spec: Computation = { name: 'copy', version: 'v1', reads: ['source', 'empty_source'], to: ['sink'], coalesceMs: 0, maxAttempts: 1 };
const serial = <T>(fn: () => Promise<T>) => fn();
const config = { serialize: serial, machine, now: () => 100, retryDelayMs: () => 1 };
const progress = async (db: PGlite) => (await db.query<{ relation: string; next_block: number; total_blocks: number; row_count: number }>(
  'SELECT relation,next_block::int,total_blocks::int,row_count::int FROM compute_snapshot_private.capture_progress')).rows;

async function fixture() {
  const dir = await Deno.makeTempDir({ prefix: 'compute-materialize-' });
  const db = new PGlite({ dataDir: dir });
  await db.exec(`CREATE ROLE service; CREATE TABLE source(id integer PRIMARY KEY, sequence integer, c0 text, body text);
    CREATE TABLE empty_source(id text PRIMARY KEY); CREATE TABLE sink(id text PRIMARY KEY);
    INSERT INTO source SELECT i,i*2,'value-'||i,repeat(md5(i::text),32) FROM generate_series(1,10000) AS s(i);
    DELETE FROM source WHERE id%7=0; UPDATE source SET sequence=-sequence WHERE id%11=0;`);
  const source = await createSnapshotCoordinator({ ...config, db, computations: [spec], retainSnapshot: async () => {} });
  const identity = (await source.claim())!;
  assert(identity);
  await source.stop();
  return { db, dir, identity };
}

Deno.test('materialization resumes physical ranges after restart and rolls back rows with their cursor', async () => {
  const f = await fixture();
  let db = f.db;
  let coordinator = await createSnapshotCoordinator({ ...config, db, computations: [spec] });
  try {
    await assertRejects(() => coordinator.manifest(f.identity), Error, 'must be materialized');
    assertEquals(await coordinator.materialize(f.identity), false);
    const [first] = await progress(db);
    assertEquals(first.next_block, MATERIALIZE_BLOCKS);
    assert(first.total_blocks > MATERIALIZE_BLOCKS * 2);
    assert(first.row_count > 0);
    assertEquals((await db.query('SELECT * FROM compute_snapshot_private.capture_tables')).rows, []);
    await assertRejects(() => coordinator.chunk(f.identity, 'source'), Error, 'must be materialized');
    await coordinator.stop(); await db.close();
    db = new PGlite({ dataDir: f.dir });
    assertEquals(await progress(db), [first]);

    let plan: unknown;
    const observe = (tx: Queryable): Queryable => ({
      async query<T>(sql: string, params?: unknown[]) {
        if (sql.includes('WITH copied AS')) plan = (await tx.query(`EXPLAIN (FORMAT JSON) ${sql}`, params)).rows;
        if (sql.includes('UPDATE compute_snapshot_private.capture_progress SET next_block')) throw new Error('lost materialization transaction');
        return tx.query<T>(sql, params);
      },
      exec: sql => tx.exec(sql),
    });
    const failing: Database = { ...observe(db), transaction: fn => db.transaction(tx => fn(observe(tx))) };
    coordinator = await createSnapshotCoordinator({ ...config, db: failing, computations: [spec] });
    await assertRejects(() => coordinator.materialize(f.identity), Error, 'lost materialization transaction');
    assert(JSON.stringify(plan).includes('Tid Range Scan'));
    assertEquals(await progress(db), [first]);
    assertEquals((await db.query<{ count: number }>(`SELECT count(*)::int AS count FROM compute_snapshot_private."${first.relation}"`)).rows[0].count, first.row_count);
    await coordinator.stop();
    coordinator = await createSnapshotCoordinator({ ...config, db, computations: [spec] });
    let done = false;
    for (let i = 0; i < 20 && !done; i++) done = await coordinator.materialize(f.identity);
    assert(done);
    const manifest = await coordinator.manifest(f.identity);
    assertEquals(manifest.tables.source.rows, 10000 - Math.floor(10000 / 7));
    assertEquals(manifest.tables.empty_source.rows, 0);
    assertEquals(await progress(db), []);
    const relation = (await db.query<{ relation: string }>("SELECT relation FROM compute_snapshot_private.capture_tables WHERE source='source'")).rows[0].relation;
    assertEquals((await db.query<{ mismatches: number }>(`SELECT count(*)::int AS mismatches FROM source FULL JOIN compute_snapshot_private."${relation}" retained ON source.id=retained.c0
      WHERE ROW(source.id,source.sequence,source.c0,source.body) IS DISTINCT FROM ROW(retained.c0,retained.c1,retained.c2,retained.c3)`)).rows[0].mismatches, 0);
    assertEquals((await db.query(`SELECT min(sequence)::int AS first,max(sequence)::int AS last,count(DISTINCT sequence)::int AS unique_rows
      FROM compute_snapshot_private."${relation}"`)).rows, [{ first: 1, last: manifest.tables.source.rows, unique_rows: manifest.tables.source.rows }]);
    assertEquals(await coordinator.materialize(f.identity), true);
    assertEquals((await coordinator.chunk(f.identity, 'source', manifest.tables.source.rows - 1)).done, true);
    assertEquals((await coordinator.chunk(f.identity, 'empty_source')).rows, []);
  } finally { await coordinator.stop(); await db.close(); await Deno.remove(f.dir, { recursive: true }); }
});

for (const change of ['remove', 'supersede'] as const) Deno.test(`incomplete materialization relations are reclaimed when a capture is ${change}d`, async () => {
  const f = await fixture();
  let coordinator = await createSnapshotCoordinator({ ...config, db: f.db, computations: [spec] });
  try {
    await coordinator.materialize(f.identity);
    const [partial] = await progress(f.db);
    await coordinator.stop();
    if (change === 'supersede') {
      coordinator = await createSnapshotCoordinator({ ...config, db: f.db, computations: [spec], retainSnapshot: async () => {} });
      await coordinator.reject(f.identity, 'exhausted');
      await f.db.exec("INSERT INTO empty_source VALUES('new')");
      await coordinator.claim();
      assertEquals(await coordinator.publication(f.identity), 'obsolete');
    } else coordinator = await createSnapshotCoordinator({ ...config, db: f.db, computations: [] });
    assertEquals(await progress(f.db), []);
    assertEquals((await f.db.query('SELECT to_regclass($1) AS relation', [`compute_snapshot_private.${partial.relation}`])).rows, [{ relation: null }]);
  } finally { await coordinator.stop(); await f.db.close(); await Deno.remove(f.dir, { recursive: true }); }
});

for (const rewrite of ['TRUNCATE source', 'DROP TABLE source; CREATE TABLE source(id integer PRIMARY KEY, sequence integer, c0 text, body text)']) {
  Deno.test(`materialization refuses changed physical source identity: ${rewrite.split(' ')[0]}`, async () => {
    const f = await fixture();
    const coordinator = await createSnapshotCoordinator({ ...config, db: f.db, computations: [spec] });
    try {
      await coordinator.materialize(f.identity);
      const prior = await progress(f.db);
      await f.db.exec(rewrite);
      await assertRejects(() => coordinator.materialize(f.identity), Error, 'source changed');
      assertEquals(await progress(f.db), prior);
    } finally { await coordinator.stop(); await f.db.close(); await Deno.remove(f.dir, { recursive: true }); }
  });
}

for (const [kind, setup] of [
  ['unlogged table', 'ALTER TABLE source SET UNLOGGED'],
  ['inheritance parent', 'CREATE TABLE child(extra text) INHERITS(source)'],
  ['inheritance child', 'CREATE TABLE parent(extra text); ALTER TABLE source INHERIT parent'],
  ['partitioned parent', 'DROP TABLE source; CREATE TABLE source(id integer) PARTITION BY RANGE(id); CREATE TABLE source_child PARTITION OF source FOR VALUES FROM(0) TO(100)'],
]) Deno.test(`materialization rejects unsupported source (${kind}) before creating a target`, async () => {
  const f = await fixture();
  const coordinator = await createSnapshotCoordinator({ ...config, db: f.db, computations: [spec] });
  try {
    if (setup.includes('ALTER TABLE source INHERIT')) await f.db.exec('ALTER TABLE source ADD COLUMN extra text');
    await f.db.exec(setup);
    await assertRejects(() => coordinator.materialize(f.identity), Error, 'ordinary logged heap table without inheritance');
    assertEquals(await progress(f.db), []);
    assertEquals((await f.db.query('SELECT * FROM compute_snapshot_private.capture_tables')).rows, []);
  } finally { await coordinator.stop(); await f.db.close(); await Deno.remove(f.dir, { recursive: true }); }
});
