import assert from 'node:assert/strict'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeEdgeSsr } from './edge-ssr.ts'
import { startWorker } from '../../../libraries/mecha/packages/pglite-workerd/wrangler-dev.ts'

Deno.test({ name: 'separate render RPC retains snapshot readers after headers and releases them at completion', sanitizeOps: false, sanitizeResources: false }, async () => {
  const out = await Deno.makeTempDir({ prefix: 'edge-ssr-rpc-' })
  const omnishell = fileURLToPath(new URL('../../omnishell/', import.meta.url))
  const mecha = fileURLToPath(new URL('../../../libraries/mecha/', import.meta.url))
  await Deno.mkdir(path.join(out, 'src'))
  await Deno.mkdir(path.join(out, 'public/shell'), { recursive: true })
  await Deno.writeTextFile(path.join(out, 'public/shell/shell.json'), JSON.stringify({ routes: [], tables: [], schema: {} }))
  await Deno.writeTextFile(path.join(out, 'public/_headers'), "/\n  Content-Security-Policy: script-src 'self'\n")
  await Deno.writeTextFile(path.join(out, 'wrangler.jsonc'), JSON.stringify({ assets: { directory: './public' } }))
  await writeEdgeSsr(out, omnishell, mecha, 'stream', 'https://stream.example', [])
  const generated = await Deno.readTextFile(path.join(out, 'src/database.ts'))
  const cluster = generated.slice(generated.indexOf('export class Cluster'), generated.indexOf('\nexport default'))
  await Deno.writeTextFile(path.join(out, 'database.ts'), `
import { DurableObject,RpcTarget } from 'cloudflare:workers'
class PublicSnapshotCapacity extends Error {}
class DataDirectoryLoading extends Error {}
class SnapshotReader extends RpcTarget {
  constructor(snapshot,done){super();this.snapshot=snapshot;this.done=done}
  read(path){return this.snapshot.read(path)}
  [Symbol.dispose](){this.snapshot.disposed();this.done()}
}
class Base extends DurableObject {
  active=0; reads=0; disposed=0;
  async readPublic(use){
    this.active++;let active=true;
    try{return await use({revision:'revision',read:async path=>{
      if(!active)throw new Error('snapshot was released before the nested read');
      this.reads++;return [path];
    },disposed:()=>{this.disposed++}})}finally{active=false;this.active--}
  }
  state(){return {active:this.active,reads:this.reads,disposed:this.disposed}}
}
${cluster}
export default {async fetch(request,env){
  const cluster=env.CLUSTER.get(env.CLUSTER.idFromName('database'));
  if(new URL(request.url).pathname==='/state')return Response.json(await cluster.state());
  const response=await cluster.render(request,env.RENDERER.get(env.RENDERER.idFromName('renderer')));
  if(new URL(request.url).searchParams.has('fail')){
    try{await response.text();return Response.json({unexpected:'complete failed stream'})}
    catch(error){return Response.json({error:String(error)},{status:502})}
  }
  return response;
}}
`)
  await Deno.writeTextFile(path.join(out, 'renderer.ts'), `
import {renderObject} from '${omnishell}server/render-object.ts'
export class Renderer extends renderObject(async(request,reader,stream)=>{
  stream?.onHead?.({status:200,gone:false});
  stream?.onChunk?.('<html>head');
  await new Promise(resolve=>setTimeout(resolve,30));
  await reader.read('/first');
  if(new URL(request.url).searchParams.has('fail'))throw new Error('late renderer failure');
  stream?.onChunk?.('x'.repeat(200000));
  await new Promise(resolve=>setTimeout(resolve,30));
  await reader.read('/second');
  stream?.onChunk?.('tail</html>');
  return {status:200,html:'<html>head'+'x'.repeat(200000)+'tail</html>'};
},'version'){}
export default {fetch(){return new Response(null,{status:404})}}
`)
  const rendererConfig = path.join(out, 'renderer.json')
  await Deno.writeTextFile(rendererConfig, JSON.stringify({ name: 'stream-renderer', main: 'renderer.ts', compatibility_date: '2026-09-01', durable_objects: { bindings: [{ name: 'RENDERER', class_name: 'Renderer' }] }, migrations: [{ tag: 'v1', new_sqlite_classes: ['Renderer'] }] }))
  const config = path.join(out, 'database.json')
  await Deno.writeTextFile(config, JSON.stringify({ name: 'stream-database', main: 'database.ts', compatibility_date: '2026-09-01', durable_objects: { bindings: [{ name: 'CLUSTER', class_name: 'Cluster' }, { name: 'RENDERER', class_name: 'Renderer', script_name: 'stream-renderer' }] }, migrations: [{ tag: 'v1', new_sqlite_classes: ['Cluster'] }] }))
  const worker = await startWorker(new URL(`file://${config}`), path.join(out, 'state'), [new URL(`file://${rendererConfig}`)])
  try {
    const at = (pathname = '/', init?: RequestInit) => fetch(worker.origin + pathname, { signal: AbortSignal.timeout(10_000), ...init })
    const settled = async (reads: number | undefined, disposed: number) => {
      for (let i = 0; i < 100; i++) {
        const state = await (await at('/state')).json() as { active: number; reads: number; disposed: number }
        if (state.active === 0 && state.disposed === disposed) {
          if (reads !== undefined) assert.equal(state.reads, reads)
          return
        }
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      throw new Error('render RPC did not release its snapshot reader')
    }
    const first = await at()
    assert.equal(first.status, 200)
    const body = await first.text()
    assert.equal(body.length, 200021)
    assert.equal(body, '<html>head' + 'x'.repeat(200000) + 'tail</html>')
    await settled(2, 1)
    const head = await at('/', { method: 'HEAD' })
    assert.equal(head.status, 200)
    assert.equal(await head.text(), '')
    await settled(4, 2)
    const unchanged = await at('/', { headers: { 'if-none-match': first.headers.get('etag')! } })
    assert.equal(unchanged.status, 304)
    await settled(6, 3)
    const failed = await at('/?fail')
    assert.equal(failed.status, 502)
    assert.match((await failed.json() as { error: string }).error, /late renderer failure|disconnected prematurely/)
    await settled(7, 4)
    const canceled = await at()
    const reader = canceled.body!.getReader()
    assert.ok((await reader.read()).value?.length)
    await reader.cancel()
    await settled(undefined, 5)
  } finally {
    await worker.stop()
    await Deno.remove(out, { recursive: true })
  }
})
