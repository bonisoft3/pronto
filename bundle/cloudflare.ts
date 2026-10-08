// Bundles a pronto app into a Cloudflare Worker + Durable Object release.
// The Worker serves static browser assets and routes /auth/*, /crud/*, and
// /electric/* to a Durable Object that runs the cluster over native SQLite.
//
//   deno run -A --config bundle/deno.json bundle/cloudflare.ts <appDir> --omnishell <dir> --mecha <dir> [--out <dir>]
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

function fail(msg: string): never {
  console.error(`cloudflare: ${msg}`)
  Deno.exit(1)
}

const here = path.dirname(fileURLToPath(import.meta.url))
const args = Deno.args.slice()
const app = path.resolve(args.shift() ?? fail('usage: cloudflare.ts <appDir> --omnishell <dir> --mecha <dir> [--out <dir>]'))
const flags: Record<string, string> = {}
while (args.length) {
  const flag = args.shift()!
  flags[flag] = args.shift() ?? fail(`${flag} takes a value`)
}
const omnishell = path.resolve(flags['--omnishell'] ?? fail('--omnishell names the interpreter root'))
const mecha = path.resolve(flags['--mecha'] ?? fail('--mecha names the mecha root'))
const out = path.resolve(flags['--out'] ?? path.join(app, 'dist/cloudflare'))
const domain = flags['--domain'] ?? ''
for (const flag of Object.keys(flags)) {
  if (!['--omnishell', '--mecha', '--out', '--domain'].includes(flag)) fail(`unknown flag ${flag}`)
}

const publicDir = path.join(out, 'public')
const srcDir = path.join(out, 'src')
await Deno.mkdir(publicDir, { recursive: true })
await Deno.mkdir(srcDir, { recursive: true })

// 1. Build the browser bundle without in-page cluster into <out>/public
const bundleScript = path.join(here, 'bundle.ts')
const bundleArgs = [
  'run', '-A', '--config', path.join(here, 'deno.json'),
  bundleScript, app,
  '--omnishell', omnishell,
  '--mecha', mecha,
  '--out', publicDir,
  '--no-cluster',
]
const bundleProc = new Deno.Command(Deno.execPath(), {
  args: bundleArgs,
  stdout: 'inherit',
  stderr: 'inherit',
}).outputSync()
if (!bundleProc.success) fail('bundle.ts failed')

// 2. Copy shell assets (such as opponent portraits) into <out>/public/shell/assets
const assetsDir = path.join(app, 'shell/assets')
try {
  const stat = await Deno.stat(assetsDir)
  if (stat.isDirectory) {
    const targetAssets = path.join(publicDir, 'shell/assets')
    await Deno.mkdir(targetAssets, { recursive: true })
    for await (const entry of Deno.readDir(assetsDir)) {
      if (entry.isFile) {
        await Deno.copyFile(path.join(assetsDir, entry.name), path.join(targetAssets, entry.name))
      }
    }
  }
} catch (err) {
  if (!(err instanceof Deno.errors.NotFound)) throw err
}

// 3. Read shell.json to extract tables and schema
const shellText = await Deno.readTextFile(path.join(app, 'shell/shell.json'))
const shell = JSON.parse(shellText) as {
  app?: string
  tables?: string[]
  schema?: Record<string, { fields?: Array<{ name: string; type: string; pk?: boolean; required?: boolean }> }>
}
const appName = shell.app ?? path.basename(app)
const tables = shell.tables ?? []

function sqliteType(type: string): string {
  if (type === 'int' || type === 'integer') return 'INTEGER'
  if (type === 'boolean') return 'INTEGER'
  if (type === 'numeric' || type === 'real') return 'REAL'
  return 'TEXT'
}

