import * as path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { computationDefinitions, computationMachine, type PackagedComputation } from './compute.ts'

const digest = async (bytes: Uint8Array<ArrayBuffer>) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join('')
const textDigest = (text: string) => digest(new TextEncoder().encode(text))
const modulePath = (from: string, file: string) => {
  const relative = path.relative(from, file).replaceAll('\\', '/')
  return relative.startsWith('.') ? relative : `./${relative}`
}
async function command(args: string[]) {
  const result = await new Deno.Command(Deno.execPath(), { args, stdout: 'piped', stderr: 'inherit' }).output()
  if (!result.success) throw new Error(`edge computation packaging failed: deno ${args.join(' ')}`)
  return new TextDecoder().decode(result.stdout)
}

/** Immutable private Workers isolate PGlite, SQL and the pure computation realm. */
export async function writeEdgeCompute(out: string, mecha: string, omnishell: string, programs: PackagedComputation[], name: string) {
  if (!programs.length) return undefined
  await Deno.mkdir(out, { recursive: true })
  out = await Deno.realPath(out)
  mecha = await Deno.realPath(mecha)
  const directory = path.join(out, 'compute')
  const queryDirectory = path.join(directory, 'queries')
  const executionDirectory = path.join(directory, 'execution')
  await Deno.mkdir(queryDirectory, { recursive: true })
  await Deno.mkdir(executionDirectory, { recursive: true })
  await Deno.mkdir(path.join(out, 'src'), { recursive: true })
  await Deno.writeTextFile(path.join(out, 'src/compute-machine.js'), await computationMachine(omnishell))
  const { packageDuckDB } = await import(pathToFileURL(path.join(mecha, 'packages/duckdb-workerd/build.ts')).href)
  const engine = await packageDuckDB(path.join(queryDirectory, 'duckdb'))
  const edge = path.join(mecha, 'packages/mecha-edge/src')
  const runtime = path.join(mecha, 'services/compute')
  const hostFiles = [
    ...['compute.ts', 'snapshot-query.ts', 'snapshot-compute.ts', 'snapshot-program.ts', 'paged-query.ts', 'paged-execution.ts', 'paged-compute.ts', 'paged-transport.ts', 'paged-query-action.ts', 'query-sql.ts'].map(file => path.join(edge, file)),
    ...['static-build.ts', 'static-cage.ts', 'query-stages.ts'].map(file => path.join(runtime, file)),
    fileURLToPath(new URL('edge-compute.ts', import.meta.url)),
    ...['mise.toml', 'mise.lock'].map(file => path.join(mecha, 'packages/pglite-workerd', file)),
  ]
  const stepSources: (string | null)[] = []
  for (const [index, program] of programs.entries()) {
    if (!program.spec.steps) { stepSources.push(null); continue }
    const entry = path.join(directory, `steps-${index}.ts`)
    const output = path.join(directory, `steps-${index}.js`)
    await Deno.writeTextFile(entry, `import {step} from ${JSON.stringify(modulePath(directory, program.spec.steps))};
export const reads=[]; export const queries={}; export const plan=(host,_seed,state)=>step(host,state); export const finish=()=>({});`)
    try {
      await command(['bundle', '--frozen', '--config', path.join(runtime, 'deno.json'), '--platform', 'browser', '--format', 'esm', '--minify', '--output', output, entry])
      stepSources.push(await Deno.readTextFile(output))
    } finally {
      await Deno.remove(entry)
      await Deno.remove(output).catch(error => { if (!(error instanceof Deno.errors.NotFound)) throw error })
    }
  }
  const host = await textDigest(JSON.stringify([Deno.version.deno, engine.fingerprint, stepSources, ...await Promise.all(hostFiles.map(async file => digest(await Deno.readFile(file))))]))
  const packaged = await Promise.all(programs.map(async p => ({ ...p, version: await textDigest(JSON.stringify([p.version, host])) })))
  const buildInput = path.join(directory, 'build-input.json')
  const buildScript = path.join(directory, 'build-static.ts')
  await Deno.writeTextFile(buildInput, JSON.stringify(packaged.map((p,i) => ({ compiled: p.compiled, steps: stepSources[i], file: p.spec.file, endowments: p.spec.endowments ?? [] }))))
  await Deno.writeTextFile(buildScript, `import { staticFactory } from ${JSON.stringify(modulePath(directory, path.join(runtime, 'static-build.ts')))};
import { compile } from ${JSON.stringify(modulePath(directory, path.join(runtime, 'workers.ts')))};
const inputs=JSON.parse(await Deno.readTextFile(new URL('./build-input.json',import.meta.url)));
console.log(JSON.stringify(inputs.map(p=>({factory:staticFactory(p.compiled,p.file,p.endowments),steps:p.steps===null?null:staticFactory(compile(p.file,p.steps),p.file,p.endowments)}))));
`)
  let factories: {factory: string; steps: string | null}[]
  try {
    factories = JSON.parse(await command(['run', '-A', '--frozen', '--config', path.join(runtime, 'deno.json'), buildScript]))
  } finally {
    await Deno.remove(buildScript)
    await Deno.remove(buildInput)
  }
  const sharedWasm = new Map<string, { bytes: Uint8Array<ArrayBuffer>; variable: string }>()
  const imports: string[] = []
  const entries: string[] = []
  const queryPrograms = []
  for (const [index, p] of packaged.entries()) {
    const wasm: string[] = []
    for (const file of p.spec.wasm) {
      const base = path.basename(file)
      if (!/^[A-Za-z0-9_-]+\.wasm$/.test(base)) throw new Error(`invalid WASM artifact name: ${base}`)
      const bytes = await Deno.readFile(file)
      let previous = sharedWasm.get(base)
      if (previous && (previous.bytes.length !== bytes.length || !previous.bytes.every((byte, i) => byte === bytes[i]))) throw new Error(`WASM artifact name collision: ${base}`)
      if (!previous) {
        previous = { bytes, variable: `wasm${sharedWasm.size}` }
        sharedWasm.set(base, previous)
        await Deno.mkdir(path.join(executionDirectory, 'wasm'), { recursive: true })
        await Deno.writeFile(path.join(executionDirectory, 'wasm', base), bytes)
        imports.push(`import ${previous.variable} from './wasm/${base}';`)
      }
      wasm.push(`${JSON.stringify(path.basename(base, '.wasm'))}:${previous.variable}`)
    }
    const { name: computation, to, endowments, types, queryTypes, sinkTypes, sinkWrites } = p.spec
    const contract = { paged: Boolean(p.spec.steps), version: p.version, reads: p.reads, queries: p.queries, ...(p.queryStages ? { queryStages: p.queryStages } : {}), spec: { name: computation, file: `${computation}.js`, to, endowments, types, queryTypes, sinkTypes, sinkWrites } }
    queryPrograms.push(contract)
    entries.push(`{...${JSON.stringify(contract)},factory:${factories[index].factory},${factories[index].steps ? `steps:${factories[index].steps},` : ""}wasm:{${wasm.join(',')}}}`)
  }
  await Deno.writeTextFile(path.join(executionDirectory, 'programs.js'), `${imports.join('\n')}\nexport default [${entries.join(',\n')}];\n`)
  await Deno.writeTextFile(path.join(queryDirectory, 'programs.json'), JSON.stringify(queryPrograms))
  await Deno.writeTextFile(path.join(queryDirectory, 'entry.ts'), `import { createDuckDB } from './duckdb/runtime.js';
import { snapshotQuery } from ${JSON.stringify(modulePath(queryDirectory, path.join(edge, 'snapshot-query.ts')))};
import { pagedQueryAction } from ${JSON.stringify(modulePath(queryDirectory, path.join(edge, 'paged-query-action.ts')))};
import programs from './programs.json' with {type:'json'};
export class Queries {
  constructor(ctx,env){this.ctx=ctx;this.env=env;this.ready=null;this.mode=null;}
  open(paged){
    if(this.mode!==null&&this.mode!==paged)throw new Error('query object mode differs');
    this.mode=paged;
    return this.ready??=this.ctx.blockConcurrencyWhile(()=>createDuckDB(this.env.ASSETS,paged
      ?{storage:this.ctx.storage.sql,memoryLimit:'32MB',maxDatabaseBytes:4*1024**3,maxTemporaryBytes:1024**3}
      :{memoryLimit:'80MB'}));
  }
  async fetch(request){
    if(request.method!=='POST')return new Response(null,{status:404});
    const path=new URL(request.url).pathname;
    if(path!=='/execute'&&path!=='/paged')return new Response(null,{status:404});
    try {
      const body=await request.json();
      if(path==='/paged'&&body.action==='cleanup'){
        if(this.ready)(await this.ready).close();
        this.ready=null;this.mode=null;await this.ctx.storage.deleteAll();return Response.json({cleared:true});
      }
      const db=await this.open(path==='/paged');
      return Response.json(path==='/paged'?await pagedQueryAction(db,programs,body):snapshotQuery(db,programs,body));
    } catch(error) { return new Response(error instanceof Error ? error.message : String(error),{status:500}); }
  }
}
export default {fetch(request,env){
  const url=new URL(request.url);const key=url.pathname==='/paged'?url.searchParams.get('key'):null;
  if(url.pathname==='/paged'&&(!key||key.length>4096))return new Response('missing capture key',{status:400});
  return env.QUERIES.get(env.QUERIES.idFromName(key?'paged:'+key:'queries')).fetch(request);
}};
`)
  await Deno.writeTextFile(path.join(executionDirectory, 'entry.ts'), `import { computeSnapshot } from ${JSON.stringify(modulePath(executionDirectory, path.join(edge, 'snapshot-compute.ts')))};
import { pagedComputeStep } from ${JSON.stringify(modulePath(executionDirectory, path.join(edge, 'paged-compute.ts')))};
import { pagedRequest } from ${JSON.stringify(modulePath(executionDirectory, path.join(edge, 'paged-transport.ts')))};
import programs from './programs.js';
export class Compute {
  constructor(_ctx,env){this.env=env;this.pending=Promise.resolve();}
  async fetch(request){
    const path=new URL(request.url).pathname;
    if(request.method!=='POST'||(path!=='/execute'&&path!=='/paged'))return new Response(null,{status:404});
    try {
      const body=await request.json();
      const run=()=>path==='/execute'?computeSnapshot(programs,this.env.QUERIES,body)
        :body.action==='step'?pagedComputeStep(programs,this.env.QUERIES,body.capture)
        :pagedRequest(this.env.QUERIES,body);
      const result=this.pending.then(run,run);this.pending=result.then(()=>undefined,()=>undefined);
      return Response.json(await result);
    } catch(error) { return new Response(error instanceof Error ? error.message : String(error),{status:500}); }
  }
}
export default {fetch(request,env){return env.COMPUTATIONS.get(env.COMPUTATIONS.idFromName('compute')).fetch(request);}};
`)
  for (const dir of [queryDirectory, executionDirectory]) {
    await command(['bundle', '--frozen', '--config', path.join(runtime, 'deno.json'), '--platform', 'browser', '--format', 'esm', '--minify', '--external', '*.wasm', '--external', './duckdb/runtime.js', '--output', path.join(dir, 'worker.js'), path.join(dir, 'entry.ts')])
    await Deno.remove(path.join(dir, 'entry.ts'))
  }
  const common = {
    main: 'worker.js', compatibility_date: '2026-09-01', workers_dev: false, preview_urls: false,
    observability: { enabled: true }, limits: { cpu_ms: 300000 },
    rules: [{ type: 'CompiledWasm', globs: ['**/*.wasm'], fallthrough: false }],
  }
  const queryConfig = {
    ...common,
    assets: { directory: './duckdb/assets', binding: 'ASSETS', run_worker_first: true },
    durable_objects: { bindings: [{ name: 'QUERIES', class_name: 'Queries' }] },
    migrations: [{ tag: 'v1', new_sqlite_classes: ['Queries'] }],
  }
  const computeConfig = {
    ...common,
    durable_objects: { bindings: [{ name: 'COMPUTATIONS', class_name: 'Compute' }] },
    migrations: [{ tag: 'v1', new_sqlite_classes: ['Compute'] }],
  }
  const release = (await textDigest(JSON.stringify([
    engine.fingerprint, queryConfig, computeConfig,
    ...await Promise.all([queryDirectory, executionDirectory].map(dir => Deno.readFile(path.join(dir, 'worker.js')).then(digest))),
    ...await Promise.all([...sharedWasm].map(async ([file, { bytes }]) => [file, await digest(bytes)])),
  ]))).slice(0, 12)
  const queryName = `${name.slice(0, 40)}-queries-${release}`
  const computeName = `${name.slice(0, 40)}-compute-${release}`
  await Deno.writeTextFile(path.join(queryDirectory, 'wrangler.jsonc'), JSON.stringify({ ...queryConfig, name: queryName }, null, 2))
  await Deno.writeTextFile(path.join(executionDirectory, 'wrangler.jsonc'), JSON.stringify({
    ...computeConfig, name: computeName, services: [{ binding: 'QUERIES', service: queryName }],
  }, null, 2))
  const config = {
    definitions: computationDefinitions(packaged),
    paged: packaged.filter(p => p.spec.steps).map(p => p.spec.name),
    services: [{ binding: 'COMPUTE', service: computeName }],
    deployments: ['compute/queries/wrangler.jsonc', 'compute/execution/wrangler.jsonc'],
  }
  await Deno.writeTextFile(path.join(out, 'src/compute.json'), JSON.stringify(config))
  return config
}
