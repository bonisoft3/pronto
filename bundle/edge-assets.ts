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
