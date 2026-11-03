import * as path from 'node:path'

export interface StaticAsset { file: string; target: string }

// The edge has a file server. Preserve the terminal's modules and route files
// so visiting one screen does not download the entire app or a browser database.
export async function writeEdgeAssets(app: string, terminal: string, out: string, assets: StaticAsset[]) {
  const held = new Map<string, string>()
  for (const asset of assets) {
    const runtime = asset.target.startsWith('/omnishell/')
    if (!runtime && !asset.target.startsWith('/srv/')) continue
    const target = asset.target.slice(runtime ? 1 : '/srv/'.length)
    if (!target || target.split(/[\\/]/).some(part => part === '..' || part === '.')) {
      throw new Error(`invalid static asset target: ${asset.target}`)
    }
    held.set(target, runtime
      ? path.join(terminal, target.slice('omnishell/'.length))
      : path.resolve(app, asset.file))
  }
  if (!held.has('shell/index.html')) throw new Error('edge release has no shell/index.html')
  for (const [target, source] of held) {
    const destination = path.join(out, target)
    await Deno.mkdir(path.dirname(destination), { recursive: true })
    await Deno.copyFile(source, destination)
  }
  await Deno.copyFile(path.join(out, 'shell/index.html'), path.join(out, 'index.html'))
}

// A page carries its host-DOM hatches as files beside it: the shim serves text it
// inlined, and a hatch is a module the browser imports by its URL, with the
// files it fetches (sounds, fonts) next to it. These are the statics inside the
// directory of each hatch's src, by their address under the page's root.
export function hostDomAssets(assets: StaticAsset[], srcs: string[]): Map<string, string> {
  const dirs = srcs.map((src) => `/srv/${path.posix.dirname(src)}/`)
  const held = new Map<string, string>()
  for (const asset of assets) {
    if (!dirs.some((dir) => asset.target.startsWith(dir))) continue
    const target = asset.target.slice('/srv/'.length)
    if (target.split(/[\\/]/).some(part => part === '..' || part === '.')) throw new Error(`invalid static asset target: ${asset.target}`)
    held.set(target, asset.file)
  }
  return held
}
