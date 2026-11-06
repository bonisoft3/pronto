import * as duckdb from "./duckdb.mjs";
import wasm from "./duckdb.wasm";

export class Probe {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.ready = ctx.blockConcurrencyWhile(async () => {
      const bytes = await Promise.all(["json", "icu"].map(async (name) => {
        const response = await env.ASSETS.fetch(
          `https://assets.invalid/${name}.bin`,
        );
        if (!response.ok) {
          throw Error(`Missing bundled ${name}: ${response.status}`);
        }
        return response.arrayBuffer();
      }));
      duckdb.setExtensions(...bytes);
      globalThis.location = new URL("https://duckdb.invalid/worker.js");
      const db = await duckdb.createDuckDB(
        { mvp: { mainModule: "unused" }, eh: { mainModule: "unused" } },
        new duckdb.VoidLogger(),
        duckdb.BROWSER_RUNTIME,
      );
      db.instantiateWasm = function (imports, success) {
        globalThis.DUCKDB_RUNTIME = this._runtime;
        const instance = new WebAssembly.Instance(wasm, imports);
        success(instance, wasm);
        return instance.exports;
      };
      await db.instantiate();
      this.db = db;
      this.con = db.connect();
      this.con.query(
        `LOAD '/json.duckdb_extension.wasm'; LOAD '/icu.duckdb_extension.wasm';
        SET autoinstall_known_extensions=false; SET autoload_known_extensions=false;
        SET TimeZone='UTC'; SET memory_limit='64MB'; SET threads=1;`,
      );
    });
  }

  async fetch(request) {
    await this.ready;
    const count = Number(new URL(request.url).searchParams.get("rows") || 1200);
    if (![1200, 100000, 1000000].includes(count)) {
      return new Response("Unsupported fixture", { status: 400 });
    }
    const query = (sql) =>
      this.con.query(sql).toArray().map((row) => row.toJSON());
    const scalar = query(
      `SELECT json_extract('{"a":42}', '$.a')::INTEGER AS answer,
      timezone('America/Sao_Paulo', TIMESTAMP '2026-01-01 12:00:00')::VARCHAR AS utc`,
    );
    this.con.query(`CREATE OR REPLACE TABLE events AS SELECT i::INTEGER id,
      (i%100)::INTEGER site, (i%25000)::INTEGER visitor, (i%17=0)::INTEGER bounce FROM range(${count}) t(i);
      CREATE OR REPLACE TABLE sites AS SELECT i::INTEGER id,'site-'||i AS site_name FROM range(100) t(i);`);
    const sql =
      `SELECT s.site_name,count(*)::INTEGER pageviews,count(DISTINCT e.visitor)::INTEGER visitors,
      sum(e.bounce)::INTEGER bounces FROM events e JOIN sites s ON e.site=s.id GROUP BY s.site_name ORDER BY s.site_name`;
    const aggregate = query(sql);
    this.con.query(
      `UPDATE events SET site=1 WHERE id=0; DELETE FROM events WHERE id=1; INSERT INTO events VALUES (-1,2,-1,0)`,
    );
    const updated = query(sql);
    this.con.query("DROP TABLE events; DROP TABLE sites");
    const memory = this.db.mod.HEAPU8.byteLength;
    const runs = await this.ctx.storage.transaction(async (txn) => {
      const next = (await txn.get("runs") || 0) + 1;
      await txn.put("runs", next);
      return next;
    });
    return Response.json({
      count,
      scalar,
      aggregate,
      updated,
      memory,
      runs,
    });
  }
}

export default {
  fetch(request, env) {
    return env.PROBE.get(env.PROBE.idFromName("probe")).fetch(request);
  },
};
