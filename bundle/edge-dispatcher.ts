// The edge airlock's dispatcher Worker ([[../../../libraries/mecha/docs/archive/2026-11-06-edge-airlock-dispatcher]]):
// the queue's consumer that runs an app's effects apart from the Durable
// Object holding its database. Written after edge-ssr.ts, since the script
// holding the object (the release's own, or its separate database Worker) is
// the queue's producer and the dispatcher's way back.
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'

interface Config {
  name: string
  durable_objects?: { bindings: { name: string; class_name: string; script_name?: string }[] }
  queues?: { producers?: { binding: string; queue: string }[]; consumers?: unknown[] }
  r2_buckets?: { binding: string; bucket_name: string }[]
  vars?: Record<string, string>
  ai?: { binding: string }
}

/** What publish-edge.ts reads: the queue to create, the dispatcher's config,
 * and the secrets only the dispatcher holds: those the effects declare, each
 * required, and the keys their AI providers read, a group per provider any of
 * whose names serves. */
export interface AirlockRelease {
  queue: string
  deployment: 'airlock/wrangler.jsonc'
  secrets: string[]
  providers: string[][]
}

/** The dispatcher's Worker and queue, named after the script holding the
 * object, within Cloudflare's 63 characters, refused at build before anything
 * deploys. */
export function dispatcherName(host: string): string {
  const name = `${host}-airlock`
  if (name.length > 63) throw new Error(`the dispatcher's name ${name} is longer than Cloudflare's 63 characters: shorten the worker name`)
  return name
}

const read = async (file: string) => JSON.parse(await Deno.readTextFile(file)) as Config


export async function writeEdgeDispatcher(out: string, mecha: string, app: string, ai: unknown): Promise<AirlockRelease> {
  const main = path.join(out, 'wrangler.jsonc')
  let hostFile = main
  try {
    await Deno.stat(path.join(out, 'database.jsonc'))
    hostFile = path.join(out, 'database.jsonc')
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error
  }
  const host = await read(hostFile)
  const own = host.durable_objects?.bindings.find(b => b.name === 'CLUSTER' && !b.script_name)
  if (!own) throw new Error(`${hostFile} holds no Cluster object for the dispatcher to answer`)
  const queue = dispatcherName(host.name)
  host.queues = { ...host.queues, producers: [...(host.queues?.producers ?? []), { binding: 'AIRLOCK_QUEUE', queue }] }
  await Deno.writeTextFile(hostFile, JSON.stringify(host, null, 2) + '\n')

  const front = await read(main)
  const manifest = JSON.parse(await Deno.readTextFile(path.join(app, 'services/airlock/effects.json'))) as { effects: Record<string, { secrets?: string[]; credential?: { secret: string } }> }
  const secrets = [...new Set(Object.values(manifest.effects).flatMap(e => [...(e.secrets ?? []), ...(e.credential ? [e.credential.secret] : [])]))].sort()
  // The keys are tsbifrost's own resolution of the release's models on
  // cloudflare, global overrides and key aliases included.
  const { providerKeyGroups } = await import(String(pathToFileURL(path.join(mecha, 'services/airlock/ai-models.ts')))) as { providerKeyGroups: (config: unknown, target: 'cloudflare') => string[][] }
  const providers = providerKeyGroups(ai, 'cloudflare')
  const dispatch = path.relative(path.join(out, 'src'), path.join(mecha, 'packages/mecha-edge/src/dispatch.ts')).replaceAll('\\', '/')
  await Deno.writeTextFile(path.join(out, 'src/dispatcher.ts'), `// Written by pronto's edge.ts for ${host.name}: the airlock's dispatcher Worker.
import { edgeDispatcher } from '${dispatch.startsWith('.') ? dispatch : `./${dispatch}`}'
import effects from './effects.js'
export default edgeDispatcher({ effects${ai ? `, ai: ${JSON.stringify(ai)}` : ''} })
`)
  await Deno.mkdir(path.join(out, 'airlock'), { recursive: true })
  const blobUrl = front.vars?.BLOB_URL
  await Deno.writeTextFile(path.join(out, 'airlock/wrangler.jsonc'), JSON.stringify({
    name: queue,
    main: '../src/dispatcher.ts',
    compatibility_date: '2026-09-01',
    compatibility_flags: ['nodejs_compat'],
    workers_dev: false,
    preview_urls: false,
    observability: { enabled: true },
    ai: { binding: 'AI' },
    durable_objects: { bindings: [{ name: 'CLUSTER', class_name: 'Cluster', script_name: host.name }] },
    // The object's lease on a run is what dispatches it again, so the queue
    // never redelivers: a retried message would be a run the ledger never counted.
    queues: { consumers: [{ queue, max_retries: 0, max_batch_size: 1 }] },
    ...(front.r2_buckets?.length ? { r2_buckets: front.r2_buckets.filter(b => b.binding === 'BLOB_OBJECTS') } : {}),
    ...(blobUrl ? { vars: { BLOB_URL: blobUrl } } : {}),
  }, null, 2) + '\n')
  const release: AirlockRelease = { queue, deployment: 'airlock/wrangler.jsonc', secrets, providers }
  await Deno.writeTextFile(path.join(out, 'src/airlock.json'), JSON.stringify(release))
  return release
}
