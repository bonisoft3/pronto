type Options = {
  config: string
  name: string
  previous: string | null
  wrangler: (args: string[]) => Promise<string>
}

export async function requireLocalCluster({ config, name, previous, wrangler }: Options): Promise<void> {
  if (previous === null) return
  const version: unknown = JSON.parse(await wrangler(['versions', 'view', previous, '--config', config, '--json']))
  if (!version || typeof version !== 'object' || !('resources' in version) || !version.resources || typeof version.resources !== 'object' || !('bindings' in version.resources) || !Array.isArray(version.resources.bindings)) {
    throw new Error(`Invalid version bindings for ${name}`)
  }
  const bindings: unknown[] = version.resources.bindings
  if (!bindings.every(binding => binding && typeof binding === 'object' && 'name' in binding && typeof binding.name === 'string' && 'type' in binding && typeof binding.type === 'string')) {
    throw new Error(`Invalid version bindings for ${name}`)
  }
  const cluster = bindings.find(binding => (binding as { name: string }).name === 'CLUSTER') as Record<string, unknown> | undefined
  if (!cluster) return
  if (cluster.type !== 'durable_object_namespace' || typeof cluster.class_name !== 'string' || (cluster.script_name !== undefined && typeof cluster.script_name !== 'string') || (cluster.environment !== undefined && typeof cluster.environment !== 'string')) {
    throw new Error(`Invalid CLUSTER binding for ${name}`)
  }
  if (cluster.class_name !== 'Cluster' || (cluster.script_name && cluster.script_name !== name) || cluster.environment) {
    throw new Error(`Existing CLUSTER binding for ${name} points to another Durable Object; migrate its data before publishing`)
  }
}
