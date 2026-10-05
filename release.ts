export type Release = {
  format: 1
  id: string
  runtime: string
  contract: string
  screens: Record<string, { html: string; css: string }>
  assets: Record<string, string>
}

export type ReleaseContent = string | Uint8Array

async function digest(content: ReleaseContent): Promise<string> {
  const input = typeof content === "string" ? new TextEncoder().encode(content) : Uint8Array.from(content)
  const bytes = await crypto.subtle.digest("SHA-256", input)
  return [...new Uint8Array(bytes)].map((n) => n.toString(16).padStart(2, "0")).join("")
}

export async function releaseManifest(runtime: string, contents: ReadonlyMap<string, ReleaseContent>): Promise<Release> {
  const assets: Record<string, string> = {}
  for (const [path, content] of [...contents].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    assets[path] = await digest(content)
  }
  const screens: Release["screens"] = {}
  for (const path of Object.keys(assets)) {
    if (!/^shell\/screens\/[^/]+\.html$/.test(path)) continue
    const css = path.slice(0, -5) + ".css"
    if (assets[css] === undefined) throw new Error(`${path} has no matching stylesheet`)
    screens[path] = { html: assets[path], css: assets[css] }
  }
  const code = Object.entries(assets).filter(([path]) =>
    !/^shell\/screens\/[^/]+\.(?:html|css)$/.test(path)
  )
  const contract = await digest(JSON.stringify([runtime, code]))
  const id = await digest(JSON.stringify([contract, Object.entries(screens)]))
  return { format: 1, id, runtime, contract, screens, assets }
}
