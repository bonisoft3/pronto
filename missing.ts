/** A missing file is the one absence pronto resolves; anything else is raised. */
export async function ifMissing<T, U>(p: Promise<T>, otherwise: U): Promise<T | U> {
  try {
    return await p;
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return otherwise;
    throw e;
  }
}

/** Whether the path is there; a dangling link is, and reading it then raises. */
export const exists = async (path: string) => (await ifMissing(Deno.lstat(path), null)) !== null;

/** The entries of a directory, `otherwise` for one that is not there. */
export function entries<U = never>(dir: string, otherwise: Deno.DirEntry[] | U = []): Promise<Deno.DirEntry[] | U> {
  return ifMissing(Array.fromAsync(Deno.readDir(dir)), otherwise);
}
