// The one way WebAssembly reaches an isolate: a source import, a
// WebAssembly.Module under Deno and on a Cloudflare Worker alike, which the
// bundle leaves outside itself.
import source module from "./add.wasm";
export default module;
