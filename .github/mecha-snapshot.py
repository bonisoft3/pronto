# A mecha-fork tree as the fork's prerelease snapshots it: its toolchain names the prerelease's own
# version (the runtime mise installs as github:bonisoft3/mecha is that prerelease too), and its pins
# admit the fork's images beside upstream's Docker Hub ones (forks/publish.sh's admit), so a pronto
# that pins the fork's auth image vets. Run in the tree: python3 -I mecha-snapshot.py <version>.
# Used by workflows/prerelease-mecha.yml and by monorepo.sh, so ci tests the tree that is published.
import re, sys
v = sys.argv[1]
p = 'toolchain/tools.cue'
s = open(p).read()
t = re.sub(r'("github:bonisoft3/mecha":\s+)"[^"]+"', lambda m: m.group(1) + f'"{v}"', s, count=1)
assert t != s, p
open(p, 'w').write(t)
p = 'published.cue'
s = open(p).read()
for old, new in [
    ('import "strings"\n\n', ''),
    ('#Pin: =~"^bonitao/mecha-', '#Pin: =~"^(bonitao|ghcr\\\\.io/bsoneca)/mecha-'),
    ('#Pin & strings.HasPrefix("bonitao/mecha-\\(s):")', '#Pin & =~"^(bonitao|ghcr\\\\.io/bsoneca)/mecha-\\(s):"'),
]:
    assert old in s, (p, old)
    s = s.replace(old, new)
open(p, 'w').write(s)
