# Bootstrap

Pronto is a CUE module and a source distribution, not a CLI. The agent plugin
carries installation knowledge; it is not the compiler installation.

Use Pronto **0.3.0** and Sayt **0.39.1**. Verify both releases exist before
installation; do not substitute `main` or `latest` for a missing release.

1. Download both project wrappers from the same pinned Sayt tag:

   ```sh
   curl -fsSL https://raw.githubusercontent.com/bonisoft3/sayt/v0.39.1/saytw -o saytw
   curl -fsSL https://raw.githubusercontent.com/bonisoft3/sayt/v0.39.1/saytw.ps1 -o saytw.ps1
   chmod +x saytw
   ```

   On Windows, use `curl.exe` for the downloads and `./saytw.ps1` below. Retain
   both wrappers as project files; commit only when authorized.

2. From the target repository, run the three CUE commands. Choose the consumer
   module identity; do not reuse Pronto's identity:

   ```sh
   ./saytw --script tools.nu cue mod init example.com/my-app@v0
   ./saytw --script tools.nu cue mod get github.com/bonisoft3/pronto@v0.3.0
   ./saytw --script tools.nu cue cmd bootstrap github.com/bonisoft3/pronto/bootstrap@v0
   ```

   CUE comes from Sayt's independent `cue.toml` stub. No project Mise config or
   globally installed CUE is needed. An existing consumer module keeps its
   identity: inspect it and skip `mod init`. Bootstrap refuses existing seed
   or generated configuration files; reconcile them explicitly for adoption.

3. Bootstrap writes `pronto/config.cue`, `pronto/generate_tool.cue`, `.mise.toml`, and
   `.say.yaml`. The first two are the source; `sayt generate` recreates the
   last two. Bootstrap knows only Pronto's requirements.

4. Inspect and trust `.mise.toml`, create the project lock, then install and
   check the toolchain:

   ```sh
   ./saytw --script tools.nu mise trust .mise.toml
   ./saytw --script tools.nu mise lock
   ./saytw setup
   ./saytw doctor
   ./saytw generate
   ./saytw lint
   ```

   `mise lock` is the explicit lock-writing operation. Inspect its resolved
   versions, artifact URLs and checksums; retain `mise.lock` with the project.
   Do not disable locked mode to make generation pass.

When choosing a terminal, cluster, or builder, unify its exported project
requirements into `pronto` in package `prontoproject`, then run
`./saytw --script tools.nu cue cmd generate ./pronto`. Inspect the generated
configuration and repeat trust → lock → setup → doctor before generation uses
the new tools.

Host plugins and project configuration are separate installations. Use the
host's supported plugin installer, then restart or reload when required by
that host. Generated project files do not install a plugin into a running
session. Common role briefs are portable; multi-agent execution uses each
host's native facilities.
