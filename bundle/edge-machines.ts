// Renders an edge release's src/machines.js: the app's machines by name, each
// the step its migration declares (mecha-reducer.ts) over the rules the app
// authored, for the object's host import (mecha-edge's machines.ts). The
// rules are instrumented as plv8's are, for the same fuel; what plv8 hardens
// with SES the object freezes, so a rule is handed values it cannot change.
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'
import { declaredMachine, HYBRID_NAME } from '../hybrid-spec.ts'

export type Hybrids = Record<string, { reducer: Record<string, unknown> & { name: string; fuel: number }; rules: string }>

export async function renderMachines(app: string, appDir: string, omnishell: string, hybrids: Hybrids): Promise<string> {
  const { instrument } = await import(pathToFileURL(path.join(omnishell, 'instrument.ts')).href) as { instrument: (source: string) => string }
  const runtime = (await Deno.readTextFile(new URL('../hybrid-runtime.js', import.meta.url))).trim()
  const machines: string[] = []
  for (const name of Object.keys(hybrids).sort()) {
    const { reducer, rules } = hybrids[name]
    if (reducer.name !== name || !HYBRID_NAME.test(name)) throw new Error(`machine ${name} is declared as ${reducer.name}`)
    if (path.isAbsolute(rules) || rules.split(/[\\/]/).includes('..')) throw new Error(`machine ${name}: unsafe rules path ${rules}`)
    const source = (await Deno.readTextFile(path.join(appDir, rules))).trim()
    machines.push(`  ${name}: machine(${JSON.stringify(declaredMachine(reducer))}, ${reducer.fuel}, (__fuel) => (${instrument(`(() => { ${source}\n })()`)})),`)
  }
  return `// Written by pronto's edge.ts for ${app}: the machines' steps, for the object's host import (mecha-edge's machines.ts).
// Through the descriptors, as SES walks them: an accessor the runtime plants
// to refuse a read is frozen, never read.
const harden = (value, seen = new WeakSet()) => {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function') || seen.has(value)) return value
  seen.add(value)
  Object.freeze(value)
  for (const d of Object.values(Object.getOwnPropertyDescriptors(value))) for (const v of [d.value, d.get, d.set]) harden(v, seen)
  return value
}
const runtime = ((harden) => (${runtime}))(harden)
// A step starts with its whole budget: the fuel is the step's, as in plv8.
const machine = (spec, fuel, rules) => {
  harden(spec)
  return { execute: (input) => {
    let spent = 0
    const meter = () => { if (++spent > fuel) throw new RangeError('hybrid fuel exhausted') }
    const execute = runtime(spec, harden(rules(meter)))
    const answer = execute(input)
    meter()
    return answer
  } }
}
export default {
${machines.join('\n')}
}
`
}
