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
  const cluster = generated.slice(generated.indexOf('export class Cluster'), generated.indexOf('\nexport default')).replace('}, 30_000)', '}, 1000)')
  await Deno.writeTextFile(path.join(out, 'database.ts'), `
import { DurableObject,RpcTarget } from 'cloudflare:workers'
class PublicSnapshotCapacity extends Error {}
class DataDirectoryLoading extends Error {}
${generated.slice(generated.indexOf('class SnapshotReader'), generated.indexOf('const Base = edgeObject(')).replace('this.done = done', 'this.done = () => { snapshot.disposed(); done() }').replace('[Symbol.dispose]()', 'isRetained() { return this.snapshot !== null }\n  [Symbol.dispose]()')}
class Base extends DurableObject {
  active=0; reads=0; disposed=0;
  async readPublic(use){
    this.active++;let active=true,reported=false;
    try{return await use({revision:'revision',read:async path=>{
      if(!active)throw new Error('snapshot was released before the nested read');
      this.reads++;return [path];
    },readMany:async paths=>{if(!active)throw new Error('snapshot released before batch read');this.reads+=paths.length;return paths.map(path=>[path])},disposed:()=>{if(!reported){reported=true;this.disposed++}}})}finally{active=false;this.active--}
  }
  state(){return {active:this.active,reads:this.reads,disposed:this.disposed}}
}
${cluster}
export default {async fetch(request,env){
  const cluster=env.CLUSTER.get(env.CLUSTER.idFromName('database'));
  if(new URL(request.url).pathname==='/state')return Response.json(await cluster.state());
  if(new URL(request.url).pathname==='/resume')return Response.json(await env.RENDERER.get(env.RENDERER.idFromName('renderer')).resumeHung());
  if(new URL(request.url).pathname==='/retained')return Response.json(await env.RENDERER.get(env.RENDERER.idFromName(new URL(request.url).searchParams.get('object')??'renderer')).retainedState(Number(new URL(request.url).searchParams.get('index')??0)));
  const objectName=new URL(request.url).searchParams.get('object')??'renderer';
  const response=await cluster.render(request,env.RENDERER.get(env.RENDERER.idFromName(objectName)));
  if(new URL(request.url).searchParams.has('fail')){
    try{await response.text();return Response.json({unexpected:'complete failed stream'})}
    catch(error){return Response.json({error:String(error)},{status:502})}
  }
  return response;
}}
`)
  await Deno.writeTextFile(path.join(out, 'renderer.ts'), `
import {renderObject} from '${omnishell}server/render-object.ts'
const heldReaders=[];
let resumeOld; let mutations=0; let queuedRan=0; globalThis.document='baseline';
export class Renderer extends renderObject(async(request,reader,stream)=>{
  if(new URL(request.url).searchParams.has('queued'))queuedRan++;
  if(new URL(request.url).searchParams.has('poison')){Object.defineProperty(globalThis,'document',{value:'poisoned',configurable:false,writable:false});await new Promise(()=>{});}
  if(new URL(request.url).searchParams.has('hangbefore'))await new Promise(()=>{});
  stream?.onHead?.({status:200,gone:false});
  stream?.onChunk?.('<html>head');
  await new Promise(resolve=>setTimeout(resolve,30));
  await reader.read('/first');
  if(new URL(request.url).searchParams.has('hang')){globalThis.document='hung';await new Promise(resolve=>resumeOld=resolve);mutations++;}
  if(new URL(request.url).searchParams.has('healthyhold')&&globalThis.document!=='baseline')throw new Error('ambient document not restored');
  if(new URL(request.url).searchParams.has('healthyhold'))await new Promise(resolve=>setTimeout(resolve,100));
  if(new URL(request.url).searchParams.has('fail'))throw new Error('late renderer failure');
  stream?.onChunk?.('x'.repeat(200000));
  await new Promise(resolve=>setTimeout(resolve,30));
  const batch=await reader.readMany(['/second','/third']);
  if(JSON.stringify(batch)!==JSON.stringify([['/second'],['/third']]))throw new Error('batched snapshot rows differ');
  stream?.onChunk?.('tail</html>');
  return {status:200,html:'<html>head'+'x'.repeat(200000)+'tail</html>'};
},'version',300){
  async resumeHung(){if(!resumeOld)throw new Error('missing old continuation');resumeOld();await new Promise(resolve=>setTimeout(resolve,30));return {mutations,queuedRan,ambient:globalThis.document}}
  async retainedState(index){const reader=heldReaders[index];let error;try{await reader.read('/late')}catch(e){error=String(e)}return {retained:await reader.isRetained(),error}}
  render(request,revision,reader){
    if(new URL(request.url).searchParams.has('lease')){heldReaders.push(reader.dup());return new Promise(()=>{});}
    if(new URL(request.url).searchParams.has('hold'))heldReaders.push(reader.dup());
    return super.render(request,revision,reader);
  }
}
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
    await settled(3, 1)
    const head = await at('/', { method: 'HEAD' })
    assert.equal(head.status, 200)
    assert.equal(await head.text(), '')
    await settled(6, 2)
    const unchanged = await at('/', { headers: { 'if-none-match': first.headers.get('etag')! } })
    assert.equal(unchanged.status, 304)
    await settled(9, 3)
    const failed = await at('/?fail')
    assert.equal(failed.status, 502)
    assert.match((await failed.json() as { error: string }).error, /late renderer failure|disconnected prematurely/)
    await settled(10, 4)
    const canceled = await at()
    const reader = canceled.body!.getReader()
    assert.ok((await reader.read()).value?.length)
    await reader.cancel()
    await settled(undefined, 5)
    const held = await at('/?hold')
    assert.equal(held.status, 200)
    assert.equal((await held.text()).length, 200021)
    await settled(undefined, 6)
    const retained = await (await at('/retained')).json() as { retained: boolean; error: string }
    assert.equal(retained.retained, false)
    assert.match(retained.error, /snapshot is closed/)
    const hung = await at('/?hang')
    assert.equal(hung.status, 200)
    const queued = await Promise.all([at('/?queued&object=other1'), at('/?queued&object=other2')])
    assert.deepEqual(queued.map(response => response.status), [503, 503])
    await settled(undefined, 9)
    const healthy = await at('/?healthyhold')
    assert.equal(healthy.status, 200)
    const resumed = await at('/resume')
    assert.equal(resumed.status, 200)
    assert.deepEqual(await resumed.json(), { mutations: 0, queuedRan: 0, ambient: 'baseline' })
    assert.equal((await healthy.text()).length, 200021)
    await settled(undefined, 10)
    const poisoned = await at('/?poison')
    assert.equal(poisoned.status, 500)
    const refused = await at('/?queued&object=after-poison')
    assert.equal(refused.status, 503)
    await settled(undefined, 12)
    const expired = await at('/?lease&object=lease')
    assert.equal(expired.status, 500)
    await settled(undefined, 13)
    const abandoned = await (await at('/retained?object=lease&index=1')).json() as { retained: boolean; error: string }
    assert.equal(abandoned.retained, false)
    assert.match(abandoned.error, /snapshot is closed/)
  } finally {
    await worker.stop()
    await Deno.remove(out, { recursive: true })
  }
})
