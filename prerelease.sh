#!/bin/sh
# Publishes a prerelease of this fork, from a machine or from Actions (.github/workflows/prerelease-gcp.yml
# runs this on a publish/v<version> push): the CUE module to ghcr.io/bsoneca/cue-modules and the
# runtime tarballs as a GitHub release here, both free. No Docker: crane serves a registry
# for `cue mod publish` and copies the module out, with the ghcr.io credentials crane already holds
# (~/.docker/config.json) and gh's own login for the release.
#   ./prerelease.sh 0.24.1-gcp.25 [commit=HEAD]
#   ./prerelease.sh --runtime-only 0.24.1-gcp.25 [commit]   the runtime again, over a published
#     version's release, from the commit it was published from: its module is never touched
# The mecha and omnishell modules the snapshot pins are .github/prerelease.env's MECHA_V and
# OMNISHELL_V, versions ghcr.io/bsoneca/cue-modules already holds, and their runtimes the fork's
# mecha-v$MECHA_V and omnishell-v$OMNISHELL_V releases.
# A repo the published bootstrap starts runs on this fork as the monorepo's apps do: its .mise.toml
# names the fork's CUE registry, and the lock bootstrap ships names this release's pronto (by URL:
# its checksum is the tarball's own, which holds the lock, so mise records it at the first install)
# and the fork's mecha and omnishell. A new app's omnishell is its module's toolchain's, so the
# checks its lint runs (omnishell check machines) are the fork's too.
set -eu
runtime_only=false
if [ "${1:-}" = --runtime-only ]; then runtime_only=true; shift; fi
PRONTO_V=${1:?the version, such as 0.24.1-gcp.25}
here=$(cd "$(dirname "$0")" && pwd)
SRC=$(git -C "$here" rev-parse "${2:-HEAD}")
MODULE=ghcr.io/bsoneca/cue-modules/github.com/bonisoft3/pronto
MECHA_V=$(sed -n 's/^MECHA_V=\([0-9A-Za-z.-]*\)$/\1/p' "$here/.github/prerelease.env")
[ -n "$MECHA_V" ] || { echo ".github/prerelease.env names no MECHA_V" >&2; exit 1; }
OMNISHELL_V=$(sed -n 's/^OMNISHELL_V=\([0-9A-Za-z.-]*\)$/\1/p' "$here/.github/prerelease.env")
[ -n "$OMNISHELL_V" ] || { echo ".github/prerelease.env names no OMNISHELL_V" >&2; exit 1; }
# sayt's own mise, where sayt caches it: ~/Library/Caches on macOS, the XDG cache elsewhere.
case $(uname -s) in
Darwin) cache=$HOME/Library/Caches ;;
*) cache=${XDG_CACHE_HOME:-$HOME/.cache} ;;
esac
mise=${SAYT_MISE_BIN:-$cache/sayt/mise-v2026.8.11/mise}
crane() { "$mise" exec 'github:google/go-containerregistry[bin=crane]@v0.20.2' -- crane "$@"; }
cue() { "$mise" exec 'github:cue-lang/cue@0.16.1' -- cue "$@"; }

# A version once published never changes (but for --runtime-only, which keeps its module).
if ! $runtime_only && crane digest "$MODULE:v$PRONTO_V" >/dev/null 2>&1; then echo "$MODULE:v$PRONTO_V is already published" >&2; exit 1; fi

work=$(mktemp -d)
# The snapshot carries the repo's .mise.toml, which mise refuses to parse from an untrusted
# directory, and every tool here (python3 through its shim, crane and cue through mise exec) runs
# inside it. Nothing here needs that roster, so mise skips the snapshot's config.
export MISE_IGNORED_CONFIG_PATHS="$work${MISE_IGNORED_CONFIG_PATHS:+:$MISE_IGNORED_CONFIG_PATHS}"
trap 'kill "${serve:-}" 2>/dev/null || true; rm -rf "$work"' EXIT
mkdir "$work/pronto"
git -C "$here" archive "$SRC" | tar x -C "$work/pronto"
cd "$work/pronto"
gh api "repos/bsoneca/pronto-fork/releases/tags/mecha-v$MECHA_V" --jq '[.assets[] | {name, digest, url}]' > "$work/mecha-assets.json"
gh api "repos/bsoneca/pronto-fork/releases/tags/omnishell-v$OMNISHELL_V" --jq '[.assets[] | {name, digest, url}]' > "$work/omnishell-assets.json"
python3 -I - "$MECHA_V" "$PRONTO_V" "$OMNISHELL_V" <<'EOF'
import re, sys
mecha_v, pronto_v, omnishell_v = sys.argv[1:]
def edit(p, f):
    s = open(p).read(); t = f(s); assert t != s, p; open(p, 'w').write(t)
