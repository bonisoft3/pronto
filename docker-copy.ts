// `docker create` with each [source, target] copied in, returning the
// container's id for the caller to start. A bind mount names a path on the
// daemon's host, which is not the caller's when the daemon runs in another
// container (dind), so the mount comes up empty; a copy travels the API.
export async function created(args: string[], copies: [string, string][]): Promise<string> {
  const docker = async (...argv: string[]) => {
    const result = await new Deno.Command("docker", { args: argv, stdout: "piped", stderr: "piped" }).output();
    if (!result.success) throw new Error(`docker ${argv.join(" ")}: ${new TextDecoder().decode(result.stderr)}`);
    return new TextDecoder().decode(result.stdout).trim();
  };
  const id = await docker("create", ...args);
  try {
    for (const [source, target] of copies) {
      const directory = (await Deno.stat(source)).isDirectory;
      // The copy lands owned by root with the source's mode, and a temp dir's
      // 0700 shuts out an image that runs as another user.
      if (directory) await Deno.chmod(source, 0o755);
      // A directory's contents, so an existing target is filled, not nested.
      await docker("cp", directory ? `${source}/.` : source, `${id}:${target}`);
    }
  } catch (err) {
    await docker("rm", "-f", id);
    throw err;
  }
  return id;
}
