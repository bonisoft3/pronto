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
# ghcr.io/bsoneca/cue-modules already holds, and its runtime the fork's mecha-v$MECHA_V release.
# A repo the published bootstrap starts runs on this fork as the monorepo's apps do: its .mise.toml
# names the fork's CUE registry, and the lock bootstrap ships names this release's pronto (by URL:
# its checksum is the tarball's own, which holds the lock, so mise records it at the first install)
# and the fork's mecha.
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
gh api "repos/bsoneca/pronto-fork/releases/tags/mecha-v$MECHA_V" --jq '[.assets[] | {name, digest, url}]' > "$work/mecha-assets.json"
python3 -I - "$MECHA_V" "$PRONTO_V" "$work/mecha-assets.json" <<'EOF'
import json, re, sys
mecha_v, pronto_v, mecha_assets = sys.argv[1:]
def edit(p, f):
    s = open(p).read(); t = f(s); assert t != s, p; open(p, 'w').write(t)
edit('cue.mod/module.cue', lambda s: re.sub(r'("github.com/bonisoft3/mecha@v0": \{\n\t\tv:\s+)"[^"]+"', lambda m: m.group(1) + f'"v{mecha_v}"', s))
edit('distribution/config.cue', lambda s: re.sub(r'#Version:(\s+)"([^"]+)"', lambda m: f'#Version:{m.group(1)}"{pronto_v}" // was "{m.group(2)}"', s, count=1))
registry = 'github.com/bonisoft3/pronto=ghcr.io/bsoneca/cue-modules,github.com/bonisoft3/mecha=ghcr.io/bsoneca/cue-modules,registry.cue.works'
edit('distribution/config.cue', lambda s: s.replace('\tmise: {\n\t\t...\n', f'\tmise: {{\n\t\t...\n\t\t// The fork\'s modules, where the fork publishes them (prerelease.sh).\n\t\tenv: CUE_REGISTRY: "{registry}"\n', 1))
# The lock bootstrap ships, its pronto and mecha the fork's: every other tool is upstream's.
def block(s, tool):
    start = s.index(f'[[tools."{tool}"]]')
    nxt = s.find('\n[[tools.', start + 1)
    return start, (len(s) if nxt == -1 else nxt + 1)
def fork_lock(s):
    a, b = block(s, 'github:bonisoft3/pronto')
    pr = re.sub(r'version = "[^"]+"', f'version = "{pronto_v}"', s[a:b], count=1)
    pr = re.sub(r'https://github\.com/bonisoft3/pronto/releases/download/v[^/]+/', f'https://github.com/bsoneca/pronto-fork/releases/download/v{pronto_v}/', pr)
    pr = re.sub(r'\n(checksum|url_api) = "[^"]*"', '', pr)
    s = s[:a] + pr + s[b:]
    assets = {x['name']: x for x in json.load(open(mecha_assets))}
    a, b = block(s, 'github:bonisoft3/mecha')
    def platform(m):
        body = m.group(0)
        name = re.search(r'/(mecha-[a-z0-9-]+\.tar\.gz)"', body).group(1)
        x = assets[name]
        body = re.sub(r'checksum = "[^"]*"', f'checksum = "{x["digest"]}"', body)
        body = re.sub(r'url = "[^"]*"', f'url = "https://github.com/bsoneca/pronto-fork/releases/download/mecha-v{mecha_v}/{name}"', body)
        return re.sub(r'url_api = "[^"]*"', f'url_api = "{x["url"]}"', body)
    me = re.sub(r'version = "[^"]+"', f'version = "{mecha_v}"', s[a:b], count=1)
    me = re.sub(r'\[tools\."github:bonisoft3/mecha"\."platforms\.[a-z0-9-]+"\](?:\n[^\[\n][^\n]*)*', platform, me)
    return s[:a] + me + s[b:]
edit('bootstrap/mise.lock', fork_lock)
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
