#!/bin/sh
# Publishes a prerelease of this fork from a machine, as .github/workflows/prerelease-gcp.yml did
# from Actions, which this account does not pay for: the CUE module to ghcr.io/bsoneca/cue-modules
# and the runtime tarballs as a GitHub release here, both free. No Docker: crane serves a registry
# for `cue mod publish` and copies the module out, with the ghcr.io credentials crane already holds
# (~/.docker/config.json) and gh's own login for the release.
#   ./prerelease.sh 0.24.1-gcp.25 [commit=HEAD]
#   ./prerelease.sh --runtime-only 0.24.1-gcp.25 [commit]   the runtime again, over a published
#     version's release, from the commit it was published from: its module is never touched
# The mecha module the snapshot pins is .github/prerelease.env's MECHA_V, a version
# ghcr.io/bsoneca/cue-modules already holds.
set -eu
runtime_only=false
if [ "${1:-}" = --runtime-only ]; then runtime_only=true; shift; fi
PRONTO_V=${1:?the version, such as 0.24.1-gcp.25}
here=$(cd "$(dirname "$0")" && pwd)
SRC=$(git -C "$here" rev-parse "${2:-HEAD}")
MODULE=ghcr.io/bsoneca/cue-modules/github.com/bonisoft3/pronto
MECHA_V=$(sed -n 's/^MECHA_V=\([0-9A-Za-z.-]*\)$/\1/p' "$here/.github/prerelease.env")
[ -n "$MECHA_V" ] || { echo ".github/prerelease.env names no MECHA_V" >&2; exit 1; }
mise=${SAYT_MISE_BIN:-$HOME/Library/Caches/sayt/mise-v2026.8.11/mise}
crane() { "$mise" exec 'github:google/go-containerregistry[bin=crane]@v0.20.2' -- crane "$@"; }
cue() { "$mise" exec 'github:cue-lang/cue@0.16.1' -- cue "$@"; }

# A version once published never changes (but for --runtime-only, which keeps its module).
if ! $runtime_only && crane digest "$MODULE:v$PRONTO_V" >/dev/null 2>&1; then echo "$MODULE:v$PRONTO_V is already published" >&2; exit 1; fi

work=$(mktemp -d)
trap 'kill "${serve:-}" 2>/dev/null || true; rm -rf "$work"' EXIT
mkdir "$work/pronto"
git -C "$here" archive "$SRC" | tar x -C "$work/pronto"
cd "$work/pronto"
python3 -I - "$MECHA_V" "$PRONTO_V" <<'EOF'
import re, sys
mecha_v, pronto_v = sys.argv[1:]
def edit(p, f):
    s = open(p).read(); t = f(s); assert t != s, p; open(p, 'w').write(t)
edit('cue.mod/module.cue', lambda s: re.sub(r'("github.com/bonisoft3/mecha@v0": \{\n\t\tv:\s+)"[^"]+"', lambda m: m.group(1) + f'"v{mecha_v}"', s))
edit('distribution/config.cue', lambda s: re.sub(r'#Version:(\s+)"([^"]+)"', lambda m: f'#Version:{m.group(1)}"{pronto_v}" // was "{m.group(2)}"', s, count=1))
EOF

# The module: published to a registry crane serves on this machine, then copied to ghcr.
if ! $runtime_only; then
crane registry serve --address localhost:5051 >/dev/null 2>&1 &
serve=$!
sleep 2
git init -q && git add -A && git -c user.email=fork@local -c user.name=fork commit -qm "pronto v$PRONTO_V"
CUE_REGISTRY='github.com/bonisoft3/pronto=localhost:5051+insecure,github.com/bonisoft3/mecha=ghcr.io/bsoneca/cue-modules,registry.cue.works' cue mod publish "v$PRONTO_V"
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
