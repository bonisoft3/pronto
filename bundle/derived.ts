// The rows an app's streams and computations derive, for a page that runs
// neither: the app's own container cluster is brought up, left until it has
// settled, and its live tables are written as SQL the page's PGlite runs after
// the migrations, each table replaced whole.
//
//   deno run -A --config bundle/deno.json bundle/derived.ts <appDir> --tables <t,...> --streams <s,...> --out <file> [--timeout <seconds>]
//
// --tables are the live tables, the only ones a stream or a computation writes
// without feeding the publication; --streams are the ids the transform runs
// them under. The cluster is the app's compose under a project of its own,
// built as `sayt launch` builds it, and it is torn down after, settled or not.
//
// Settlement requires unchanged committed rows for the slowest computation's
// cadence plus its statistics flush, started inputs, drained bus groups, and
// completed computations. Successful no-op reads leave the quiet window open;
// outstanding pipeline work blocks export. The export's rows and fingerprint
// share one database snapshot, checked again before the file is written.
import * as path from 'node:path'

/** Postgres's statistics land up to its idle flush interval after a commit. */
const FLUSH = 15
const POLL = 5

function fail(msg: string): never {
  console.error(`derived: ${msg}`)
  Deno.exit(1)
}

const ident = (s: string) => `"${s.replaceAll('"', '""')}"`

/** `text` dollar-quoted under a tag it does not contain. */
export function dollar(text: string): string {
  let tag = '$derived$'
  for (let n = 1; text.includes(tag); n++) tag = `$derived${n}$`
  return `${tag}${text}${tag}`
}

/** `tables`, each after every other one it references; a cycle is refused. */
export function dependencyOrder(tables: string[], refs: [string, string][]): string[] {
  const order: string[] = []
  const visiting = new Set<string>()
  const visit = (t: string, from: string[]) => {
    if (order.includes(t)) return
    if (visiting.has(t)) throw new Error(`the live tables reference each other in a cycle: ${[...from, t].join(' -> ')}`)
    visiting.add(t)
    for (const [child, parent] of refs) if (child === t && parent !== t && tables.includes(parent)) visit(parent, [...from, t])
    visiting.delete(t)
    order.push(t)
  }
  for (const t of [...tables].sort()) visit(t, [])
  return order
}

/** SQL replacing each table's rows with `rows[t]`, a JSON array of row
 * objects; `order` lists the tables as dependencyOrder does. */
export function derivedSql(order: string[], columns: Record<string, string[]>, rows: Record<string, string>): string {
  const lines = [`-- The live tables as the settled container cluster holds them: ${order.join(', ')}.`]
  for (const t of [...order].reverse()) lines.push(`DELETE FROM public.${ident(t)};`)
  for (const t of order) {
    const cols = columns[t].map(ident).join(', ')
    lines.push(`INSERT INTO public.${ident(t)} (${cols}) SELECT ${cols} FROM json_populate_recordset(NULL::public.${ident(t)}, ${dollar(rows[t])});`)
  }
  return lines.join('\n') + '\n'
}

type Table = { schema: string; name: string }
export type Snapshot = { fingerprint: string; rows: Record<string, string> }
const literal = (s: string) => "'" + s.replaceAll("'", "''") + "'"

/** Row JSON stays text through JavaScript so bigint and numeric stay exact. */
export function snapshotSql(all: Table[], selected: string[] = []): string {
  const fingerprints = all.map(({ schema, name }) => `SELECT ${literal(schema)} AS schema, ${literal(name)} AS name,
    coalesce((SELECT md5(string_agg(md5(r::text), '' ORDER BY md5(r::text))) FROM ${ident(schema)}.${ident(name)} r), md5('')) AS digest`)
  const rows = selected.map((name) => `SELECT ${literal(name)} AS name,
    (SELECT coalesce(json_agg(r ORDER BY r::text), '[]')::text FROM public.${ident(name)} r) AS rows`)
  return `SELECT json_build_object(
    'fingerprint', (${fingerprints.length ? `SELECT json_agg(f ORDER BY schema, name)::text FROM (${fingerprints.join(' UNION ALL ')}) f` : "SELECT '[]'"}),
    'rows', (${rows.length ? `SELECT json_object_agg(name, rows) FROM (${rows.join(' UNION ALL ')}) r` : "SELECT '{}'::json"}))`
}

