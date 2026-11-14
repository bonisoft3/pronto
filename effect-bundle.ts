// An external effect's handler, bundled: the module graph its source reaches by
// relative imports (engine-link.ts's walk), written as the one module importing
// nothing that the airlock admits (mecha's services/airlock/handler.ts). Every
// module, the handler's own included, becomes a function scope run once, after
// the modules it imports, whose exports are a frozen namespace with no
// prototype; the bundle exports the handler's namespace by name. No authored
// binding is in scope of another module, nor of the bundle's own code. Why a
// handler is bundled at generate rather than linked by the airlock is
// docs/decisions/2026-10-03-external-effects.md.
import { posix } from "node:path";
import { padAtoms } from "./jessie.ts";
import { LinkError, linkModules, type ModuleRecord, resolveSpecifier } from "./engine-link.ts";

const MODULE_SOURCE = "npm:@endo/module-source@1.4.0";
const WHO = "a handler";

/** The handler the author writes, and the bundle the airlock loads. */
export const effectSource = (name: string) => `effects/${name}.js`;
export const effectBundle = (name: string) => `services/airlock/effects/${name}.js`;

const scope = (i: number) => `__pronto_module_${i}`;
const RESERVED = /__pronto_/;
// The intrinsics the bundle's code calls, bound before any module runs, so a
// module declaring `Object` changes none of them.
const PRELUDE = `const __pronto_namespace = ((create, define, freeze) => (members) => {
  const namespace = create(null);
  members.forEach(([name, value]) => define(namespace, name, { value, enumerable: true }));
  return freeze(namespace);
})(Object.create, Object.defineProperty, Object.freeze);
`;

