#!/usr/bin/env bash
# Rebuild the monorepo's layout around this checkout, as copybara found it, so the tests that
# need it run (PRONTO-221). This repository is a mirror of the monorepo's plugins/pronto: copybara
# moved it to the root, renamed the monorepo's bonisoft.org/... imports to the mirrors' modules,
# staged .mirror/cue.mod as cue.mod and carried apps/idioms and llms.txt in. This script undoes
# each of those in <dest>: the checkout at plugins/pronto, its siblings (.mirror/siblings.json) at
# the commits monorepo.env pins, every mirror's cue.mod back at .mirror/cue.mod, the imports back
# on bonisoft.org, the carried files back where they came from, and the root's own module.
#
#   .github/monorepo.sh <dest>
set -euo pipefail

src=$(cd "$(dirname "$0")/.." && pwd)
dest=${1:?usage: monorepo.sh <dest>}
# shellcheck source=/dev/null
. "$src/.github/monorepo.env"

rm -rf "$dest"
mkdir -p "$dest/plugins" "$dest/libraries" "$dest/apps"
dest=$(cd "$dest" && pwd)

# The checkout as it stands (tracked and untracked files, never .git).
(cd "$src" && git ls-files -co --exclude-standard -z) | rsync -a --from0 --files-from=- "$src/" "$dest/plugins/pronto/"

sibling() { # <dir> <repository> <commit>
  git init -q "$dest/$1"
  git -C "$dest/$1" fetch -q --depth 1 "https://github.com/$2" "$3"
  git -C "$dest/$1" -c advice.detachedHead=false checkout -q FETCH_HEAD
  rm -rf "$dest/$1/.git"
}
sibling plugins/omnishell bsoneca/omnishell-fork "$OMNISHELL_REF"
sibling libraries/mecha bsoneca/mecha-fork "$MECHA_REF"
sibling plugins/sayt bonisoft3/sayt "$SAYT_REF"
sibling plugins/bayt bonisoft3/bayt "$BAYT_REF"

# mecha as the fork's prerelease publishes it (mecha-snapshot.py): pronto pins the fork's images.
mecha_v=$(sed -n 's/^MECHA_V=//p' "$src/.github/prerelease.env")
(cd "$dest/libraries/mecha" && python3 -I "$src/.github/mecha-snapshot.py" "$mecha_v")

# Carried back: copybara copied apps/idioms and llms.txt into the mirror (.mirror/carried.json).
mv "$dest/plugins/pronto/idioms" "$dest/apps/idioms"
mv "$dest/plugins/pronto/llms.txt" "$dest/llms.txt"

for dir in plugins/pronto plugins/omnishell libraries/mecha plugins/sayt plugins/bayt; do
  mkdir -p "$dest/$dir/.mirror"
  rm -rf "$dest/$dir/.mirror/cue.mod"
  mv "$dest/$dir/cue.mod" "$dest/$dir/.mirror/cue.mod"
done

# The monorepo's names for the mirrors' modules, in every CUE file outside a mirror's cue.mod.
find "$dest" -name '*.cue' -not -path '*/.mirror/*' -print0 | xargs -0 sed -i.bak -E \
  -e 's#github\.com/bonisoft3/pronto([/:"@])#bonisoft.org/plugins/pronto\1#g' \
  -e 's#github\.com/bonisoft3/omnishell([/:"@])#bonisoft.org/plugins/omnishell\1#g' \
  -e 's#github\.com/bonisoft3/sayt([/:"@])#bonisoft.org/plugins/sayt\1#g' \
  -e 's#github\.com/bonisoft3/bayt([/:"@])#bonisoft.org/plugins/bayt\1#g' \
  -e 's#github\.com/bonisoft3/mecha([/:"@])#bonisoft.org/libraries/mecha\1#g'
find "$dest" -name '*.cue.bak' -delete

# omnishell's generated vendor/mecha-client.js, which its tree does not check in: the bundle its
# package.json's bundle:mecha-client makes, from the mecha beside it.
client="$dest/libraries/mecha/packages/client"
deno bundle -q --node-modules-dir=none --no-lock --config "$client/deno.json" --platform browser \
  --format esm --minify "$client/omnishell-entry.ts" -o "$dest/plugins/omnishell/interpreter/vendor/mecha-client.js"

mkdir -p "$dest/cue.mod"
cat >"$dest/cue.mod/module.cue" <<'EOF'
module: "bonisoft.org"
language: version: "v0.16.1"
EOF
echo "monorepo: $dest"