for dep, v in (('mecha', mecha_v), ('omnishell', omnishell_v)):
    edit('cue.mod/module.cue', lambda s: re.sub(r'("github.com/bonisoft3/' + dep + r'@v0": \{\n\t\tv:\s+)"[^"]+"', lambda m: m.group(1) + f'"v{v}"', s))
edit('distribution/config.cue', lambda s: re.sub(r'#Version:(\s+)"([^"]+)"', lambda m: f'#Version:{m.group(1)}"{pronto_v}" // was "{m.group(2)}"', s, count=1))
registry = 'github.com/bonisoft3/pronto=ghcr.io/bsoneca/cue-modules,github.com/bonisoft3/mecha=ghcr.io/bsoneca/cue-modules,github.com/bonisoft3/omnishell=ghcr.io/bsoneca/cue-modules,registry.cue.works'
edit('distribution/config.cue', lambda s: s.replace('\tmise: {\n\t\t...\n', f'\tmise: {{\n\t\t...\n\t\t// The fork\'s modules, where the fork publishes them (prerelease.sh), a default that an app sets again.\n\t\tenv: CUE_REGISTRY: *"{registry}" | string\n', 1))
EOF
# The lock bootstrap ships: the fork's pronto, mecha and omnishell, and the tools its roster adds.
python3 -I "$here/.github/fork-lock.py" "$PRONTO_V" "$MECHA_V" "$work/mecha-assets.json" "$OMNISHELL_V" "$work/omnishell-assets.json"

# The module: published to a registry crane serves on this machine, then copied to ghcr.
if ! $runtime_only; then
crane registry serve --address localhost:5051 >/dev/null 2>&1 &
serve=$!
sleep 2
git init -q && git add -A && git -c user.email=fork@local -c user.name=fork commit -qm "pronto v$PRONTO_V"
CUE_REGISTRY='github.com/bonisoft3/pronto=localhost:5051+insecure,github.com/bonisoft3/mecha=ghcr.io/bsoneca/cue-modules,github.com/bonisoft3/omnishell=ghcr.io/bsoneca/cue-modules,registry.cue.works' cue mod publish "v$PRONTO_V"
crane copy --insecure "localhost:5051/github.com/bonisoft3/pronto:v$PRONTO_V" "$MODULE:v$PRONTO_V"
kill "$serve" 2>/dev/null || true; wait "$serve" 2>/dev/null || true; serve=
fi

# The runtime: one tarball a platform, all the same tree, as mise's github backend asks for. On
# macOS, tar adds an AppleDouble ._ file beside each file for its metadata, which pronto's own lint
# then reads as source: COPYFILE_DISABLE stops it, and none is taken either way.
mkdir "$work/dist"
for triple in linux-x64 linux-arm64 linux-armv7 macos-x64 macos-arm64 windows-x64 windows-arm64; do
	COPYFILE_DISABLE=1 tar czf "$work/dist/pronto-$triple.tar.gz" -C "$work/pronto" --exclude=.git --exclude=.github --exclude=node_modules --exclude='._*' .
done
if tar tzf "$work/dist/pronto-linux-x64.tar.gz" | grep -q '/\._'; then echo "an AppleDouble file is in the runtime" >&2; exit 1; fi
if $runtime_only; then
	gh release upload "v$PRONTO_V" "$work"/dist/*.tar.gz --repo bsoneca/pronto-fork --clobber
	echo "pronto v$PRONTO_V: the release's runtime again, from $SRC"
	exit 0
fi
gh release create "v$PRONTO_V" "$work"/dist/*.tar.gz --repo bsoneca/pronto-fork --target "$SRC" --prerelease \
	--title "pronto v$PRONTO_V (fork prerelease)" --notes "Runtime of the forks' prerelease: see bsoneca/pronto forks/README.md. Published by prerelease.sh."
echo "pronto v$PRONTO_V: $MODULE:v$PRONTO_V and the release v$PRONTO_V, from $SRC"