const tableStatements: string[] = []
const tableSchemas: Record<string, Record<string, { type: string; pk_index?: number; not_null?: boolean }>> = {}
for (const table of tables) {
  const fields = shell.schema?.[table]?.fields ?? []
  const s: Record<string, { type: string; pk_index?: number; not_null?: boolean }> = {}
  let pkIdx = 0
  if (fields.length > 0) {
    const cols = fields.map((f) => {
      let def = `"${f.name}" ${sqliteType(f.type)}`
      if (f.pk) def += ' PRIMARY KEY'
      s[f.name] = {
        type: f.type,
        ...(f.pk ? { pk_index: pkIdx++ } : {}),
        ...(f.required ? { not_null: true } : {}),
      }
      return def
    })
    tableStatements.push(`CREATE TABLE IF NOT EXISTS "${table}" (\n  ${cols.join(',\n  ')}\n);`)
  } else {
    s['id'] = { type: 'text', pk_index: 0, not_null: true }
    tableStatements.push(`CREATE TABLE IF NOT EXISTS "${table}" (id TEXT PRIMARY KEY, created_at TEXT);`)
  }
  tableSchemas[table] = s
}
tableStatements.push(`CREATE TABLE IF NOT EXISTS "app_user" (id TEXT PRIMARY KEY, handle TEXT);`)
tableSchemas['app_user'] = {
  id: { type: 'text', pk_index: 0, not_null: true },
  handle: { type: 'text' },
}
tableStatements.push(`CREATE TABLE IF NOT EXISTS "schedule" (
  name TEXT PRIMARY KEY,
  cron TEXT NOT NULL,
  time_zone TEXT NOT NULL DEFAULT 'UTC',
  suspended INTEGER NOT NULL DEFAULT 0,
  max_lateness_seconds INTEGER NOT NULL DEFAULT 300,
  concurrency_policy TEXT NOT NULL DEFAULT 'Allow',
  done_entity TEXT,
  done_filter TEXT,
  emits_entity TEXT NOT NULL,
  emits_values TEXT NOT NULL DEFAULT '{}',
  last_tick_at TEXT
);`)
tableSchemas['schedule'] = {
  name: { type: 'text', pk_index: 0, not_null: true },
  cron: { type: 'text', not_null: true },
}

