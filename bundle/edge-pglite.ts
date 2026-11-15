// pglite-workerd's package for an edge release, from mecha's pinned sources.
// With a project, Cloud Build bakes it, so the machine releasing needs no
// Docker daemon (emscripten's link wants more memory than a laptop's VM
// spares), and the package rests in the project's bucket under a hash of
// those sources: the next release of any app on the same mecha downloads it
// instead. Without one, the local Docker bakes it as before.

import * as path from 'node:path'

// What bakes the package in Cloud Build: Docker's own CLI image, with its
// buildx plugin, against the Docker of the build's worker (release@gcp's).
const builder = 'docker:28.5.2-cli@sha256:625d9431a9f54c5a2bc90f24f0e1c3d55b1349fd857dd85035f98c2c9acbdd4d'

type Run = (cmd: string, args: string[], cwd?: string) => Promise<void>

async function output(cmd: string, args: string[]): Promise<{ ok: boolean; text: string }> {
  const r = await new Deno.Command(cmd, { args, stdin: 'null', stdout: 'piped', stderr: 'piped' }).output()
  return { ok: r.success, text: new TextDecoder().decode(r.stdout) + new TextDecoder().decode(r.stderr) }
}

/** The files bake reads, relative to `dir` and sorted: everything but git's. */
async function files(dir: string, rel = ''): Promise<string[]> {
  const found: string[] = []
  for await (const e of Deno.readDir(path.join(dir, rel))) {
    const p = rel ? `${rel}/${e.name}` : e.name
    if (e.name === '.git' || e.name === 'node_modules') continue
    if (e.isDirectory) found.push(...await files(dir, p))
    else if (e.isFile) found.push(p)
  }
  return found.sort()
}

/** A hash of the sources: each file's path and bytes, in order. */
export async function sourceKey(dir: string): Promise<string> {
  const enc = new TextEncoder()
  const parts: Uint8Array[] = []
  for (const f of await files(dir)) {
    const bytes = await Deno.readFile(path.join(dir, f))
    parts.push(enc.encode(`${f}\u0000${bytes.length}\u0000`), bytes)
  }
  const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) { all.set(p, at); at += p.length }
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', all))
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('')
}

/** The Cloud Build config that bakes the package and leaves it as `<key>.tgz`
 * in `location`. Cloud Build reads `$NAME` in a step as its own substitution;
 * `$$` is a `$`. */
export function buildConfig(key: string, location: string) {
  const script = [
    'set -eu',
    'docker buildx create --use --driver docker-container >/dev/null',
    'cd /workspace/.bayt',
    "docker buildx bake --allow=fs.read=/workspace --allow=fs.write=/workspace/out -f compose.yaml --set package.output=type=local,dest=/workspace/out package",
    'rm -rf /workspace/out/.bayt',
    `tar -czf /workspace/${key}.tgz -C /workspace/out .`,
  ].join('\n')
  return {
    steps: [{ name: builder, entrypoint: 'sh', args: ['-c', script.replaceAll('$', () => '$$')], env: ['SOURCE_DATE_EPOCH=0'] }],
    artifacts: { objects: { location, paths: [`/workspace/${key}.tgz`] } },
    // emscripten's link of postgres is what a small machine runs out of memory on.
    options: { machineType: 'E2_HIGHCPU_32', logging: 'CLOUD_LOGGING_ONLY' },
    timeout: '3600s',
  }
}

/** Puts the package at `dest`, which must not exist yet. */
export async function buildPglite(workerd: string, dest: string, project: string | undefined, run: Run, fail: (msg: string) => never) {
  if (!project) {
    // Bake reads the project's compose from its .bayt/, and a local export
    // adds to its destination, which is fresh here.
    await run('docker', ['buildx', 'bake', `--allow=fs.read=${workerd}`, `--allow=fs.write=${path.dirname(dest)}`, '-f', 'compose.yaml', '--set', `package.output=type=local,dest=${dest}`, 'package'], path.join(workerd, '.bayt'))
    await Deno.remove(path.join(dest, '.bayt'), { recursive: true })
    return
  }
  const key = await sourceKey(workerd)
  const bucket = `gs://${project}-pronto-edge`
  const location = `${bucket}/pglite-workerd/`
  const object = `${location}${key}.tgz`
  const work = await Deno.makeTempDir({ prefix: 'edge-pglite-' })
  try {
    if (!(await output('gcloud', ['storage', 'objects', 'describe', object, '--project', project])).ok) {
      if (!(await output('gcloud', ['storage', 'buckets', 'describe', bucket, '--project', project])).ok) {
        await run('gcloud', ['storage', 'buckets', 'create', bucket, '--project', project, '--uniform-bucket-level-access', '--public-access-prevention'])
      }
      const list = (await files(workerd)).join('\n')
      await Deno.writeTextFile(path.join(work, 'files'), list)
      await new Deno.Command('tar', { args: ['-czf', path.join(work, 'source.tgz'), '-C', workerd, '-T', path.join(work, 'files')], env: { COPYFILE_DISABLE: '1' } }).output()
        .then((r) => { if (!r.success) fail('tar of pglite-workerd failed') })
      await Deno.writeTextFile(path.join(work, 'cloudbuild.json'), JSON.stringify(buildConfig(key, location)))
      console.log(`edge: baking pglite-workerd ${key.slice(0, 12)} in Cloud Build (${project})`)
      const r = await output('gcloud', ['--quiet', 'builds', 'submit', path.join(work, 'source.tgz'), '--config', path.join(work, 'cloudbuild.json'), '--project', project])
      if (!r.ok) fail(`Cloud Build failed:\n${r.text.split('\n').slice(-40).join('\n')}`)
    } else {
      console.log(`edge: pglite-workerd ${key.slice(0, 12)} already baked in ${bucket}`)
    }
    await run('gcloud', ['storage', 'cp', object, path.join(work, 'pglite.tgz'), '--project', project])
    await Deno.mkdir(dest, { recursive: true })
    await run('tar', ['-xzf', path.join(work, 'pglite.tgz'), '-C', dest])
  } finally {
    await Deno.remove(work, { recursive: true })
  }
}
