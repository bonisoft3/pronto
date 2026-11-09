// mecha's edge object computing through the machines edge-machines.ts renders
// from the compute batch machine, in Durable Objects under wrangler dev, on
// mecha-edge's own test fixture (its seed, drains worker config and assets).
// Needs libraries/mecha/packages/pglite-workerd/dist.
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import { startWorker } from '../../../libraries/mecha/packages/pglite-workerd/wrangler-dev.ts'
import { load } from '../../../libraries/mecha/packages/pglite-workerd/load.ts'
import { seed } from '../../../libraries/mecha/packages/mecha-edge/test/seed.ts'
import { renderMachines } from './edge-machines.ts'
import { batchMachine } from '../compute/machine.ts'

export const MECHA = new URL('../../../libraries/mecha/', import.meta.url)
export const OMNISHELL = new URL('../../omnishell/', import.meta.url).pathname

export async function fixture(maxAttempts = 25, clock = 'disabled', transportFailure = false, physicalSnapshots = false, manual = false) {
  const temporary = await Deno.makeTempDir({ prefix: 'edge-compute-' })
  const readerName = `reader-${temporary.split('/').at(-1)}`
  const owners = { A: readerName, B: `${readerName}-b` }
  await Deno.writeTextFile(`${temporary}/reader-owner.js`, `export default ${JSON.stringify(readerName)}`)
  const mecha = MECHA.pathname
  await seed(`${temporary}/pgdata`)
  const db = await PGlite.create({ dataDir: `${temporary}/pgdata` })
  await db.exec(`CREATE ROLE service NOLOGIN BYPASSRLS; GRANT USAGE ON SCHEMA public TO service;
    CREATE TABLE computed(id text PRIMARY KEY, body text NOT NULL, scope_id text GENERATED ALWAYS AS ('public:') STORED NOT NULL);
    CALL rls_protect('computed'); CREATE POLICY everyone ON computed FOR SELECT USING(true);
    GRANT SELECT ON computed TO app_user; GRANT ALL ON computed TO service;
    CREATE TABLE computed_other(id text PRIMARY KEY, body text NOT NULL); GRANT ALL ON computed_other TO service;
    INSERT INTO app_user VALUES ('00000000-0000-4000-8000-000000000001','seeded');
    INSERT INTO note(id,owner,body) VALUES ('00000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000001','initial');
    CHECKPOINT;`)
  await db.exec(await Deno.readTextFile(new URL('services/ticker/schedule.sql', MECHA)))
  await db.exec('CREATE TABLE tick(id uuid PRIMARY KEY, schedule text, tick_at timestamptz, late boolean, caller text); GRANT ALL ON tick TO service; CHECKPOINT;')
  await db.close()
  await Deno.copyFile(new URL('../compute/rules.js', import.meta.url), `${temporary}/rules.js`)
  await Deno.writeTextFile(`${temporary}/machine.js`, await renderMachines('compute-test', temporary, OMNISHELL, {
    compute_batch: { reducer: batchMachine.machine as unknown as { name: string; fuel: number } & Record<string, unknown>, rules: 'rules.js' },
  }))
  await Deno.writeTextFile(`${temporary}/worker.ts`, `import { edgeObject } from '${mecha}packages/mecha-edge/src/object.ts'
import { edgeWorker } from '${mecha}packages/mecha-edge/src/worker.ts'
import { computeCoordinator } from '${mecha}packages/mecha-edge/src/compute-coordinator.ts'
import { computeReader } from '${mecha}packages/mecha-edge/src/compute-reader.ts'
import machines from './machine.js'
import readerOwner from './reader-owner.js'
import pgliteWasm from '${mecha}packages/pglite-workerd/dist/pglite.wasm'
import initdbWasm from '${mecha}packages/pglite-workerd/dist/initdb.wasm'
import pgliteData from '${mecha}packages/pglite-workerd/dist/pglite.data'
import icu from '${mecha}packages/pglite-workerd/dist/icu-root.tgz'
export class ComputeCoordinator extends computeCoordinator((snapshot,env)=>env.CLUSTER.get(env.CLUSTER.idFromName('cluster')).testExecute(snapshot)) {${manual ? 'async wake() {}' : ''}}
export const ComputeReader = computeReader({pgliteWasm,initdbWasm,pgliteData,icu},[{name:'copy',version:'v1',reads:['note'],to:['computed'],coalesceMs:25,maxAttempts:${maxAttempts}}],machines.compute_batch)
const Base = edgeObject({clock:${JSON.stringify(clock)},assets:{pgliteWasm,initdbWasm,pgliteData,icu},tables:['note','computed'],compute:{
 computations:[{name:'copy',version:'v1',reads:['note'],to:['computed'],coalesceMs:25,maxAttempts:${maxAttempts}}${transportFailure ? ",{name:'independent',version:'v1',reads:[],to:['computed_other'],coalesceMs:25}" : ''}], machine:machines.compute_batch, physicalSnapshots:${physicalSnapshots},reader:readerOwner
}})
export class Cluster extends Base {
 mode='fail'; active=false; release=null; resetStarted=false;
 async computeSnapshot(capture){
  if(${transportFailure} && capture.identity.name==='copy')return new Response(new ReadableStream({start(c){c.error(new Error('snapshot transport interrupted'))}}));
  return super.computeSnapshot(capture);
 }
 async testExecute(snapshot){
  if(snapshot.name==='independent')return {computed_other:[{id:'done',body:'independent'}]};
  this.active=true;
  try {
   if(this.mode==='fail')throw new Error('executor unavailable');
   if(this.mode==='hold')await new Promise(resolve=>this.release=resolve);
   return {computed:snapshot.tables.note.rows.map(row=>({id:row.id,body:row.body}))};
  } finally {this.active=false;this.release=null;}
 }
 async fetch(req) {
  const path=new URL(req.url).pathname
  if(path==='/import/reset')this.resetStarted=true;
  if(path==='/test/retention')return Response.json({readers:this.computeReaders(),resetStarted:this.resetStarted,snapshots:this.ctx.storage.sql.exec('SELECT id FROM fs_snapshot').toArray()});
  if(path.startsWith('/test/reader/')){
   const {capture,owner='A'}=await req.json();
   const binding=this.env['TEST_READER_'+owner];
   const reader=binding.get(binding.idFromName(JSON.stringify([capture.generation,capture.identity.id])));
   const action=path.split('/').at(-1);
   if(action==='hold')await reader.holdRelease();
   else if(action==='fail')await reader.failRelease();
   else if(action==='resume')await reader.resumeRelease();
   else if(action==='status')return Response.json(await reader.testStatus(capture));
   else throw new Error('unknown reader test action');
   return Response.json({ok:true});
  }
  if(path==='/test/prepare')return Response.json(await this.computePrepare(await req.json()));
  if(path==='/test/reject'){await this.computeReject(await req.json(),'test exhausted');return Response.json({ok:true})}
  if(path==='/test/publication')return Response.json(await this.computePublication(await req.json()));
  if(path==='/test/staged'){
   const {capture,action='publish'}=await req.json();
   if(action==='stage'){
    await this.computeOutputChunk(capture,'test', 'computed',0,[{id:'staged',body:'published'}]);
    await this.computeSealOutput(capture,'test',{computed:{chunks:1,rows:1}});
   }else await this.computePublishStaged(capture,'test');
   return Response.json({ok:true});
  }
  if(path==='/test/mend'){this.mode='ok';return Response.json({ok:true})}
  if(path==='/test/hold'){this.mode='hold';return Response.json({ok:true})}
  if(path==='/test/release'){this.mode='ok';this.release?.();return Response.json({ok:true})}
  if(path==='/test/clock'){
   const db=await this.booted();
   await db.exec("INSERT INTO schedule(name,due_at,emits_entity) VALUES('healthy',now() - interval '1 second','tick')");
   await this.rearm();return Response.json({ok:true});
  }
  if(path==='/test/stale'){
   const capture=await req.json();
   await this.computePublish(capture,Response.json({computed:[{id:'stale',body:'wrong generation'}]}));
   return Response.json({ok:true});
  }
  if(path==='/test/capture')return Response.json(await this.computeClaim());
  if(path==='/test/state'){
   const db=await this.booted();
   const installed=(await db.query("SELECT to_regclass('compute_snapshot_private.batches') IS NOT NULL AS ok")).rows[0].ok;
   const scheduler=await this.env.COMPUTE_COORDINATOR.get(this.env.COMPUTE_COORDINATOR.idFromName('compute')).status();
   return Response.json({...scheduler,active:this.active,captureTables:installed?(await db.query("SELECT count(*)::int AS count FROM compute_snapshot_private.capture_tables")).rows[0].count:0,rows:(await db.query('SELECT id,body FROM computed ORDER BY id')).rows,
    ticks:(await db.query('SELECT schedule FROM tick')).rows,other:(await db.query('SELECT id,body FROM computed_other')).rows,
    batches:installed?(await db.query('SELECT name,state,failures,retry_at,error FROM compute_snapshot_private.batches ORDER BY name')).rows:[]})
  }
  return super.fetch(req)
 }
}
export default {fetch(req,env,ctx){return new URL(req.url).pathname.startsWith('/test/')?env.CLUSTER.get(env.CLUSTER.idFromName('cluster')).fetch(req):edgeWorker.fetch(req,env,ctx)}}
`)
  const configUrl = new URL('packages/mecha-edge/test/drains-wrangler.jsonc', MECHA)
  const config = JSON.parse(await Deno.readTextFile(configUrl))
  config.name = 'edge-compute-test'
  config.main = './worker.ts'
  config.durable_objects.bindings.push({name:'COMPUTE_COORDINATOR',class_name:'ComputeCoordinator'})
  config.migrations.push({tag:'v2-compute-coordinator',new_sqlite_classes:['ComputeCoordinator']})
  if (physicalSnapshots) config.durable_objects.bindings.push({name:'COMPUTE_READER',class_name:'ComputeReader',script_name:readerName})
  config.assets.directory = new URL('public', configUrl).pathname
  config.alias = Object.fromEntries(Object.entries(config.alias as Record<string, string>)
    .map(([name, target]) => [name, fileURLToPath(new URL(target, configUrl))]))
  const companions: URL[] = []
  if (physicalSnapshots) {
    await Deno.writeTextFile(`${temporary}/reader.ts`, `
import { computeReader } from '${mecha}packages/mecha-edge/src/compute-reader.ts'
import machines from './machine.js'
import pgliteWasm from '${mecha}packages/pglite-workerd/dist/pglite.wasm'
import initdbWasm from '${mecha}packages/pglite-workerd/dist/initdb.wasm'
import pgliteData from '${mecha}packages/pglite-workerd/dist/pglite.data'
import icu from '${mecha}packages/pglite-workerd/dist/icu-root.tgz'
const Reader=computeReader({pgliteWasm,initdbWasm,pgliteData,icu},[{name:'copy',version:'v1',reads:['note'],to:['computed'],coalesceMs:25,maxAttempts:${maxAttempts}}],machines.compute_batch)
export class ComputeReader extends Reader {
 held=false; waiting=[]; failNextRelease=false;
 async failRelease(){this.failNextRelease=true}
 async holdRelease(){this.held=true}
 async resumeRelease(){this.held=false;for(const resolve of this.waiting.splice(0))resolve()}
 async release(){if(this.held)await new Promise(resolve=>this.waiting.push(resolve));await super.release();if(this.failNextRelease){this.failNextRelease=false;throw new Error('lost reader release acknowledgement')}}
 async testStatus(capture){
  const released=this.ctx.storage.sql.exec("SELECT 1 FROM sqlite_master WHERE name='reader_released'").toArray().length && this.ctx.storage.sql.exec('SELECT 1 FROM reader_released').toArray().length>0;
  return {waiting:this.waiting.length,released:Boolean(released),imported:released?null:await this.status(capture)};
 }
}
export default{fetch(){return new Response(null,{status:404})}}
`)
    for (const [owner, name] of Object.entries(manual ? owners : { A: readerName })) {
      await Deno.writeTextFile(`${temporary}/reader-${owner}.json`, JSON.stringify({name,main:'reader.ts',compatibility_date:config.compatibility_date,rules:config.rules,alias:config.alias,durable_objects:{bindings:[{name:'READER',class_name:'ComputeReader'}]},migrations:[{tag:'v1',new_sqlite_classes:['ComputeReader']}]}))
      companions.push(new URL(`file://${temporary}/reader-${owner}.json`))
      config.durable_objects.bindings.push({name:`TEST_READER_${owner}`,class_name:'ComputeReader',script_name:name})
    }
  }
  await Deno.writeTextFile(`${temporary}/wrangler.json`, JSON.stringify(config))
  const worker = await startWorker(new URL(`file://${temporary}/wrangler.json`), `${temporary}/state`, companions)
  type State = { captureTables: number; failures: { generation: string; identity: { name: string; revision: number }; error: string }[]; failure: unknown; alarm: number | null; active: boolean; ticks: {schedule: string}[]; rows: { id: string; body: string }[]; other: {id:string;body:string}[]; batches: { name: string; failures: number; error: string | null; retry_at: number | null; state: { requested: number; completed: number } }[] }
  const state = async () => await (await fetch(`${worker.origin}/test/state`)).json() as State
  const until = async (test: (value: State) => boolean) => {
    for (let i = 0; i < (physicalSnapshots ? 1200 : 100); i++) { const value = await state(); if (test(value)) return value; await new Promise(resolve => setTimeout(resolve, 100)) }
    assert.fail(JSON.stringify(await state()))
  }
  const cleanup = async () => { await worker.stop(); await Deno.remove(temporary, { recursive: true }) }
  const at = (path: string, init?: RequestInit) => fetch(`${worker.origin}${path}`, init)
  const install = (reset = false) => load(`${temporary}/pgdata`, (route, init) => at(`/import/${route}`, { ...init, headers: { authorization: 'Bearer test-import' } }), { reset, log: () => {} })
  try { await install() } catch(error) { await cleanup(); throw error }
  const rebind = async (owner: keyof typeof owners) => {
    await worker.stop()
    config.durable_objects.bindings.find((binding: {name:string}) => binding.name === 'COMPUTE_READER').script_name = owners[owner]
    await Deno.writeTextFile(`${temporary}/reader-owner.js`, `export default ${JSON.stringify(owners[owner])}`)
    await Deno.writeTextFile(`${temporary}/wrangler.json`, JSON.stringify(config))
    await worker.restart()
  }
  const disableCompute = async () => {
    await worker.stop()
    const file = `${temporary}/worker.ts`
    await Deno.writeTextFile(file, (await Deno.readTextFile(file)).replace('compute:{', 'unusedCompute:{'))
    await worker.restart()
  }
  return { worker, state, until, at, install, cleanup, rebind, disableCompute, owners }
}