// Read over padAtoms' copy, where comments and string bodies are blank and the
// quotes stay, so an index into it is an index into the source.
const IMPORT = /(?<=^|[;}\n])\s*import\b([^;"'`]*?)(["'])[^\n]*?\2[ \t]*;?/g;
const EXPORT_LIST = /(?<=^|[;}\n])\s*export\s*\{[^}]*\}(\s*from\s*(["'])[^\n]*?\2)?[ \t]*;?/g;
const EXPORT_DECLARATION = /(?<=^|[;}\n])(\s*)export\s+(?=(const|let|var|function|async|class)\b)/g;
const EXPORT_DEFAULT = /(?<=^|[;}\n])\s*export\s+default\b/;
const EXPORT_STAR_AS = /(?<=^|[;}\n])\s*export\s*\*\s*as\b/;
const IDENT = /^[A-Za-z_$][\w$]*$/;
const STRING_NAME = /(?<=^|[;}\n])\s*(import|export)\s*\{[^}]*["'`]/;

type Edit = { start: number; end: number; text: string };

/** The specifier a padded match quotes, read from the source. */
function quoted(source: string, at: number, match: string, quote: string): string {
  return source.slice(at + match.indexOf(quote) + 1, at + match.lastIndexOf(quote));
}

/** The forms the rewrite refuses before Endo reads them, named. */
function refuse(path: string, source: string): void {
  if (RESERVED.test(source)) throw new LinkError(`${path} names __pronto_, which a handler's bundle reserves`);
  const padded = padAtoms(source);
  // An escaped identifier would hide a reserved name from the check above.
  if (/\\u/.test(padded)) throw new LinkError(`${path} escapes an identifier with \\u: a handler's modules spell their names plainly`);
  if (STRING_NAME.test(padded)) throw new LinkError(`${path} names an import or export by a string: a handler's modules name them by identifier`);
  if (EXPORT_DEFAULT.test(padded)) throw new LinkError(`${path} exports a default: a handler's modules export by name`);
  if (EXPORT_STAR_AS.test(padded)) throw new LinkError(`${path} re-exports * as a namespace: import it as one and export that by name`);
}

/**
 * The handler `src` and the modules it imports, as one module importing
 * nothing; `modules` lists the app paths read, the handler last. The same app
 * gives the same bytes: modules in import order, nothing of the time or place.
 */
export async function bundleEffect(appDir: string, src: string): Promise<{ text: string; modules: string[] }> {
  const graph = await linkModules(appDir, src, WHO, refuse);
  const path = (k: string) => k.slice(2);
  const target = (from: string, specifier: string) => `./${resolveSpecifier(path(from), specifier, WHO)}`;

  // Each module after the modules it imports; a cycle has no such order.
  const order: string[] = [];
  const visit = (k: string, stack: string[]) => {
    if (order.includes(k)) return;
    if (stack.includes(k)) {
      throw new LinkError(`${[...stack.slice(stack.indexOf(k)), k].map(path).join(" imports ")}: a handler's modules form no cycle, each runs once before the modules importing it`);
    }
    for (const specifier of graph.modules[k].imports) visit(target(k, specifier), [...stack, k]);
    order.push(k);
  };
  visit(graph.entry, []);
  const index = new Map(order.map((k, i) => [k, i]));

  const { ModuleSource } = await import(MODULE_SOURCE);
  const parses = (text: string) => {
    try {
      new ModuleSource(text, "module.js");
      return true;
    } catch {
      return false;
    }
  };
  const parts = order.map((k) => {
    const from = (specifier: string) => scope(index.get(target(k, specifier))!);
    const { head, body, members } = rewrite(path(k), graph.sources[k], graph.modules[k], (specifier) => graph.modules[target(k, specifier)], from);
    const inner = `{\n${head}${body}\nreturn __pronto_namespace([${members}]);\n}`;
    const wrapped = `(() => ${inner})()`;
    // A module that awaits at its top level parses only in an async scope,
    // and a handler's modules run before it, synchronously.
    if (!parses(`${wrapped};`)) {
      throw new LinkError(parses(`(async () => ${inner})();`)
        ? `${path(k)} awaits at its top level: a handler's modules run once, synchronously, before it is called`
        : `${path(k)} does not parse once its imports and exports are rewritten`);
    }
    return `// ${path(k)}\nconst ${scope(index.get(k)!)} = ${wrapped};\n`;
  });
  const exports = graph.modules[graph.entry].exports;
  // Exported through reserved locals, so no export name is a binding in scope
  // of a module or of the prelude.
  const local = (i: number) => `__pronto_export_${i}`;
  const text = `${PRELUDE}\n${parts.join("\n")}
const { ${exports.map((name, i) => `${name}: ${local(i)}`).join(", ")} } = ${scope(index.get(graph.entry)!)};
export { ${exports.map((name, i) => `${local(i)} as ${name}`).join(", ")} };
`;

  // The bundle is held to what the airlock reads: a module importing nothing
  // that exports what the handler exports. Anything the rewrite misread fails
  // here, never in the airlock.
  const at = posix.join("services/airlock", src);
  let record: ModuleRecord;
  try {
    record = JSON.parse(JSON.stringify(new ModuleSource(text, at)));
  } catch (e) {
    throw new LinkError(`${src}: its bundle does not parse (${(e as Error).message})`);
  }
  if (record.imports.length > 0 || record.exports.join() !== exports.join()) {
    throw new LinkError(`${src}: its bundle imports ${record.imports.join(", ") || "nothing"} and exports ${record.exports.join(", ")}, not ${exports.join(", ")}`);
  }
  return { text, modules: order.map(path) };
}

/** One module's text with its imports read from the namespaces before it, its
 * export keywords gone, and `members` its namespace's entries. */
function rewrite(
  path: string,
  source: string,
  record: ModuleRecord,
  imported: (specifier: string) => ModuleRecord,
  from: (specifier: string) => string,
): { head: string; body: string; members: string } {
  const padded = padAtoms(source);
  if (record.reexports.length > 0) throw new LinkError(`${path} re-exports * from "${record.reexports[0]}": name what it re-exports`);
  const live = record.__liveExportMap__ as Record<string, [string, boolean]>;
  for (const [name, [, assigned]] of Object.entries(live)) {
    if (assigned) throw new LinkError(`${path} exports ${name} and assigns it: a bundled module's exports are read once`);
  }
  const exported = (specifier: string, name: string, how: string) => {
    if (!imported(specifier).exports.includes(name)) throw new LinkError(`${path} ${how} ${name} from "${specifier}", which does not export it`);
  };

  const edits: Edit[] = [];
  const read = new Set<string>();
  let head = "";
  for (const m of padded.matchAll(IMPORT)) {
    const specifier = quoted(source, m.index, m[0], m[2]);
    read.add(specifier);
    edits.push({ start: m.index, end: m.index + m[0].length, text: "" });
    const clause = m[1].trim().replace(/\s*\bfrom$/, "").trim();
    if (clause === "") continue;
    const namespace = clause.match(/^\*\s*as\s+([A-Za-z_$][\w$]*)$/);
    if (namespace) {
      head += `const ${namespace[1]} = ${from(specifier)};\n`;
      continue;
    }
    const named = clause.match(/^\{([^}]*)\}$/);
    if (!named) throw new LinkError(`${path} imports a default from "${specifier}": a handler's modules import by name`);
    const bindings = named[1].split(",").map((b) => b.trim()).filter((b) => b !== "").map((b) => {
      const [name, local = name] = b.split(/\s+as\s+/);
      if (!IDENT.test(name) || !IDENT.test(local)) throw new LinkError(`${path} imports "${b}" from "${specifier}", which a handler's bundle cannot name`);
      exported(specifier, name, "imports");
      return name === local ? name : `${name}: ${local}`;
    });
    if (bindings.length > 0) head += `const { ${bindings.join(", ")} } = ${from(specifier)};\n`;
  }
  for (const m of padded.matchAll(EXPORT_LIST)) {
    if (m[1] !== undefined) read.add(quoted(source, m.index + m[0].lastIndexOf(m[1]), m[1], m[2]));
    edits.push({ start: m.index, end: m.index + m[0].length, text: "" });
  }
  for (const m of padded.matchAll(EXPORT_DECLARATION)) edits.push({ start: m.index, end: m.index + m[0].length, text: m[1] });
  if ([...read].sort().join() !== [...new Set(record.imports)].sort().join()) {
    throw new LinkError(`${path}: its imports read as ${[...read].join(", ") || "none"}, not ${record.imports.join(", ")}: write each as one static import declaration`);
  }

  let body = source;
  for (const e of edits.sort((a, b) => b.start - a.start)) body = body.slice(0, e.start) + e.text + body.slice(e.end);

  const reexports = Object.entries(record.__reexportMap__ as Record<string, [string, string][]>);
  for (const [specifier, pairs] of reexports) for (const [name] of pairs) exported(specifier, name, "re-exports");
  const entries: [string, string][] = [
    ...Object.entries(record.__fixedExportMap__ as Record<string, [string]>).map(([name, [local]]): [string, string] => [name, local]),
    ...Object.entries(live).map(([name, [local]]): [string, string] => [name, local]),
    ...reexports.flatMap(([specifier, pairs]) => pairs.map(([name, as]): [string, string] => [as, `${from(specifier)}.${name}`])),
  ];
  for (const [name] of entries) if (!IDENT.test(name)) throw new LinkError(`${path} exports "${name}", which a handler's bundle cannot name`);
  const members = entries.sort(([a], [b]) => (a < b ? -1 : 1)).map(([name, value]) => `["${name}", ${value}]`).join(", ");
  return { head, body, members };
}