type Metric = { name: string; labels: Record<string, string>; value: number }

export function pipelineState(text: string, streams: string[]): { waiting: string[]; active: string[]; failures: string } {
  const metrics: Metric[] = text.split('\n').filter((line) => line && !line.startsWith('#')).map((line) => {
    const match = /^(\w+)(?:\{(.*)\})?\s+(\S+)$/.exec(line)
    if (!match) throw new Error(`invalid transform metric: ${line}`)
    const labels: Record<string, string> = {}
    for (const label of (match[2] ?? '').matchAll(/(\w+)=("(?:[^"\\]|\\.)*")/g)) labels[label[1]] = JSON.parse(label[2])
    return { name: match[1], labels, value: Number(match[3]) }
  })
  const waiting: string[] = [], active: string[] = []
  for (const stream of streams) {
    const series = metrics.filter((m) => m.labels.stream === stream)
    const up = series.filter((m) => m.name === 'input_connection_up')
    if (up.length === 0 || up.some((m) => !(m.value > 0))) waiting.push(`stream ${stream} to start`)
    const count = (name: string, at: string) => {
      const samples = series.filter((m) => m.name === name && m.labels.path === at)
      if (samples.some((m) => !Number.isSafeInteger(m.value) || m.value < 0)) throw new Error(`stream ${stream}: invalid ${name}`)
      return samples.length ? samples.reduce((sum, m) => sum + m.value, 0) : undefined
    }
    const received = count('input_received', 'root.input')
    if (received === undefined) {
      waiting.push(`stream ${stream} input metrics`)
      continue
    }
    const first = 'root.pipeline.processors.0'
    const batches = count('processor_batch_received', first)
    const buffered = count('buffer_batch_received', 'root.buffer')
    if (buffered !== undefined) {
      if (received !== count('buffer_received', 'root.buffer') || buffered !== (count('buffer_latency_ns_count', 'root.buffer') ?? 0)) {
        active.push(`stream ${stream} buffer to drain`)
      }
    } else if (batches !== undefined) {
      if (received !== count('processor_received', first) || batches !== (count('input_latency_ns_count', 'root.input') ?? 0)) {
        active.push(`stream ${stream} to finish`)
      }
    } else {
      const sent = count('output_sent', 'root.output')
      if (sent === undefined) throw new Error(`stream ${stream} exposes no pipeline completion metrics`)
      if (received !== sent) active.push(`stream ${stream} to finish`)
    }
    for (const m of series) {
      if ((m.name === 'processor_error' || m.name === 'output_error') && m.value > 0) {
        throw new Error(`stream ${stream}: ${m.name} at ${m.labels.path} is ${m.value}`)
      }
    }
  }
  const failures = metrics.filter((m) => /(?:_error|_connection_failed|_connection_lost)$/.test(m.name))
    .map((m) => JSON.stringify(m)).sort().join('\n')
  return { waiting, active, failures }
}

export class Settlement {
  private last = ''
  private since: number
  constructor(private window: number, now: number) { this.since = now }
  observe(state: { waiting: string[]; active: string[]; moving: string }, now: number): { quiet: number; settled: boolean } {
    if (state.waiting.length || state.moving !== this.last) this.since = now
    this.last = state.moving
    const quiet = (now - this.since) / 1000
    return { quiet, settled: !state.waiting.length && !state.active.length && quiet >= this.window }
  }
}

type Run = { ok: boolean; stdout: string; stderr: string }

async function run(cmd: string, args: string[], cwd: string): Promise<Run> {
  const out = await new Deno.Command(cmd, { args, cwd, stdin: 'null', stdout: 'piped', stderr: 'piped' }).output()
  return { ok: out.success, stdout: new TextDecoder().decode(out.stdout), stderr: new TextDecoder().decode(out.stderr) }
}

type Service = { environment?: Record<string, string>; build?: { context?: string } }

async function main() {
  const args = Deno.args.slice()
  const app = await Deno.realPath(args.shift() ?? fail('usage: derived.ts <appDir> --tables <t,...> --streams <s,...> --out <file> [--timeout <seconds>]'))
  const flags: Record<string, string> = {}
  while (args.length) {
    const flag = args.shift()!
    if (!['--tables', '--streams', '--out', '--timeout'].includes(flag)) fail(`unknown flag ${flag}`)
    flags[flag] = args.shift() ?? fail(`${flag} takes a value`)
  }
  const list = (s: string | undefined) => (s ?? '').split(',').filter((x) => x !== '')
  const tables = list(flags['--tables'])
  if (tables.length === 0) fail('--tables names the live tables to write')
  const streams = list(flags['--streams'])
  const out = path.resolve(flags['--out'] ?? fail('--out names the file to write'))
  const timeout = Number(flags['--timeout'] ?? 1800)
  if (!(timeout > 0)) fail(`--timeout is seconds, not ${flags['--timeout']}`)

  const project = `${path.basename(app)}-derived`.toLowerCase().replace(/[^a-z0-9_-]/g, '-')
  const compose = async (...a: string[]) => {
    const r = await run('docker', ['compose', '-p', project, ...a], app)
    if (!r.ok) throw new Error(`docker compose ${a.join(' ')} failed:\n${r.stderr}`)
    return r.stdout
  }

  // The cluster's services as compose resolves them, picked by build context:
  // the cluster the app instantiates declares targets of the same names.
  const services = (JSON.parse(await compose('config', '--format', 'json')) as { services: Record<string, Service> }).services
  const service = (target: string) =>
    Object.entries(services).find(([name, s]) => name.endsWith(`-${target}`) && s.build?.context === app)
  const database = service('database') ?? fail('the compose runs no database')
  const transform = service('transform')
  const redis = service('redis')
  const compute = service('compute')
  if (streams.length > 0 && (!transform || !redis)) fail('--streams names streams, and the compose runs no transform and bus')
  const computations = compute
    ? (JSON.parse(compute[1].environment?.COMPUTATIONS ?? fail(`${compute[0]} declares no COMPUTATIONS`)) as { name: string; every: number }[])
    : []
  const env = database[1].environment ?? {}
  const psql = (sql: string) =>
    compose('exec', '-T', database[0], 'psql', '-U', env.POSTGRES_USER ?? fail(`${database[0]} declares no POSTGRES_USER`),
      '-d', env.POSTGRES_DB ?? fail(`${database[0]} declares no POSTGRES_DB`), '-AtX', '-v', 'ON_ERROR_STOP=1', '-c', sql)
  const window = FLUSH + Math.max(0, ...computations.map((c) => c.every))

  const snapshot = async (selected: string[] = []): Promise<Snapshot> => {
    const all: Table[] = JSON.parse(await psql("SELECT coalesce(json_agg(json_build_object('schema', schemaname, 'name', relname)), '[]') FROM pg_stat_user_tables"))
    return JSON.parse(await psql(snapshotSql(all, selected)))
  }

  async function state() {
    for (const line of (await compose('ps', '-a', '--format', 'json')).split('\n').filter((l) => l.trim())) {
      const c = JSON.parse(line) as { Service: string; State: string; ExitCode: number }
      if (c.State === 'restarting' || c.State === 'dead' || (c.State === 'exited' && c.ExitCode !== 0)) {
        throw new Error(`${c.Service} is ${c.State} (exit ${c.ExitCode}):\n${await compose('logs', '--tail', '40', c.Service)}`)
      }
    }
    const waiting: string[] = []
    let failures = ''
    let active: string[] = []
    if (transform && redis) {
      const metrics = pipelineState(await compose('exec', '-T', transform[0], 'wget', '-qO-', 'http://localhost:4195/metrics'), streams)
      waiting.push(...metrics.waiting)
      active = metrics.active
      failures = metrics.failures
      const cli = (...a: string[]) => compose('exec', '-T', redis[0], 'redis-cli', '--json', ...a)
      const keys = (await compose('exec', '-T', redis[0], 'redis-cli', '--scan')).split('\n').filter((l) => l)
      for (const key of keys) {
        if (JSON.parse(await cli('TYPE', key)) !== 'stream') continue
        const last = (JSON.parse(await cli('XINFO', 'STREAM', key)) as Record<string, unknown>)['last-generated-id']
        for (const g of JSON.parse(await cli('XINFO', 'GROUPS', key)) as Record<string, unknown>[]) {
          if (g.pending !== 0 || g['last-delivered-id'] !== last) waiting.push(`group ${g.name} on ${key} to drain`)
        }
      }
    }
    if (compute) {
      const ran = new Set(
        (await compose('logs', '--no-log-prefix', '--no-color', compute[0])).split('\n')
          .filter((l) => l.startsWith('{')).map((l) => (JSON.parse(l) as { computation?: string }).computation),
      )
      for (const c of computations) if (!ran.has(c.name)) waiting.push(`computation ${c.name} to run`)
    }
    const { fingerprint } = await snapshot()
    return { waiting, active, moving: `${failures}\n${fingerprint}`, fingerprint }
  }

  async function dump() {
    const names = tables.map(literal).join(', ')
    const refs = (await psql(`
      SELECT c.relname, p.relname FROM pg_constraint k
        JOIN pg_class c ON c.oid = k.conrelid JOIN pg_class p ON p.oid = k.confrelid
      WHERE k.contype = 'f' AND c.relname IN (${names})`))
      .split('\n').filter((l) => l).map((l) => l.split('|') as [string, string])
    const order = dependencyOrder(tables, refs)
    const columns: Record<string, string[]> = {}
    for (const t of order) {
      columns[t] = (await psql(`
        SELECT a.attname FROM pg_attribute a
        WHERE a.attrelid = 'public.${ident(t)}'::regclass AND a.attnum > 0 AND NOT a.attisdropped AND a.attgenerated = ''
        ORDER BY a.attnum`)).split('\n').filter((l) => l)
      if (columns[t].length === 0) throw new Error(`public.${t} has no columns`)
    }
    const { rows, fingerprint } = await snapshot(order)
    return { sql: derivedSql(order, columns, rows), fingerprint }
  }

  let failure: unknown
  try {
    await compose('down', '-v', '--remove-orphans')
    console.error(`derived: building and launching ${project}`)
    await compose('up', '-d', '--wait', '--build', 'launch')
    const deadline = Date.now() + timeout * 1000
    const settlement = new Settlement(window, Date.now())
    let said = '', sql = ''
    while (true) {
      const current = await state()
      const { quiet, settled } = settlement.observe(current, Date.now())
      const blocked = [...current.waiting, ...current.active]
      const now = blocked.length > 0 ? `waiting for ${blocked.join(', ')}` : `quiet, settling over ${window}s`
      if (now !== said) console.error(`derived: ${now}`)
      said = now
      if (settled) {
        const candidate = await dump()
        const checked = await state()
        if (candidate.fingerprint !== current.fingerprint) settlement.observe({ ...current, moving: candidate.fingerprint }, Date.now())
        const stable = settlement.observe(checked, Date.now()).settled
        if (candidate.fingerprint === current.fingerprint && checked.moving === current.moving && stable) {
          sql = candidate.sql
          break
        }
      }
      if (Date.now() > deadline) throw new Error(`not settled after ${timeout}s: ${now}, quiet for ${quiet}s`)
      await new Promise((r) => setTimeout(r, POLL * 1000))
    }
    await Deno.mkdir(path.dirname(out), { recursive: true })
    await Deno.writeTextFile(out, sql)
    console.error(`derived: ${out}, ${(sql.length / 1024 / 1024).toFixed(2)} MB, ${tables.length} tables`)
  } catch (e) {
    failure = e
  }
  const down = await run('docker', ['compose', '-p', project, 'down', '-v', '--remove-orphans'], app)
  if (failure) throw failure
  if (!down.ok) fail(`tearing ${project} down failed:\n${down.stderr}`)
}

if (import.meta.main) await main()
