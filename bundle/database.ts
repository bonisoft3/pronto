import { decodeBase64 } from '@std/encoding/base64'
import { pg_ivm } from '@electric-sql/pglite-pg_ivm'
import { createDatabase } from 'mecha-browser/src/database.ts'

export interface DatabaseAssets {
  wasm: string
  data: string
  initdb: string
  icu: string
  ivm: string
}

const inflate = (b64: string): Promise<ArrayBuffer> =>
  new Response(new Blob([decodeBase64(b64)]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer()

export async function createPageDatabase(assets: DatabaseAssets) {
  const [wasm, data, initdb, ivm] = await Promise.all([inflate(assets.wasm), inflate(assets.data), inflate(assets.initdb), inflate(assets.ivm)])
  return createDatabase({
    pgliteWasmModule: await WebAssembly.compile(wasm),
    initdbWasmModule: await WebAssembly.compile(initdb),
    fsBundle: new Blob([data]),
    extensions: { pg_ivm: { name: pg_ivm.name, setup: async (_db, options) => ({
      emscriptenOpts: { ...options, preRun: [...options.preRun, (module: { pg_extensions: Record<string, Promise<Blob>> }) => {
        module.pg_extensions.pg_ivm = Promise.resolve(new Blob([ivm]))
      }] },
    }) } },
    icuDataDir: new Blob([decodeBase64(assets.icu)]),
  })
}
