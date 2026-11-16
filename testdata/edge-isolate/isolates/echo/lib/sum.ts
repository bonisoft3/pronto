// A module below the entrypoint importing the shim by its own relative path,
// which the bundle writes as the shim beside it.
import add from "../add.wasm.js";

const { exports } = await WebAssembly.instantiate(add) as unknown as { exports: { add(a: number, b: number): number } };

export const sum = (a: number, b: number): number => exports.add(a, b);
