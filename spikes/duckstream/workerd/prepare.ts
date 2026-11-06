const here = new URL(".", import.meta.url);
const build = new URL(".build/", here);
await Deno.mkdir(build, { recursive: true });
async function download(url: string, path: URL) {
  const response = await fetch(url);
  if (!response.ok) throw Error(`${url}: ${response.status}`);
  await Deno.writeFile(path, new Uint8Array(await response.arrayBuffer()));
}
async function checked(path: URL, expected: string) {
  const bytes = await Deno.readFile(path);
  const hash = Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    (n) => n.toString(16).padStart(2, "0"),
  ).join("");
  if (hash !== expected) throw Error(`Checksum mismatch: ${path}`);
  return bytes;
}
function replace(
  source: string,
  from: string | RegExp,
  to: string,
  count: number,
) {
  const found = typeof from === "string"
    ? source.split(from).length - 1
    : [...source.matchAll(from)].length;
  if (found !== count) {
    throw Error(`Patch expected ${count} occurrences, got ${found}: ${from}`);
  }
  return source.replaceAll(from, to);
}
await download(
  "https://registry.npmjs.org/@duckdb/duckdb-wasm/-/duckdb-wasm-1.33.1-dev57.0.tgz",
  new URL("duckdb.tgz", build),
);
const unpack = await new Deno.Command("tar", {
  args: ["xzf", "duckdb.tgz"],
  cwd: build,
}).output();
if (!unpack.success) throw Error(new TextDecoder().decode(unpack.stderr));
const source = await checked(
  new URL("package/dist/duckdb-browser-blocking.mjs", build),
  "711879e43bf38648f35f6d5e0a6dfffb9c8918ed085466a891902845cdf9e710",
);
const wasm = await checked(
  new URL("package/dist/duckdb-eh.wasm", build),
  "3abdec74989dcc54d2f2ea5621f611f3c45db1e7dff2f408476014d82beb2029",
);
await Deno.writeFile(new URL("duckdb.wasm", build), wasm);
await Deno.mkdir(new URL("assets/", build), { recursive: true });
for (
  const [name, hash] of Object.entries({
    json: "993b19f7929cc305b2529c548f2842e8e7a5b112d1c88f31c84798b51901ca16",
    icu: "ecdbbb29331f72103b8eb227db5792f186b191a4f7a359db8dda9919b0a736de",
  })
) {
  const file = new URL(`${name}.wasm`, build);
  await download(
    `https://extensions.duckdb.org/v1.5.4/wasm_eh/${name}.duckdb_extension.wasm`,
    file,
  );
  await Deno.writeFile(
    new URL(`assets/${name}.bin`, build),
    await checked(file, hash),
  );
}
const thunkHex: string[] = JSON.parse(
  await Deno.readTextFile(new URL("thunks.json", here)),
);
const thunks = thunkHex.map((hex) =>
  Array.from(hex.matchAll(/../g), ([byte]) => parseInt(byte, 16))
);
let prefix = "var process=undefined;\n";
const entries = [];
for (const [i, bytes] of thunks.entries()) {
  await Deno.writeFile(new URL(`thunk${i}.wasm`, build), new Uint8Array(bytes));
  prefix += `import thunk${i} from './thunk${i}.wasm';\n`;
  entries.push(`${JSON.stringify(bytes.join(","))}:thunk${i}`);
}
prefix += `const staticThunks={${entries.join(",")}};
function staticModule(bytes){const mod=staticThunks[Array.from(bytes).join(',')];if(!mod)throw Error('Unknown static thunk');return mod;}
import jsonModule from './json.wasm';import icuModule from './icu.wasm';
const extensionModules={json:jsonModule,icu:icuModule};
let extensionBytes;
export function setExtensions(json,icu){extensionBytes={'json.duckdb_extension.wasm':json,'icu.duckdb_extension.wasm':icu};}
`;
let patched = new TextDecoder().decode(source);
patched = replace(
  patched,
  "new WebAssembly.Module(new Uint8Array(n))",
  "staticModule(new Uint8Array(n))",
  2,
);
patched = replace(
  patched,
  "loadWebAssemblyModule=(binary,flags,libName,localScope,handle)=>{",
  'loadWebAssemblyModule=(binary,flags,libName,localScope,handle)=>{if(!extensionModules[libName])throw Error("Unexpected extension: "+libName);binary=extensionModules[libName];',
  2,
);
patched = replace(
  patched,
  /var t=UTF8ToString\(e\);if\(typeof XMLHttpRequest>"u"\)\{let h=Oe\(\)[\s\S]*?u=h.response\}for\(var d=WebAssembly.validate\(u\),/g,
  'var t=UTF8ToString(e),u=extensionBytes[t.split("/").pop()];if(!u)throw Error("Unbundled extension: "+t);for(var d=WebAssembly.validate(u),',
  2,
);
await Deno.writeTextFile(new URL("duckdb.mjs", build), prefix + patched);
await Deno.copyFile(new URL("worker.js", here), new URL("worker.js", build));
await Deno.writeTextFile(
  new URL("wrangler.json", build),
  JSON.stringify(
    {
      name: "duckstream-do-static-spike",
      main: "worker.js",
      compatibility_date: "2026-09-01",
      minify: true,
      assets: {
        directory: "./assets",
        binding: "ASSETS",
        run_worker_first: true,
      },
      durable_objects: { bindings: [{ name: "PROBE", class_name: "Probe" }] },
      migrations: [{ tag: "v1", new_sqlite_classes: ["Probe"] }],
      rules: [{
        type: "CompiledWasm",
        globs: ["**/*.wasm"],
        fallthrough: true,
      }],
    },
    null,
    2,
  ),
);
console.log(
  `Prepared ${build.pathname}: DuckDB, JSON, ICU, ${thunks.length} static callback signatures`,
);
