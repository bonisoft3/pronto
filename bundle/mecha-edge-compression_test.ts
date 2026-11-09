// mecha's edge object under storage compression, computing through the
// machines edge-machines.ts renders (mecha-edge-fixture.ts says what it
// needs).
import assert from 'node:assert/strict'
import { PGlite } from '@electric-sql/pglite'
import { startWorker } from '../../../libraries/mecha/packages/pglite-workerd/wrangler-dev.ts'
import { load } from '../../../libraries/mecha/packages/pglite-workerd/load.ts'
import { seed } from '../../../libraries/mecha/packages/mecha-edge/test/seed.ts'
import { renderMachines } from './edge-machines.ts'
import { batchMachine } from '../compute/machine.ts'
import { MECHA, OMNISHELL } from './mecha-edge-fixture.ts'

Deno.test({ name: 'storage maintenance authenticates and gates boot and computation until compression completes', sanitizeResources: false, sanitizeOps: false }, async () => {
  const temporary = await Deno.makeTempDir({ prefix: 'edge-compression-' })
  const mecha = MECHA.pathname
  await seed(`${temporary}/pgdata`)
  const db = await PGlite.create({ dataDir: `${temporary}/pgdata` })
  await db.exec(`CREATE ROLE service NOLOGIN BYPASSRLS; GRANT USAGE ON SCHEMA public TO service;
    CREATE TABLE computed(id text PRIMARY KEY, body text NOT NULL); GRANT ALL ON computed TO service;
    GRANT SELECT ON note TO service; CHECKPOINT;`)
  await db.close()
  await Deno.copyFile(new URL('../compute/rules.js', import.meta.url), `${temporary}/rules.js`)
  await Deno.writeTextFile(`${temporary}/machine.js`, await renderMachines('compression-test', temporary, OMNISHELL, {
    compute_batch: { reducer: batchMachine.machine as unknown as { name: string; fuel: number } & Record<string, unknown>, rules: 'rules.js' },
  }))
  await Deno.writeTextFile(`${temporary}/worker.ts`, `import { DurableObject } from 'cloudflare:workers'
import { edgeObject, DataDirectoryLoading } from '${mecha}packages/mecha-edge/src/object.ts'
import { edgeWorker } from '${mecha}packages/mecha-edge/src/worker.ts'
import { DataDirectory } from '${mecha}packages/pglite-workerd/src/data-directory.ts'
import machines from './machine.js'
import pgliteWasm from '${mecha}packages/pglite-workerd/dist/pglite.wasm'
import initdbWasm from '${mecha}packages/pglite-workerd/dist/initdb.wasm'
import pgliteData from '${mecha}packages/pglite-workerd/dist/pglite.data'
import icu from '${mecha}packages/pglite-workerd/dist/icu-root.tgz'
export class ComputeCoordinator extends DurableObject {
 async wake(){await this.ctx.storage.put('wakes',(await this.ctx.storage.get('wakes')??0)+1)}
 async count(){return await this.ctx.storage.get('wakes')??0}
}
const Base=edgeObject({clock:'disabled',assets:{pgliteWasm,initdbWasm,pgliteData,icu},tables:['note','board'],
 storageFormat:{version:1,blockSize:8192,codec:'deflate'},
 compute:{computations:[{name:'copy',version:'v1',reads:['note'],to:['computed'],coalesceMs:0}],machine:machines.compute_batch}})
export class Cluster extends Base {
 async fetch(req){
  const path=new URL(req.url).pathname;
  if(path.startsWith('/test/raw/'))return new DataDirectory(this.ctx.storage,{version:1,blockSize:8192,codec:'raw'}).importing(path.slice('/test/raw/'.length),req);
  if(path==='/test/claim')return Response.json(await this.computeClaim());
  if(path==='/test/wake-at')return Response.json(await this.computeWakeAt());
  if(path==='/test/public')try{return await this.readPublic(async snapshot=>Response.json(await snapshot.read('/board?select=title')))}catch(error){if(!(error instanceof DataDirectoryLoading))throw error;return Response.json({loading:true},{status:503})}
  return super.fetch(req);
 }
}
export default {fetch(req,env,ctx){
 const path=new URL(req.url).pathname;
 if(path==='/test/wakes')return env.COMPUTE_COORDINATOR.get(env.COMPUTE_COORDINATOR.idFromName('compute')).count().then(n=>Response.json(n));
 if(path.startsWith('/test/'))return env.CLUSTER.get(env.CLUSTER.idFromName('cluster')).fetch(req);
 return edgeWorker.fetch(req,env,ctx);
}}`)
  const configUrl = new URL('packages/mecha-edge/test/wrangler.jsonc', MECHA)
  const config = JSON.parse(await Deno.readTextFile(configUrl))
  delete config.assets
  config.name = 'mecha-edge-compression-test'
  config.durable_objects.bindings.push({ name: 'COMPUTE_COORDINATOR', class_name: 'ComputeCoordinator' })
  config.migrations[0].new_sqlite_classes.push('ComputeCoordinator')
  config.alias = Object.fromEntries(Object.entries(config.alias).map(([name, path]) => [name, new URL(path as string, configUrl).pathname]))
  await Deno.writeTextFile(`${temporary}/wrangler.json`, JSON.stringify(config))
  const worker = await startWorker(new URL(`file://${temporary}/wrangler.json`), `${temporary}/state`)
  const at = (path: string, init?: RequestInit) => fetch(worker.origin + path, init)
  const headers = { authorization: 'Bearer test-import', 'content-type': 'application/json' }
  const status = async () => {
    const response = await at('/import/storage', { headers })
    assert.equal(response.status, 200)
    return await response.json() as { generation: string; format: unknown; maintenance: { converted: number } | null; ready: boolean }
  }
  const gated = async () => {
    for (const [path, init] of [
      ['/test/public', {}], ['/auth/guest', { method: 'POST' }], ['/crud/board', {}], ['/poke', { method: 'POST', headers }],
    ] as [string, RequestInit][]) {
      const response = await at(path, init)
      assert.equal(response.status, 503, `${path}: ${await response.text()}`)
    }
    assert.equal(await (await at('/test/claim')).json(), null)
    assert.equal(await (await at('/test/wake-at')).json(), null)
    assert.equal(await (await at('/test/wakes')).json(), 0)
  }
  try {
    await load(`${temporary}/pgdata`, (route, init) => at(`/test/raw/${route}`, init), { log: () => {} })
    const before = await status()
    assert.deepEqual(before.format, { version: 1, blockSize: 8192, codec: 'raw' })
    assert.equal(before.ready, false)
    assert.equal(before.maintenance, null)
    await gated()
    for (const path of ['/import/storage', '/import/compress']) {
      for (const authorization of [undefined, 'Bearer wrong']) {
        const response = await at(path, { method: path.endsWith('compress') ? 'POST' : 'GET', headers: authorization ? { authorization } : {} })
        assert.equal(response.status, 401)
        await response.body?.cancel()
      }
    }
    for (const [path, method] of [['/import/storage', 'POST'], ['/import/compress', 'GET']]) {
      const response = await at(path, { method, headers })
      assert.equal(response.status, 405)
      await response.body?.cancel()
    }
    const target = { version: 1, blockSize: 8192, codec: 'deflate' }
    const advance = async () => {
      const response = await at('/import/compress', { method: 'POST', headers, body: JSON.stringify({ generation: before.generation, target }) })
      assert.equal(response.status, 200, await response.clone().text())
      return await response.json() as Awaited<ReturnType<typeof status>>
    }
    let progress = await advance()
    assert.equal(progress.generation, before.generation)
    assert.equal(progress.ready, false)
    assert.equal(progress.maintenance?.converted, 1024)
    await gated()
    await worker.restart()
    assert.deepEqual((await status()).maintenance, progress.maintenance)
    await gated()
    for (let calls = 0; !progress.ready; calls++) {
      assert.ok(calls < 100, 'compression did not finish within the fixture bound')
      progress = await advance()
      assert.equal(progress.generation, before.generation)
    }
    assert.deepEqual(progress.format, target)
    assert.equal(progress.maintenance, null)
    assert.deepEqual(await advance(), await status())
    const guestResponse = await at('/auth/guest', { method: 'POST' })
    assert.equal(guestResponse.status, 200, await guestResponse.clone().text())
    const guest = await guestResponse.json() as { token: string }
    const guestStorage = await at('/import/storage', { headers: { authorization: `Bearer ${guest.token}` } })
    assert.equal(guestStorage.status, 401)
    await guestStorage.body?.cancel()
    const read = await at('/crud/board?select=title', { headers: { authorization: `Bearer ${guest.token}` } })
    assert.equal(read.status, 200)
    assert.deepEqual(await read.json(), [{ title: 'Brasileirão 2026' }])
    assert.deepEqual(await (await at('/test/public')).json(), [{ title: 'Brasileirão 2026' }])
    const claim = await (await at('/test/claim')).json() as { generation: string; identity: { name: string } }
    assert.equal(claim.generation, before.generation)
    assert.equal(claim.identity.name, 'copy')
    assert.ok(await (await at('/test/wakes')).json() as number > 0)
  } finally {
    await worker.stop()
    await Deno.remove(temporary, { recursive: true })
  }
})
