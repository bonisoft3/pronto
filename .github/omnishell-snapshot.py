# An omnishell-fork tree as the fork's prerelease snapshots it: its toolchain names the prerelease's
# own version, since the runtime mise installs as github:bonisoft3/omnishell is that prerelease too.
# Run in the tree: python3 -I omnishell-snapshot.py <version>. Used by
# workflows/prerelease-omnishell.yml and by monorepo.sh, so ci tests the tree that is published.
import re, sys
v = sys.argv[1]
p = 'toolchain/tools.cue'
s = open(p).read()
t = re.sub(r'("github:bonisoft3/omnishell":\s+)"[^"]+"', lambda m: m.group(1) + f'"{v}"', s, count=1)
assert t != s, p
open(p, 'w').write(t)
