// The seal key at the edge (mecha's services/airlock/seal.ts): its private
// half is the dispatcher's secret, AIRLOCK_SEAL_KEY, the only Worker that opens
// a secret field, and its public half the object's, AIRLOCK_SEAL_PUBLIC, which
// the object publishes for the page to seal to. Like an effect's other
// secrets, a release never makes one: the publish's environment carries it,
// beside AIRLOCK_SEAL_KEY_PREVIOUS where it replaces another, or the deployed
// Workers already hold both halves. The repository's development key is the
// local stack's alone, so a release refuses it.

type SealOptions = {
  /** AIRLOCK_SEAL_KEY and AIRLOCK_SEAL_KEY_PREVIOUS as this publish's environment holds them. */
  given?: string
  previous?: string
  /** The repository's development key (mecha's services/airlock/dev-seal.key). */
  dev: string
  /** A key's id, its public half's thumbprint: one key however its text is spelled. */
  kidOf: (key: string) => Promise<string>
  /** The secrets the deployed dispatcher and object hold, none where neither is deployed. */
  held: () => Promise<{ dispatcher: string[]; object: string[] }>
  /** The public half the object publishes, `{kid, key}` as JSON. */
  publicOf: (key: string) => Promise<string>
}

/** The secrets to set, the dispatcher's and the object's; none where the
 * deployed pair is kept. */
export async function releaseSealKey(o: SealOptions): Promise<{ dispatcher: Record<string, string>; object: Record<string, string> } | undefined> {
  const key = o.given?.trim()
  const dev = await o.kidOf(o.dev)
  const given = [key, o.previous?.trim()].filter((k): k is string => !!k)
  if ((await Promise.all(given.map(o.kidOf))).includes(dev)) throw new Error('AIRLOCK_SEAL_KEY is the repository\'s development key, which only the local stack seals to: give this deployment a key of its own (mecha\'s services/airlock/seal-key.ts prints one)')
  if (!key) {
    const held = await o.held()
    const missing = [...(held.dispatcher.includes('AIRLOCK_SEAL_KEY') ? [] : ['the dispatcher\'s AIRLOCK_SEAL_KEY']), ...(held.object.includes('AIRLOCK_SEAL_PUBLIC') ? [] : ['the object\'s AIRLOCK_SEAL_PUBLIC'])]
    if (missing.length) throw new Error(`${missing.join(' and ')} is not deployed: set AIRLOCK_SEAL_KEY in this publish's environment, which a secret field is sealed to (mecha's services/airlock/seal-key.ts prints one)`)
    return undefined
  }
  return {
    dispatcher: { AIRLOCK_SEAL_KEY: key, ...(o.previous?.trim() ? { AIRLOCK_SEAL_KEY_PREVIOUS: o.previous.trim() } : {}) },
    object: { AIRLOCK_SEAL_PUBLIC: await o.publicOf(key) },
  }
}