// 4. Emit src/index.ts (Cloudflare Worker + Durable Object cluster)
const workerTs = `// Generated by pronto for Cloudflare Workers + Durable Objects
import { DurableObject } from "cloudflare:workers";

interface ShapeEntry {
  offset: number;
  table: string;
  message: any;
}

const corsHeaders: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, PATCH, DELETE, OPTIONS",
  "access-control-allow-headers": "*",
  "access-control-expose-headers": "electric-handle, electric-offset, electric-cursor, electric-schema, electric-up-to-date, content-type, cache-control",
};

export class ClusterDurableObject extends DurableObject {
  private tables: Set<string> = new Set(${JSON.stringify(tables)});
  private tableSchemas: Record<string, Record<string, any>> = ${JSON.stringify(tableSchemas)};
  private tail: number = 0;
  private entries: ShapeEntry[] = [];
  private waiters: Map<string, Set<() => void>> = new Map();
  private bootId: string = "cf-" + Math.random().toString(36).slice(2, 8);

  constructor(ctx: DurableObjectState, env: any) {
    super(ctx, env);
    this.initTables();
  }

  private initTables() {
    const sqlStatements = ${JSON.stringify(tableStatements)};
    for (const sql of sqlStatements) {
      this.ctx.storage.sql.exec(sql);
    }
  }

  async alarm() {
    await this.runDueSchedules();
  }

  private sweepLobby(): number {
    if (!this.tables.has("lobby")) return 0;
    const cutoff = new Date(Date.now() - 60_000).toISOString();
    const staleRows = [...this.ctx.storage.sql.exec('SELECT id FROM "lobby" WHERE updated_at < ?', cutoff)];
    for (const row of staleRows) {
      this.ctx.storage.sql.exec('DELETE FROM "lobby" WHERE id = ?', row.id);
      this.recordChange("lobby", "delete", { id: row.id });
    }
    return staleRows.length;
  }

  private async runDueSchedules() {
    this.sweepLobby();

    const schedules = [...this.ctx.storage.sql.exec("SELECT * FROM schedule WHERE suspended = 0")];
    const activeLobbyCount = this.tables.has("lobby")
      ? ([...this.ctx.storage.sql.exec('SELECT COUNT(*) as c FROM "lobby"')][0]?.c ?? 0)
      : 0;

    if (schedules.length === 0 && activeLobbyCount === 0) {
      return;
    }

    await this.ctx.storage.setAlarm(Date.now() + 60_000);
  }

  private notifyWaiters(table: string) {
    const tableWaiters = this.waiters.get(table);
    if (tableWaiters) {
      for (const w of tableWaiters) w();
      tableWaiters.clear();
    }
    const sockets = this.ctx.getWebSockets();
    for (const ws of sockets) {
      ws.send(JSON.stringify({ type: "poke", table, lsn: this.tail }));
    }
  }

  private recordChange(table: string, op: "insert" | "update" | "delete", row: Record<string, any>) {
    const offset = ++this.tail;
    const msg = {
      key: \`"public"."\${table}"/"\${row.id ?? ""}"\`,
      value: row,
      headers: {
        operation: op,
        relation: ["public", table],
        lsn: String(offset),
        op_position: 0,
        last: true
      }
    };
    this.entries.push({ offset, table, message: msg });
    if (this.entries.length > 2000) this.entries.shift();
    this.notifyWaiters(table);
  }

  async fetch(request: Request): Promise<Response> {
    const u = new URL(request.url);
    const path = u.pathname;

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    // WebSocket upgrade
    if (request.headers.get("Upgrade") === "websocket") {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.ctx.acceptWebSocket(server);
      return new Response(null, { status: 101, webSocket: client });
    }

    if (request.method === "POST" && path === "/poke") {
      await this.runDueSchedules();
      return new Response(JSON.stringify({ ok: true, swept: true }), {
        headers: { ...corsHeaders, "content-type": "application/json" }
      });
    }

    // --- /auth/* ---
    if (request.method === "POST" && path === "/auth/guest") {
      const id = crypto.randomUUID();
      const user = { id, handle: \`truqueiro-\${id.slice(0, 4)}\`, guest: true };
      const token = btoa(JSON.stringify({ alg: "none", typ: "JWT" })) + "." +
                    btoa(JSON.stringify({ sub: id, role: "app_user", guest: true })) + ".";
      return new Response(JSON.stringify({ token, user }), {
        headers: { ...corsHeaders, "content-type": "application/json" }
      });
    }

    if (request.method === "POST" && path === "/auth/shape") {
      const body = await request.json().catch(() => ({})) as { table?: string };
      const table = body.table ?? "lobby";
      const token = btoa(JSON.stringify({ alg: "none", typ: "JWT" })) + "." +
                    btoa(JSON.stringify({ typ: "shape", table, where: "1=1" })) + ".";
      return new Response(JSON.stringify({ token, table, where: "1=1", expires_in: 86400 }), {
        headers: { ...corsHeaders, "content-type": "application/json" }
      });
    }

    if (request.method === "GET" && path === "/auth/whoami") {
      return new Response(JSON.stringify({ id: "guest", handle: "guest", guest: true }), {
        headers: { ...corsHeaders, "content-type": "application/json" }
      });
    }

    // --- /crud/v1/<table> ---
    if (path.startsWith("/crud/")) {
      const parts = path.split("/").filter(Boolean);
      const table = parts[parts.length - 1];
      if (!this.tables.has(table) && table !== "app_user") {
        return new Response(JSON.stringify({ error: \`unknown table \${table}\` }), {
          status: 404,
          headers: { ...corsHeaders, "content-type": "application/json" }
        });
      }

      if (request.method === "GET") {
        if (table === "lobby") this.sweepLobby();
        let sql = \`SELECT * FROM "\${table}"\`;
        const params: any[] = [];
        const whereClauses: string[] = [];

        for (const [key, val] of u.searchParams) {
          if (key === "select" || key === "order" || key === "limit" || key === "offset") continue;
          if (val.startsWith("eq.")) {
            whereClauses.push(\`"\${key}" = ?\`);
            params.push(val.slice(3));
          }
        }

        if (whereClauses.length > 0) {
          sql += " WHERE " + whereClauses.join(" AND ");
        }

        const order = u.searchParams.get("order");
        if (order) {
          const [col, dir] = order.split(".");
          sql += \` ORDER BY "\${col}" \${dir?.toUpperCase() === "DESC" ? "DESC" : "ASC"}\`;
        }

        const limit = u.searchParams.get("limit");
        if (limit && /^\\d+$/.test(limit)) {
          sql += \` LIMIT \${limit}\`;
        }

        const rows = [...this.ctx.storage.sql.exec(sql, ...params)];
        return new Response(JSON.stringify(rows), {
          headers: { ...corsHeaders, "content-type": "application/json" }
        });
      }

      if (request.method === "POST") {
        const body = await request.json();
        const items = Array.isArray(body) ? body : [body];
        for (const item of items) {
          const keys = Object.keys(item);
          const placeholders = keys.map(() => "?").join(", ");
          const cols = keys.map(k => \`"\${k}"\`).join(", ");
          const vals = keys.map(k => item[k]);
          this.ctx.storage.sql.exec(
            \`INSERT OR REPLACE INTO "\${table}" (\${cols}) VALUES (\${placeholders})\`,
            ...vals
          );
          this.recordChange(table, "insert", item);
        }
        if (table === "lobby") {
          const curAlarm = await this.ctx.storage.getAlarm();
          if (!curAlarm) {
            await this.ctx.storage.setAlarm(Date.now() + 60_000);
          }
        }
        return new Response(JSON.stringify(items), {
          status: 201,
          headers: { ...corsHeaders, "content-type": "application/json" }
        });
      }

      if (request.method === "PATCH") {
        const body = await request.json();
        let targetId = "";
        for (const [key, val] of u.searchParams) {
          if (key === "id" && val.startsWith("eq.")) {
            targetId = val.slice(3);
          }
        }
        if (targetId) {
          const updates = Object.keys(body).map(k => \`"\${k}" = ?\`).join(", ");
          const vals = [...Object.values(body), targetId];
          this.ctx.storage.sql.exec(\`UPDATE "\${table}" SET \${updates} WHERE id = ?\`, ...vals);
          const updated = [...this.ctx.storage.sql.exec(\`SELECT * FROM "\${table}" WHERE id = ?\`, targetId)][0] ?? { id: targetId, ...body };
          this.recordChange(table, "update", updated);
          return new Response(JSON.stringify([updated]), {
            headers: { ...corsHeaders, "content-type": "application/json" }
          });
        }
        return new Response(JSON.stringify([]), {
          headers: { ...corsHeaders, "content-type": "application/json" }
        });
      }

      if (request.method === "DELETE") {
        let targetId = "";
        for (const [key, val] of u.searchParams) {
          if (key === "id" && val.startsWith("eq.")) {
            targetId = val.slice(3);
          }
        }
        if (targetId) {
          this.ctx.storage.sql.exec(\`DELETE FROM "\${table}" WHERE id = ?\`, targetId);
          this.recordChange(table, "delete", { id: targetId });
        }
        return new Response(null, { status: 204, headers: corsHeaders });
      }
    }

    // --- /electric/v1/shape ---
    if (path === "/electric/v1/shape") {
      const table = u.searchParams.get("table") || "lobby";
      if (table === "lobby") this.sweepLobby();
      const offset = u.searchParams.get("offset") || "-1";
      const live = u.searchParams.get("live") === "true";
      const changesOnly = u.searchParams.get("log") === "changes_only";
      const handle = \`\${table}-\${this.bootId}\`;
      const schema = this.tableSchemas[table] ?? { id: { type: "text", pk_index: 0, not_null: true } };

      const baseHeaders: Record<string, string> = {
        ...corsHeaders,
        "content-type": "application/json",
        "cache-control": "no-store",
        "electric-handle": handle,
        "electric-offset": \`\${this.tail}_0\`,
        "electric-cursor": String(this.tail),
        "electric-schema": JSON.stringify(schema),
      };

      // 1. Snapshot request for on-demand collections (subset__* params)
      const isSubset = ["subset__where", "subset__params", "subset__limit", "subset__order_by"].some(k => u.searchParams.has(k));
      if (isSubset) {
        const where = u.searchParams.get("subset__where");
        const paramsRaw = u.searchParams.get("subset__params");
        const paramsMap = paramsRaw ? JSON.parse(paramsRaw) : {};
        const queryParams: any[] = [];
        let sql = \`SELECT * FROM "\${table}"\`;

        if (where) {
          const whereSql = where.replace(/\\$(\\d+)/g, (_, idx) => {
            queryParams.push(paramsMap[idx] ?? null);
            return "?";
          });
          sql += \` WHERE \${whereSql}\`;
        }

        const orderBy = u.searchParams.get("subset__order_by");
        if (orderBy) {
          sql += \` ORDER BY \${orderBy}\`;
        }
        const limit = u.searchParams.get("subset__limit");
        if (limit) {
          sql += \` LIMIT \${limit}\`;
        }

        const rows = [...this.ctx.storage.sql.exec(sql, ...queryParams)];
        const mark = ++this.tail;
        const metadata = {
          xmin: "1",
          xmax: "1",
          xip_list: [],
          snapshot_mark: mark,
          database_lsn: String(this.tail + 1)
        };
        const data = rows.map((r: any) => ({
          key: \`"public"."\${table}"/"\${r.id ?? ""}"\`,
          value: r,
          headers: {
            operation: "insert",
            relation: ["public", table],
            snapshot_mark: mark
          }
        }));

        const from = u.searchParams.get("offset");
        const ownOffset = from && from !== "-1" && from !== "now" ? from : \`\${this.tail}_0\`;
        return new Response(JSON.stringify({ metadata, data }), {
          headers: {
            ...baseHeaders,
            "electric-offset": ownOffset,
          }
        });
      }

      // 2. Initial shape from now or changes_only
      if (offset === "now" || (offset === "-1" && changesOnly)) {
        return new Response(JSON.stringify([
          { headers: { control: "up-to-date", global_last_seen_lsn: String(this.tail) } }
        ]), {
          headers: {
            ...baseHeaders,
            "electric-up-to-date": "true"
          }
        });
      }

      // 3. Full initial shape snapshot (offset = -1)
      if (offset === "-1") {
        let sql = \`SELECT * FROM "\${table}"\`;
        const order = u.searchParams.get("order");
        if (order) {
          const [col, dir] = order.split(".");
          sql += \` ORDER BY "\${col}" \${dir?.toUpperCase() === "DESC" ? "DESC" : "ASC"}\`;
        }
        const rows = [...this.ctx.storage.sql.exec(sql)];
        const msgs: any[] = rows.map((r: any) => ({
          key: \`"public"."\${table}"/"\${r.id ?? ""}"\`,
          value: r,
          headers: { operation: "insert", relation: ["public", table] }
        }));
        msgs.push({
          headers: { control: "up-to-date", global_last_seen_lsn: String(this.tail) }
        });
        return new Response(JSON.stringify(msgs), {
          headers: {
            ...baseHeaders,
            "electric-up-to-date": "true"
          }
        });
      }

      // 4. Live or polling offset
      const numOffset = parseInt(offset.split("_")[0], 10);
      const pending = this.entries.filter(e => e.table === table && e.offset > numOffset);

      if (pending.length > 0) {
        const msgs = pending.map(e => e.message);
        msgs.push({
          headers: { control: "up-to-date", global_last_seen_lsn: String(this.tail) }
        });
        return new Response(JSON.stringify(msgs), {
          headers: {
            ...baseHeaders,
            "electric-offset": \`\${this.tail}_0\`,
            "electric-up-to-date": "true"
          }
        });
      }

      if (live) {
        await new Promise<void>((resolve) => {
          let tableWaiters = this.waiters.get(table);
          if (!tableWaiters) {
            tableWaiters = new Set();
            this.waiters.set(table, tableWaiters);
          }
          const done = () => {
            clearTimeout(t);
            tableWaiters!.delete(done);
            resolve();
          };
          const t = setTimeout(done, 15000);
          tableWaiters.add(done);
        });

        const newPending = this.entries.filter(e => e.table === table && e.offset > numOffset);
        if (newPending.length > 0) {
          const msgs = newPending.map(e => e.message);
          msgs.push({
            headers: { control: "up-to-date", global_last_seen_lsn: String(this.tail) }
          });
          return new Response(JSON.stringify(msgs), {
            headers: {
              ...baseHeaders,
              "electric-offset": \`\${this.tail}_0\`,
              "electric-up-to-date": "true"
            }
          });
        }
        return new Response(null, {
          status: 204,
          headers: {
            ...baseHeaders,
            "electric-offset": \`\${this.tail}_0\`,
            "electric-up-to-date": "true"
          }
        });
      }

      return new Response(JSON.stringify([
        { headers: { control: "up-to-date", global_last_seen_lsn: String(this.tail) } }
      ]), {
        headers: {
          ...baseHeaders,
          "electric-up-to-date": "true"
        }
      });
    }

    return new Response(JSON.stringify({ error: "not found" }), {
      status: 404,
      headers: { ...corsHeaders, "content-type": "application/json" }
    });
  }
}

export default {
  async fetch(request: Request, env: any, ctx: ExecutionContext): Promise<Response> {
    const u = new URL(request.url);
    const path = u.pathname;

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET, POST, PATCH, DELETE, OPTIONS",
          "access-control-allow-headers": "*",
          "access-control-expose-headers": "electric-handle, electric-offset, electric-cursor, electric-schema, electric-up-to-date, content-type, cache-control",
        }
      });
    }

    // Route cluster endpoints to the shared singleton Durable Object
    if (
      path.startsWith("/auth/") ||
      path.startsWith("/crud/") ||
      path.startsWith("/electric/") ||
      path === "/ws" ||
      path === "/poke"
    ) {
      const id = env.CLUSTER.idFromName("truco-cluster");
      const stub = env.CLUSTER.get(id);
      return stub.fetch(new Request("http://do.local" + u.pathname + u.search, request));
    }

    // Serve static client assets from the Assets binding
    if (env.ASSETS) {
      const res = await env.ASSETS.fetch(request);
      if (res.status === 404 && (!path.includes(".") || request.headers.get("accept")?.includes("text/html"))) {
        // SPA fallback to index.html
        return env.ASSETS.fetch(new Request(new URL("/index.html", request.url), request));
      }
      return res;
    }

    return new Response("Not found", { status: 404 });
  },

  async scheduled(controller: any, env: any, ctx: ExecutionContext): Promise<void> {
    const id = env.CLUSTER.idFromName("truco-cluster");
    const stub = env.CLUSTER.get(id);
    await stub.fetch(new Request("http://do.local/poke?caller=cloudflare-cron", { method: "POST" }));
  }
};
`
await Deno.writeTextFile(path.join(srcDir, 'index.ts'), workerTs)

