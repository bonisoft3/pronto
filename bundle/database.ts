import { createDatabase } from 'mecha-browser/src/database.ts'

/** Where PGlite's files sit beside the page: same-origin addresses, named by their content. */
export interface DatabaseAssets {
  wasm: string
  data: string
  initdb: string
  icu: string
}

const load = async (href: string): Promise<ArrayBuffer> => {
  const res = await fetch(href)
  if (!res.ok) throw new Error(`${href}: ${res.status}`)
  return res.arrayBuffer()
}

export async function createPageDatabase(assets: DatabaseAssets) {
  const [wasm, data, initdb, icu] = await Promise.all([load(assets.wasm), load(assets.data), load(assets.initdb), load(assets.icu)])
  return createDatabase({
    pgliteWasmModule: await WebAssembly.compile(wasm),
    initdbWasmModule: await WebAssembly.compile(initdb),
    fsBundle: new Blob([data]),
    icuDataDir: new Blob([icu]),
  })
}
