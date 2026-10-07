import { decodeBase64 } from '@std/encoding/base64'
import { createDatabase } from 'mecha-browser/src/database.ts'

export interface DatabaseAssets {
  wasm: string
  data: string
  initdb: string
  icu: string
}

const inflate = (b64: string): Promise<ArrayBuffer> =>
  new Response(new Blob([decodeBase64(b64)]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer()

export async function createPageDatabase(assets: DatabaseAssets) {
  const [wasm, data, initdb] = await Promise.all([inflate(assets.wasm), inflate(assets.data), inflate(assets.initdb)])
  return createDatabase({
    pgliteWasmModule: await WebAssembly.compile(wasm),
    initdbWasmModule: await WebAssembly.compile(initdb),
    fsBundle: new Blob([data]),
    icuDataDir: new Blob([decodeBase64(assets.icu)]),
  })
}
