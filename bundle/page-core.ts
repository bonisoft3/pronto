// The single-file page's boot, shared by its two entries: the payload read
// from the document, the app's files served from it through a fetch shim, and
// the shell started behind the same shim. page.ts boots mecha's browser
// platform first, for an app with server entities; page-static.ts boots none,
// so its module carries neither the cluster nor PGlite. `omnishell/` resolves
// through the map the bundler writes from the root it is given.
// @ts-ignore untyped interpreter module
import { createShell } from 'omnishell/shell.js'
// @ts-ignore untyped interpreter module
import { ensureSes } from 'omnishell/jessie.js'
import { installSes } from 'pronto-bundle-ses'
// The data plane, which every first screen reads through: the shell imports it
// when it starts, and imported here it rides in this module instead of a chunk
// fetched after it.
// @ts-ignore untyped interpreter module
import 'omnishell/data-sync.js'

export interface Payload {
  files: Record<string, string>
  /** Absent for an app with no server entity, which boots no cluster. */
  cluster?: unknown
}

/** What answers the cluster's addresses (/crud, /auth, /electric) once it has booted. */
export type Handle = (req: Request) => Promise<Response>

// JSON whose `<` the bundler wrote as <, so the document's text is the payload's.
export const payload: Payload = JSON.parse(document.getElementById('pronto-payload')!.textContent!)

const MIME: Record<string, string> = {
  html: 'text/html', css: 'text/css', js: 'text/javascript', json: 'application/json', yaml: 'text/yaml', md: 'text/markdown',
}
const mime = (p: string) => MIME[p.split('.').pop() ?? ''] ?? 'text/plain'

export function startPage(bootCluster?: () => Promise<Handle>) {
  let handle: Handle | null = null
  const origFetch = globalThis.fetch.bind(globalThis)
  // The shell asks for its files from the root, its <base> being /shell/ under
  // any prefix, and the door's routes are root-absolute at every target.
  const served = new Map(Object.entries(payload.files).map(([k, text]) => [`/${k}`, text]))

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const req = input instanceof Request ? input : null
    const url = new URL(req ? req.url : String(input), location.href)
    if (url.origin === location.origin) {
      const path = url.pathname
      const text = served.get(path)
      if (text !== undefined) return new Response(text, { headers: { 'content-type': mime(path) } })
      if (handle && /^\/(crud|auth|electric)(\/|$)/.test(path)) {
        const method = req?.method ?? init?.method ?? 'GET'
        const headers = new Headers(req?.headers ?? init?.headers)
        const body = method === 'GET' || method === 'HEAD' ? undefined : req ? await req.arrayBuffer() : (init?.body as BodyInit)
        const signal = req?.signal ?? init?.signal ?? undefined
        return handle(new Request(`http://cluster.local${path}${url.search}`, { method, headers, body, signal }))
      }
    }
    return origFetch(input as RequestInfo, init)
  }

  ;(async () => {
    if (bootCluster) handle = await bootCluster()
    // The shim answers every file a preload would ask the network for.
    await ensureSes(installSes)
    createShell({ config: './shell.json', mount: document.getElementById('app'), preload: false })
  })().catch((e) => {
    document.body.textContent = `boot failed: ${e instanceof Error ? e.message : String(e)}`
    throw e
  })
}
