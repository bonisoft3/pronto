// Browser shims for node:* modules unreferenced at runtime in browser bundles.
export const existsSync = () => false
export const mkdirSync = () => {}
export const readFileSync = () => new Uint8Array()
export const resolve = (...paths: string[]) => paths.filter(Boolean).join('/')
export const join = (...paths: string[]) => paths.filter(Boolean).join('/')
export default {}
