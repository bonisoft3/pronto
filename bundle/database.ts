import { decodeBase64 } from '@std/encoding/base64'
import type { Extension } from '@electric-sql/pglite'
import { createDatabase } from 'mecha-browser/src/database.ts'

export interface DatabaseAssets {
  wasm: string
  data: string
  initdb: string
  icu: string
  ivm: string
  unaccent: string
}

const inflate = (b64: string): Promise<ArrayBuffer> =>
  new Response(new Blob([decodeBase64(b64)]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer()

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
  const [wasm, data, initdb, ivm, unaccent] = await Promise.all([assets.wasm, assets.data, assets.initdb, assets.ivm, assets.unaccent].map(inflate))
  return createDatabase({
    pgliteWasmModule: await WebAssembly.compile(wasm),
    initdbWasmModule: await WebAssembly.compile(initdb),
    fsBundle: new Blob([data]),
    extensions: { pg_ivm: inline('pg_ivm', ivm), unaccent: inline('unaccent', unaccent) },
    icuDataDir: new Blob([decodeBase64(assets.icu)]),
  })
}