// 5. Emit wrangler.jsonc
const routesSection = domain
  ? `,\n  "routes": [\n    { "pattern": "${domain}", "custom_domain": true }\n  ]`
  : ''
const wranglerJsonc = `{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "${appName}",
  "main": "src/index.ts",
  "compatibility_date": "2026-10-01",
  "compatibility_flags": ["nodejs_compat"],
  "triggers": {
    "crons": ["* * * * *"]
  },
  "assets": {
    "directory": "./public",
    "binding": "ASSETS",
    "not_found_handling": "single-page-application"
  },
  "durable_objects": {
    "bindings": [
      { "name": "CLUSTER", "class_name": "ClusterDurableObject" }
    ]
  },
  "migrations": [
    { "tag": "v1", "new_sqlite_classes": ["ClusterDurableObject"] }
  ]${routesSection}
}
`
await Deno.writeTextFile(path.join(out, 'wrangler.jsonc'), wranglerJsonc)

// 6. Emit package.json
const packageJson = `{
  "name": "${appName}-cloudflare",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "dev": "wrangler dev",
    "deploy": "wrangler deploy"
  },
  "devDependencies": {
    "@cloudflare/workers-types": "^4.20240925.0",
    "wrangler": "^3.80.0"
  }
}
`
await Deno.writeTextFile(path.join(out, 'package.json'), packageJson)
console.error(`cloudflare: ${out} ready with Worker, Durable Object cluster, and static assets`)
