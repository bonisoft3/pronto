#!/bin/sh
# One generate at a time in a checkout. Run as the first rule of every app's
# generate (distribution/config.cue, "generate-lock"): it waits until no other
# generate holds this checkout's lock, then leaves a holder behind that keeps
# the lock until the generate it ran in has ended, its last rule included. A
# stack's `launch --watch`, a gate and a hand `./saytw generate` all come
# through here, so two never write the same files at once (a docker/Caddyfile
# read half-written lost its routes, 2026-11-07).
#
# The generate is the `task-leaf generate` process above this one (sayt runs
# every rule under it), else the nearest go-task. With neither, as in a
# container, there is nothing to hold and it returns at once. A generate
# started inside one that holds the lock (an ancestor is the owner) is part of
# it and does not wait. The lock is lockf(1) on macOS and flock(1) on Linux,
# both released by the kernel when the holder dies, however it dies.
lock=${1:-.task/bayt/generate.lock}
owner=$lock.owner

field() { ps -o "$1=" -p "$2" 2>/dev/null | sed 's/^ *//'; }

# The generate's own process, walking up from this rule.
root=
pid=$$
while [ -n "$pid" ] && [ "$pid" -gt 1 ]; do
  cmd=$(field command "$pid")
  case "$cmd" in
    *task-leaf.nu*task-leaf\ generate*|*"task-leaf generate"*) root=$pid; break ;;
  esac
  case "$(basename "$(field comm "$pid")")" in
    task) [ -z "$task" ] && task=$pid ;;
  esac
  pid=$(field ppid "$pid")
done
[ -n "$root" ] || root=$task
[ -n "$root" ] || exit 0

# Nested: an ancestor already owns the lock.
held=$(cat "$owner" 2>/dev/null)
if [ -n "$held" ]; then
  pid=$$
  while [ -n "$pid" ] && [ "$pid" -gt 1 ]; do
    [ "$pid" = "$held" ] && exit 0
    pid=$(field ppid "$pid")
  done
fi

mkdir -p "$(dirname "$lock")"
ready=$lock.ready.$$
hold="echo $root > '$owner'; : > '$ready'; while kill -0 $root 2>/dev/null; do sleep 0.2; done; rm -f '$owner'"
if command -v flock >/dev/null 2>&1; then
  nohup flock "$lock" sh -c "$hold" </dev/null >/dev/null 2>&1 &
elif command -v lockf >/dev/null 2>&1; then
  nohup lockf -k "$lock" sh -c "$hold" </dev/null >/dev/null 2>&1 &
else
  echo "generate-lock: neither flock nor lockf on PATH, so two generates here could write the same files at once" >&2
  exit 1
fi
holder=$!

# Said once, as soon as another generate is seen owning the lock: never after a count of turns,
# which a loaded machine stretches past the other's whole hold (the wait then went unsaid).
said=
while [ ! -e "$ready" ]; do
  kill -0 "$holder" 2>/dev/null || { echo "generate-lock: the lock's holder ended before it held $lock" >&2; exit 1; }
  if [ -z "$said" ]; then
    other=$(cat "$owner" 2>/dev/null)
    if [ -n "$other" ] && [ "$other" != "$root" ]; then
      echo "generate-lock: another generate is running in this checkout (pid $other); waiting for it to end" >&2
      said=1
    fi
  fi
  sleep 0.05
done
rm -f "$ready"
