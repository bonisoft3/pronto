# Bootstrap

Pronto is a CUE module and a source distribution, not a CLI. The agent plugin
carries installation knowledge; it is not the compiler installation.

Use Pronto **1.8.0** through CUE module **1.8.1**, and Sayt **0.49.1**.
Verify both Pronto releases and the Sayt release exist before installation; do
not substitute `main` or `latest` for a missing release.

A finish CUE module (for example `v1.8.1`) pins and locks the preceding Pronto
source distribution (`1.8.0`). Generated `.mise.toml` and `mise.lock` agree on
every tool version; keep `"github:bonisoft3/pronto" = "1.8.0"` rather than
rewriting it to the CUE module tag.

Bootstrap is the agent's to run, first, in the app's directory: everything it
installs lands there and in mise's cache. A checkout of pronto on disk does not
replace it; copy from the checkout's idioms and bootstrap from the release.

1. Download both project wrappers from the same pinned Sayt tag:

   ```sh
   curl -fsSL https://raw.githubusercontent.com/bonisoft3/sayt/v0.49.1/saytw -o saytw
   curl -fsSL https://raw.githubusercontent.com/bonisoft3/sayt/v0.49.1/saytw.ps1 -o saytw.ps1
   chmod +x saytw
   ```

   On Windows, use `curl.exe` for the downloads and `./saytw.ps1` below. Retain
   both wrappers as project files; commit only when authorized.

2. From the target repository, run the three CUE commands. Choose the consumer
   module identity; do not reuse Pronto's identity:

   ```sh
   ./saytw --script tools.nu cue mod init example.com/my-app@v0
   ./saytw --script tools.nu cue mod get github.com/bonisoft3/pronto@v1.8.1
   ./saytw --script tools.nu cue cmd bootstrap github.com/bonisoft3/pronto/bootstrap@v1
   ```

   CUE comes from Sayt's independent `cue.toml` stub. No project Mise config or
   globally installed CUE is needed. An existing consumer module keeps its
   identity: inspect it and skip `mod init`. Bootstrap refuses existing seed
   or generated configuration files; reconcile them explicitly for adoption.

3. Bootstrap writes `pronto/config.cue`, `pronto/generate_tool.cue`,
   `.mise.toml`, `.mise.host.toml`, `.say.yaml`, `mise.lock`, and
   `mise.host.lock`. The first two are the source; `sayt generate` recreates
   `.mise.toml`, `.mise.host.toml` and `.say.yaml`. The seed config
   carries the default roster — terminal omnishell, cluster mecha, build
   bayt — and `mise.lock` is that roster's lock: every platform's artifact
   URL and checksum. With the attestation checks `.mise.toml` turns off,
   installing from it asks GitHub's API nothing.

4. Inspect and trust `.mise.toml`, then install and check the toolchain (prefix `./saytw` with `mise x --` when `nu` is not on the host `PATH`):

   ```sh
   ./saytw --script tools.nu mise trust .mise.toml
   mise x -- ./saytw setup
   mise x -- ./saytw doctor
   ```

5. Author `program.cue` first, then run `mise x -- ./saytw generate` once: the compiler emits a single cold-start preflight checklist of every owed file (`journal.html`, `ir.html`, `acceptance.md`, `DESIGN.md`, `shell/*`, `tests/*`) and every owed `data-kind` / `id` tag for `ir.html` and `acceptance.md`. Create those files and run:

   ```sh
   mise x -- ./saytw generate
   mise x -- ./saytw lint
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
```

`mise lock` resolves release metadata through mise's versions host and
downloads each HTTP artifact once to record its checksum, for every platform
the lock already lists. Installs stay locked: an unlocked install would
rewrite the lock and fail on `mise.local.toml`'s `path:` pins.

Once the app has a `program.cue`, that command rewrites only `.mise.toml` and
`.mise.host.toml`; the seat's Sayt rules reach `.say.yaml` on the next
`./saytw generate`, whose writer unifies them with the program's.

Host plugins and project configuration are separate installations. Use the
host's supported plugin installer, then restart or reload when required by
that host. Generated project files do not install a plugin into a running
session. Common role briefs are portable; multi-agent execution uses each
host's native facilities.
