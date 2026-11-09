// Renders an edge release's src/functions.js: the app's database functions by
// name, each the module PostgreSQL would run in plv8 (database-functions.ts),
// instrumented for the same fuel, for the object's host import (mecha-edge's
// machines.ts), which reaches one under its step name.
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'
import { functionModule, PLAIN } from '../database-functions.ts'
import { HARDEN } from './edge-machines.ts'

export type Functions = Record<string, { fuel: number; rules: string; endowments?: string[] }>

export async function renderFunctions(app: string, appDir: string, omnishell: string, functions: Functions): Promise<string> {
  const { instrument } = await import(pathToFileURL(path.join(omnishell, 'instrument.ts')).href) as { instrument: (source: string) => string }
  const entries: string[] = []
  for (const name of Object.keys(functions).sort()) {
    const { fuel, rules, endowments } = functions[name]
    if (path.isAbsolute(rules) || rules.split(/[\\/]/).includes('..')) throw new Error(`function ${name}: unsafe rules path ${rules}`)
    const source = (await Deno.readTextFile(path.join(appDir, rules))).trim()
    const module = functionModule({ name, fuel, endowments }, source, { instrument })
    entries.push(`  ${name}: fn(${JSON.stringify(name)}, ${fuel}, (__fuel) => {\n${module.statements}\nreturn (${module.completion})\n}),`)
  }
  return `// Written by pronto's edge.ts for ${app}: the database functions, for the object's host import (mecha-edge's machines.ts).
${HARDEN}
const plain = ${PLAIN}
// A call starts with its whole budget, as in plv8.
const fn = (name, fuel, module) => ({ execute: (input) => {
  let spent = 0
  const meter = () => { if (++spent > fuel) throw new RangeError('function ' + name + ': fuel exhausted') }
  return plain(module(meter)(harden(JSON.parse(JSON.stringify(input)))))
} })
export default {
${entries.join('\n')}
}
`
}
