import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { computationPackages } from './compute.ts'
import { writeEdgeCompute } from './edge-compute.ts'
import { table as types } from '../../../libraries/mecha/services/compute/portable-fixture.ts'
import { startWorker } from '../../../libraries/mecha/packages/pglite-workerd/wrangler-dev.ts'

Deno.test('private Cloudflare computation Workers preserve exact captures across concurrency and restart', async () => {
  const root = await Deno.makeTempDir({ prefix: 'edge-compute-integration-' })
  const mecha = new URL('../../../libraries/mecha/', import.meta.url).pathname
  const omnishell = new URL('../../omnishell/', import.meta.url).pathname
  await Deno.mkdir(`${root}/app/.pronto`, { recursive: true })
  await Deno.writeTextFile(`${root}/app/program.js`, `export const reads=['source'];
export const queries={rows:'SELECT id, amount::VARCHAR AS value FROM source ORDER BY id'};
export const queryStages={rows:{stages:[{name:'__duckstream_rows_0',sql:'SELECT id, amount::VARCHAR AS value FROM source'}],sql:'SELECT * FROM __duckstream_rows_0 ORDER BY id'}};
export const plan=()=>[];
export const finish=inputs=>({sink:inputs.rows});`)
  await Deno.writeTextFile(`${root}/app/typed.js`, `export const reads=['source'];
export const queries={rows:"SELECT id,amount::VARCHAR AS value,from_hex('00ff') AS payload FROM source ORDER BY id"};
export const plan=()=>[];
export const finish=inputs=>({sink:inputs.rows.map(row=>row.id==='missing'?{id:row.id,value:row.value}:row.id==='extra'?{...row,extra:1}:row.id==='null'?{...row,value:null}:row)});`)
  await Deno.writeTextFile(`${root}/app/bad.js`, `export const reads=['source']; export const queries={rows:'SELECT id FROM source WHERE false'}; export const plan=()=>[]; export const finish=inputs=>({sink:inputs.rows});`)
  await Deno.writeTextFile(`${root}/app/steps.js`, `export async function step(host,state){
    const rows=await host.query(\"SELECT value->>'id' AS id,value->>'value' AS value FROM duckstream_private.result_rows ORDER BY sequence\");
    return {checkpoint:1,writes:{sink:rows.map(row=>({...row,value:state===null?row.value:String(BigInt(row.value)+1n)}))},done:state!==null};
  }`)
  const fields = [{ name: 'id', type: 'string', required: true }, { name: 'value', type: 'int64', required: true }, { name: 'payload', type: 'bytes' }]
  await Deno.writeTextFile(`${root}/app/.pronto/cluster.json`, JSON.stringify({ computations: [
    { name: 'copy', file: 'program.js', wasm: [], to: ['sink'] },
    { name: 'paged', file: 'program.js', steps: 'steps.js', wasm: [], to: ['sink'] },
    ...['typed', 'bad'].map(name=>({ name, file: `${name}.js`, wasm: [], to: ['sink'], types, queryTypes: {rows:fields}, sinkTypes: {sink:fields} })),
  ] }))
  const packages = await computationPackages(`${root}/app`, mecha)
  const config = await writeEdgeCompute(`${root}/release`, mecha, omnishell, packages, 'integration')
  const worker = await startWorker(pathToFileURL(`${root}/release/compute/execution/wrangler.jsonc`), `${root}/state`, [pathToFileURL(`${root}/release/compute/queries/wrangler.jsonc`)])
  const version = config!.definitions[0].version
  const typedCapture = (id: string, name='typed') => ({ ...capture(id, '9007199254740993'), name, version: config!.definitions.find(d=>d.name===name)!.version })
  const capture = (id: string, amount: string) => ({ id, name: 'copy', version, revision: 1, tables: { source: {
    columns: [{ name: 'id', type: 'text' }, { name: 'amount', type: 'bigint' }], rows: [{ id, amount }],
  } } })
  const post = (body: unknown) => fetch(`${worker.origin}/execute`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const verify = async (id: string, amount: string) => {
    const response = await post(capture(id, amount))
    assert.equal(response.status, 200, await response.clone().text())
    assert.deepEqual(await response.json(), { id, name: 'copy', version, revision: 1, sinks: { sink: [{ id, value: amount }] } })
  }
  try {
    await Promise.all([verify('a', '9007199254740993'), verify('b', '9223372036854775807')])
    const batch = capture('batch', '1')
    batch.tables.source.rows = Array.from({ length: 101 }, (_, i) => ({ id: String(i).padStart(3, '0'), amount: String(i) }))
    const batched = await post(batch)
    assert.equal(batched.status, 200, await batched.clone().text())
    assert.deepEqual((await batched.json()).sinks.sink, batch.tables.source.rows.map(({ id, amount }) => ({ id, value: amount })))
    const typed = await post(typedCapture('typed-ok'))
    assert.equal(typed.status, 200, await typed.clone().text())
    assert.deepEqual((await typed.json()).sinks.sink, [{ id: 'typed-ok', value: '9007199254740993', payload: '\\x00ff' }])
    for (const [id, message] of [['missing','columns differ'], ['extra','columns differ'], ['null','value is required']]) {
      const rejected = await post(typedCapture(id))
      assert.equal(rejected.status, 500)
      assert.match(await rejected.text(), new RegExp(message))
    }
    const nullable = typedCapture('query-null')
    ;(nullable.tables.source.rows[0] as {amount: string | null}).amount = null
    const required = await post(nullable)
    assert.equal(required.status, 500)
    assert.match(await required.text(), /value is required/)
    const badColumns = await post(typedCapture('bad-columns', 'bad'))
    assert.equal(badColumns.status, 500)
    assert.match(await badColumns.text(), /columns differ/)
    const wrongVersion = await post({ ...capture('bad', '1'), version: 'stale' })
    assert.equal(wrongVersion.status, 500)
    assert.match(await wrongVersion.text(), /artifact version differs/)
    const invalid = capture('bad', '1')
    invalid.tables.source.rows[0].amount = 'not-an-integer'
    const [failed] = await Promise.all([post(invalid), verify('after-failure', '2')])
    assert.equal(failed.status, 500)
    assert.match(await failed.text(), /not-an-integer/)
    await worker.restart()
    await verify('a', '9007199254740993')
    const identity = { id: 'paged-one', name: 'paged', version: config!.definitions.find(d=>d.name==='paged')!.version, revision: 1 }
    const pageCapture = { generation: 'fixture', identity }
    const request = async (action: string, extra: Record<string, unknown> = {}) => {
      const response = await fetch(`${worker.origin}/paged`, {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({capture:pageCapture,action,...extra})})
      assert.equal(response.status, 200, await response.clone().text())
      return await response.json()
    }
    const source = capture('paged-value', '9007199254740993').tables.source
    await request('initialize', {manifest:{...identity,tables:{source:{columns:source.columns,rows:1}}}})
    const chunk = {...identity,table:'source',after:0,next:1,done:true,rows:source.rows}
    await request('append',{chunk})
    await request('append',{chunk})
    await worker.restart()
    assert.equal((await request('status')).sources[0].position,1)
    assert.equal((await request('materialize',{query:'rows'})).done,false)
    await worker.restart()
    assert.deepEqual((await request('status')).queries,[])
    assert.equal((await request('materialize',{query:'rows'})).done,true)
    assert.equal((await request('step')).revision,1)
    await worker.restart()
    assert.equal((await request('status')).execution.revision,1)
    const completed=await request('step')
    assert.equal(completed.done,true)
    assert.equal(completed.revision,2)
    await worker.restart()
    const output=await request('output',{sink:'sink',after:0})
    assert.equal(output.done,true)
    assert.deepEqual(output.rows,[{id:'paged-value',value:'9007199254740994'}])
    await request('cleanup')
  } finally { await worker.stop() }
})
