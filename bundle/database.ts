import type { Extension } from '@electric-sql/pglite'
import { createDatabase } from 'mecha-browser/src/database.ts'

/** Where PGlite's files sit beside the page: same-origin addresses, named by their content. */
export interface DatabaseAssets {
  wasm: string
  data: string
  initdb: string
  icu: string
  ivm: string
  unaccent: string
}

const load = async (href: string): Promise<ArrayBuffer> => {
  const res = await fetch(href)
  if (!res.ok) throw new Error(`${href}: ${res.status}`)
  return res.arrayBuffer()
}

// An extension ships as a gzipped tar, which PGlite's own loader gunzips and an extension handed over
// as a blob must arrive already gunzipped.
const gunzip = async (bytes: ArrayBuffer): Promise<ArrayBuffer> =>
  new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer()

// An extension's archive handed over from the page, which serves no file the
// package would fetch it from.
const inline = (name: string, archive: ArrayBuffer): Extension => ({
  name,
  setup: async (_db, options) => ({
    emscriptenOpts: { ...options, preRun: [...options.preRun, (module: { pg_extensions: Record<string, Promise<Blob>> }) => {
      module.pg_extensions[name] = Promise.resolve(new Blob([archive]))
    }] },
  }),
})

export async function createPageDatabase(assets: DatabaseAssets) {
  const [wasm, data, initdb, icu, ivm, unaccent] = await Promise.all([load(assets.wasm), load(assets.data), load(assets.initdb), load(assets.icu), load(assets.ivm).then(gunzip), load(assets.unaccent).then(gunzip)])
  return createDatabase({
    pgliteWasmModule: await WebAssembly.compile(wasm),
    initdbWasmModule: await WebAssembly.compile(initdb),
    fsBundle: new Blob([data]),
    extensions: { pg_ivm: inline('pg_ivm', ivm), unaccent: inline('unaccent', unaccent) },
    icuDataDir: new Blob([icu]),
  })
}
