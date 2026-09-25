// The client runtime is authoritative; this produces Pronto's standalone copy.
const source = new URL("../../libraries/mecha/packages/client/src/types.ts", import.meta.url)
const target = new URL("./portable-types.ts", import.meta.url)

export async function portableTypeSource(): Promise<string> {
  return await Deno.readTextFile(source)
}

export const portableCarrierSource = portableTypeSource

export async function refreshPortableTypes(): Promise<void> {
  await Deno.writeTextFile(target, await portableTypeSource())
}

export const refreshPortableCarriers = refreshPortableTypes

if (import.meta.main) await refreshPortableTypes()
