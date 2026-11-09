import assert from 'node:assert/strict'
import { computationDefinitions, computationPackages, type PackagedComputation } from './compute.ts'
import { writeEdgeCompute } from './edge-compute.ts'

Deno.test('edge computations package private immutable Workers, static WASM and no database authority', async () => {
  const temporary = await Deno.makeTempDir({ prefix: 'edge-compute-' })
  const mecha = new URL('../../../libraries/mecha/', import.meta.url).pathname
  const omnishell = new URL('../../omnishell/', import.meta.url).pathname
  try {
    await Deno.mkdir(`${temporary}/app/.pronto`, { recursive: true })
    await Deno.writeTextFile(`${temporary}/app/program.js`, `export const reads=['source']; export const queries={source:'SELECT * FROM source'}; export const plan=()=>[]; export const finish=inputs=>({sink:inputs.source});`)
    await Deno.writeTextFile(`${temporary}/app/steps.ts`, `export const step=()=>({checkpoint:null,writes:{sink:[]},done:true});`)
    await Deno.writeFile(`${temporary}/app/shared.wasm`, new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]))
    await Deno.writeTextFile(`${temporary}/app/.pronto/cluster.json`, JSON.stringify({ computations: ['copy', 'second'].map(name => ({ name, file: 'program.js', ...(name === 'second' ? { steps: 'steps.ts' } : {}), wasm: ['shared.wasm'], to: ['sink'], ...(name === 'copy' ? { sinkWrites: { sink: 'upsert' } } : {}) })) }))
    const programs = await computationPackages(`${temporary}/app`, mecha)
    const output = await writeEdgeCompute(`${temporary}/release`, mecha, omnishell, programs, 'fixture')
    assert.equal(output?.services[0].binding, 'COMPUTE')
    assert.deepEqual(output?.paged, ['second'])
    assert.match(output!.services[0].service, /^fixture-compute-[a-f0-9]{12}$/)
    assert.notEqual(output!.definitions[0].version, programs[0].version)
    const directory = `${temporary}/release/compute`
    const query = JSON.parse(await Deno.readTextFile(`${directory}/queries/wrangler.jsonc`))
    const execution = JSON.parse(await Deno.readTextFile(`${directory}/execution/wrangler.jsonc`))
    assert.equal(query.workers_dev, false)
    assert.equal(execution.workers_dev, false)
    assert.equal(query.preview_urls, false)
    assert.equal(execution.preview_urls, false)
    assert.equal(execution.services[0].service, query.name)
    assert.equal(query.containers, undefined)
    assert.equal(execution.containers, undefined)
    const source = await Deno.readTextFile(`${directory}/execution/worker.js`)
    assert.match(source, /shared\.wasm/)
    assert.doesNotMatch(JSON.stringify(output) + source, /DATABASE_URL|JWT_SECRET|IMPORT_TOKEN/)
    const files = []
    for await (const file of Deno.readDir(`${directory}/execution/wasm`)) files.push(file.name)
    assert.deepEqual(files, ['shared.wasm'])
    const declarations = JSON.parse(await Deno.readTextFile(`${directory}/queries/programs.json`))
    assert.equal(declarations[0].version, output!.definitions[0].version)
    assert.equal(declarations[0].spec.file, 'copy.js')
    assert.deepEqual(output!.definitions[0].sinkWrites, { sink: 'upsert' })
    assert.deepEqual(declarations[0].spec.sinkWrites, { sink: 'upsert' })
    assert.equal(output!.definitions[1].sinkWrites, undefined)
    assert.equal(declarations[0].paged, false)
    assert.equal(declarations[1].paged, true)
    const repeated = await writeEdgeCompute(`${temporary}/repeat`, mecha, omnishell, programs, 'fixture')
    assert.equal(repeated!.services[0].service, output!.services[0].service)
    await Deno.writeTextFile(`${temporary}/app/program.js`, `export const reads=['source']; export const queries={source:'SELECT * FROM source'}; export const plan=()=>[]; export const finish=inputs=>({sink:inputs.source.map(row=>row)});`)
    // A changed emitter must not overwrite a companion even when admission versions stay equal.
    const changed = (await computationPackages(`${temporary}/app`, mecha)).map((p, i) => ({ ...p, version: programs[i].version }))
    const emitted = await writeEdgeCompute(`${temporary}/emitted`, mecha, omnishell, changed, 'fixture')
    assert.deepEqual(emitted!.definitions, output!.definitions)
    assert.notEqual(emitted!.services[0].service, output!.services[0].service)
    await Deno.writeTextFile(`${temporary}/app/steps.ts`, `export const step=()=>({checkpoint:1,writes:{sink:[]},done:true});`)
    const stepsChanged = await writeEdgeCompute(`${temporary}/changed-steps`, mecha, omnishell, programs, 'fixture')
    assert.notEqual(stepsChanged!.definitions[1].version, output!.definitions[1].version)
    assert.notEqual(stepsChanged!.services[0].service, output!.services[0].service)
    await Deno.mkdir(`${temporary}/conflict`)
    await Deno.writeFile(`${temporary}/conflict/shared.wasm`, new Uint8Array([1]))
    const conflict = { ...programs[0], spec: { ...programs[0].spec, wasm: [`${temporary}/conflict/shared.wasm`] } }
    await assert.rejects(() => writeEdgeCompute(`${temporary}/bad`, mecha, omnishell, [...programs, conflict], 'fixture'), /WASM artifact name collision/)
  } finally { await Deno.remove(temporary, { recursive: true }) }
})

Deno.test('sink publication modes survive computation definition packaging', () => {
  const program: PackagedComputation = {
    version: 'v1', reads: ['source'], queries: {}, compiled: {},
    spec: { name: 'history', file: 'program.js', to: ['history', 'current'], wasm: [], sinkWrites: { history: 'upsert', current: 'replace' } },
  }
  assert.deepEqual(computationDefinitions([program]), [{
    name: 'history', version: 'v1', reads: ['source'], to: ['history', 'current'], sinkWrites: { history: 'upsert', current: 'replace' },
  }])
})
