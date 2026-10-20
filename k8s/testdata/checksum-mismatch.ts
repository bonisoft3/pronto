const release = Deno.args[0];
if (!release) throw new Error("release.nu path required");
const server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, () =>
  new Response("apiVersion: v1\nkind: Namespace\nmetadata:\n  name: checksum-test\n")
);
try {
  const entry = {
    name: "test-mismatch",
    url: `http://127.0.0.1:${server.addr.port}/operator.yaml`,
    checksum: `sha256:${"0".repeat(64)}`,
  };
  const command = `use ${JSON.stringify(release)} fetch-verified; '${JSON.stringify(entry)}' | from json | fetch-verified $in`;
  const result = await new Deno.Command("nu", { args: ["-c", command], stdout: "piped", stderr: "piped" }).output();
  const stderr = new TextDecoder().decode(result.stderr);
  if (result.success || !stderr.includes(`Checksum mismatch for ${entry.name}`)) {
    throw new Error(`Expected checksum mismatch, exit ${result.code}: ${stderr}`);
  }
} finally {
  await server.shutdown();
}
