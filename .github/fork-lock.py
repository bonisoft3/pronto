# The lock bootstrap ships, as the fork's prerelease publishes it: its pronto (unless "-"), mecha and
# omnishell the fork's releases, each fork runtime by its release's own assets, and the tools the
# fork's roster adds (bootstrap/fork.lock) that the lock lacks; every other tool is upstream's.
# Run in pronto's tree:
#   python3 -I fork-lock.py <pronto_v|-> <mecha_v> <mecha-assets.json> <omnishell_v> <omnishell-assets.json>
# where each assets file is `gh api repos/bsoneca/pronto-fork/releases/tags/<tool>-v<v>
# --jq '[.assets[] | {name, digest, url}]'`. Used by prerelease.sh and by monorepo.sh, so ci tests
# the lock that is published.
import json, re, sys
pronto_v, mecha_v, mecha_assets, omnishell_v, omnishell_assets = sys.argv[1:]
LOCK = 'bootstrap/mise.lock'
def block(s, tool):
    start = s.index(f'[[tools."{tool}"]]')
    nxt = s.find('\n[[tools.', start + 1)
    return start, (len(s) if nxt == -1 else nxt + 1)
def fork_lock(s):
    if pronto_v != '-':
        a, b = block(s, 'github:bonisoft3/pronto')
        pr = re.sub(r'version = "[^"]+"', f'version = "{pronto_v}"', s[a:b], count=1)
        pr = re.sub(r'https://github\.com/bonisoft3/pronto/releases/download/v[^/]+/', f'https://github.com/bsoneca/pronto-fork/releases/download/v{pronto_v}/', pr)
        pr = re.sub(r'\n(checksum|url_api) = "[^"]*"', '', pr)
        s = s[:a] + pr + s[b:]
    # Each fork runtime by its release's own assets: one tarball a platform, named as upstream's.
    for tool, v, listed in (('mecha', mecha_v, mecha_assets), ('omnishell', omnishell_v, omnishell_assets)):
        assets = {x['name']: x for x in json.load(open(listed))}
        a, b = block(s, f'github:bonisoft3/{tool}')
        def platform(m, tool=tool, v=v, assets=assets):
            body = m.group(0)
            name = re.search(r'/(' + tool + r'-[a-z0-9-]+\.tar\.gz)"', body).group(1)
            x = assets[name]
            body = re.sub(r'checksum = "[^"]*"', f'checksum = "{x["digest"]}"', body)
            body = re.sub(r'url = "[^"]*"', f'url = "https://github.com/bsoneca/pronto-fork/releases/download/{tool}-v{v}/{name}"', body)
            return re.sub(r'url_api = "[^"]*"', f'url_api = "{x["url"]}"', body)
        me = re.sub(r'version = "[^"]+"', f'version = "{v}"', s[a:b], count=1)
        me = re.sub(r'\[tools\."github:bonisoft3/' + tool + r'"\."platforms\.[a-z0-9-]+"\](?:\n[^\[\n][^\n]*)*', platform, me)
        s = s[:a] + me + s[b:]
    return s
# The tools the fork's roster adds (bootstrap/fork.lock), each one the shipped lock lacks.
def with_fork_tools(s):
    extra = open('bootstrap/fork.lock').read()
    for m in re.finditer(r'\[\[tools\."([^"]+)"\]\][\s\S]*?(?=\n\[\[tools\.|\Z)', extra):
        if f'[[tools."{m.group(1)}"]]' not in s: s = s.rstrip('\n') + '\n\n' + m.group(0).strip('\n') + '\n'
    return s
s = open(LOCK).read()
for f in (fork_lock, with_fork_tools):
    t = f(s); assert t != s, (LOCK, f.__name__); s = t
open(LOCK, 'w').write(s)
