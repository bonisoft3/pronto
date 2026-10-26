# Bootstrap

Pronto is a CUE module and a source distribution, not a CLI. The agent plugin
carries installation knowledge; it is not the compiler installation.

Use Pronto **0.24.0** through CUE module **0.24.1**, and Sayt **0.45.0**.
Verify both Pronto releases and the Sayt release exist before installation; do
not substitute `main` or `latest` for a missing release.

A finish CUE release carries previously published tool self-pins so its shipped
lock is complete. Keep the generated tool versions even when they differ from
the CUE module versions.

Bootstrap is the agent's to run, first, in the app's directory: everything it
installs lands there and in mise's cache. A checkout of pronto on disk does not
replace it; copy from the checkout's idioms and bootstrap from the release.

1. Download both project wrappers from the same pinned Sayt tag:

   ```sh
   curl -fsSL https://raw.githubusercontent.com/bonisoft3/sayt/v0.45.0/saytw -o saytw
   curl -fsSL https://raw.githubusercontent.com/bonisoft3/sayt/v0.45.0/saytw.ps1 -o saytw.ps1
   chmod +x saytw
   ```

   On Windows, use `curl.exe` for the downloads and `./saytw.ps1` below. Retain
   both wrappers as project files; commit only when authorized.

2. From the target repository, run the three CUE commands. Choose the consumer
   module identity; do not reuse Pronto's identity:

   ```sh
   ./saytw --script tools.nu cue mod init example.com/my-app@v0
   ./saytw --script tools.nu cue mod get github.com/bonisoft3/pronto@v0.24.1
   ./saytw --script tools.nu cue cmd bootstrap github.com/bonisoft3/pronto/bootstrap@v0
   ```

   CUE comes from Sayt's independent `cue.toml` stub. No project Mise config or
   globally installed CUE is needed. An existing consumer module keeps its
   identity: inspect it and skip `mod init`. Bootstrap refuses existing seed
   or generated configuration files; reconcile them explicitly for adoption.

3. Bootstrap writes `pronto/config.cue`, `pronto/generate_tool.cue`,
   `.mise.toml`, `.say.yaml`, and `mise.lock`. The first two are the source;
   `sayt generate` recreates `.mise.toml` and `.say.yaml`. The seed config
   carries the default roster — terminal omnishell, cluster mecha, build
   bayt — and `mise.lock` is that roster's lock: every platform's artifact
   URL and checksum. With the attestation checks `.mise.toml` turns off,
   installing from it asks GitHub's API nothing.

4. Inspect and trust `.mise.toml`, then install and check the toolchain:

   ```sh
   ./saytw --script tools.nu mise trust .mise.toml
   ./saytw setup
   ./saytw doctor
   ./saytw generate
   ./saytw lint
   ```

   Every step stays locked. The checksums pin the downloaded bytes, not an
   independent upstream attestation. Retain `mise.lock` with the project. Do
   not disable locked mode to make generation pass.

To take another terminal, cluster, or builder, replace the corresponding
line in `pronto/config.cue` — or split the seats into files, which
unifies the same way — then run
`./saytw --script tools.nu cue cmd generate ./pronto`. Inspect the
generated configuration, then lock the new tools before step 4:

```sh
./saytw --script tools.nu mise lock
./saytw --script tools.nu nu -c 'with-env {MISE_LOCKED: "0"} { ^mise install }'
```

`mise lock` reads release metadata from GitHub's API, so give it a
`GITHUB_TOKEN`; it leaves HTTP artifacts without checksums, which the scoped
install records for the current platform. Setting `MISE_LOCKED=0` outside
that scoped command does not work: Sayt clears the launcher's override so
project locking prevails. An already-installed tool is skipped without
filling its entry; repeat the install with `--force <tool>` (for example,
`^mise install --force http:duckdb`) and recheck the lock.

Once the app has a `program.cue`, that command rewrites only `.mise.toml`; the
seat's Sayt rules reach `.say.yaml` on the next `./saytw generate`, whose writer
unifies them with the program's.

Host plugins and project configuration are separate installations. Use the
host's supported plugin installer, then restart or reload when required by
that host. Generated project files do not install a plugin into a running
session. Common role briefs are portable; multi-agent execution uses each
host's native facilities.
