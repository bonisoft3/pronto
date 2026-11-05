#!/bin/sh
# cue, through the machine's memory budget. One evaluation of a large spec holds tens of GB, and
# many at once (gates, generates and tests of several apps side by side) can hold more than the
# machine has: on 2026-11-05, 21 held 210 GB of a 128 GB Mac until it ran out of memory and swap.
# This file stands at the root of pronto's runtime, which mise puts on an app's PATH ahead of cue's
# own, so every `cue` an app's tooling runs through mise (generate, lint, tests, derive, write)
# comes through it, in any app, with nothing set up per app or per machine.
#
# A command that evaluates (vet, export, eval, def, cmd, trim) claims its memory from the pool's
# memory budget (cue-budget/slot.ts, the tests/slot.ts of an app, copied unchanged: `--mem`) and
# waits its turn when the budget is full, rather than failing or taking the machine down. The
# whole spec is still evaluated at once, in one process: only when it starts changes. The claim is
# what the same evaluation (the same folder of the same repository, the same arguments) held at
# its peak the last time, a quarter more, learned in ~/.cache/pronto/cue-mem; CUE_UNKNOWN_GB (24)
# the first time. One that held under CUE_DIRECT_GB (1) runs at once, outside the pool, its peak
# measured again (time) so one that grew claims from its next run; a command that evaluates
# nothing (fmt, mod, version) runs at once. On Linux with systemd, a claimed evaluation also runs
# in a scope whose memory cannot pass the budget (MemoryMax), the kernel's own ceiling; macOS has
# none, and a machine there runs a watchdog for it. cue is one process: what an evaluation holds is
# its own resident memory. A cue run by a cue is its parent's: it claims nothing. CUE_BUDGET=off
# runs every cue at once.

self=$(cd "$(dirname "$0")" && pwd)
# The real cue: the first on the PATH that is no budget wrapper (this one, a runtime's, a machine's:
# two that skipped only themselves would exec each other for ever) and no mise shim (which runs
# mise, which puts a wrapper first again); found once, and handed down.
real=$CUE_BUDGET_REAL
if [ -z "$real" ]; then
  set -f; IFS=:
  for d in $PATH; do
    case "$d" in */mise/shims) continue ;; esac
    [ -f "$d/cue" ] && [ -x "$d/cue" ] || continue
    [ "$(head -c 2 "$d/cue")" = '#!' ] && head -n 2 "$d/cue" | grep -q "^# cue, through the machine's memory budget" && continue
    real=$d/cue; break
  done
  set +f; unset IFS
  [ -n "$real" ] || { echo "cue: no cue on PATH beside the budget's wrappers ($self)" >&2; exit 127; }
  export CUE_BUDGET_REAL="$real"
fi
[ -n "$CUE_BUDGET_WRAPPED" ] && exec "$real" "$@"
export CUE_BUDGET_WRAPPED=1

case "$1" in vet|export|eval|def|cmd|trim) ;; *) exec "$real" "$@" ;; esac
[ "$CUE_BUDGET" = off ] && exec "$real" "$@"
# A container (a docker build, Cloud Build's steps, a pod) has its own memory limit and no pool.
[ -f /.dockerenv ] || [ -f /run/.containerenv ] || [ -n "$KUBERNETES_SERVICE_HOST" ] && exec "$real" "$@"

slot=$self/cue-budget/slot.ts
[ -f "$slot" ] || slot=$self/slot.ts
deno=$(command -v deno || ls "$HOME"/.local/share/mise/installs/github-denoland-deno/*/deno 2>/dev/null | tail -1)
# Best effort: without deno (an image build, a bare runner) cue runs as it would without the budget.
[ -x "$deno" ] && [ -f "$slot" ] || { echo "cue: no deno for the memory budget; running unbudgeted" >&2; exec "$real" "$@"; }

# The evaluation's name: its repository (every worktree of it alike), its folder there and its
# arguments, a temporary file's path left out; pronto's derive runs in a scratch folder named for
# its run (.pronto-derive-<hash>), one name for all of them.
where=$(git rev-parse --path-format=absolute --git-common-dir --show-prefix 2>/dev/null) || where=$(pwd)
where=$(printf '%s\n' "$where" | sed 's|\.pronto-derive-[0-9a-f]*|.pronto-derive|g')
key=$where
for a in "$@"; do
  case "$a" in /tmp/*|/private/*|/var/folders/*) a='<tmp>' ;; esac
  key="$key $a"
done
id=$(printf '%s' "$key" | md5 -q 2>/dev/null || printf '%s' "$key" | md5sum | cut -d' ' -f1)
learned="${HOME:-${TMPDIR:-/tmp}}/.cache/pronto/cue-mem/$id"
mkdir -p "${learned%/*}" 2>/dev/null || learned=/dev/null
last=$(cut -d' ' -f1 "$learned" 2>/dev/null)
mem=$(awk -v l="${last:-}" -v unknown="${CUE_UNKNOWN_GB:-24}" -v direct="${CUE_DIRECT_GB:-1}" 'BEGIN {
  if (l == "") { print unknown; exit }
  if (l + 0 < direct + 0) { print 0; exit }
  printf "%.1f\n", l * 1.25 }')

if [ "$mem" = 0 ]; then
  # Measured by time: BSD's -l (bytes) on macOS, GNU's %M (KB) elsewhere; unmeasured without one.
  if [ "$(uname)" = Darwin ]; then measure='-l' scale=1073741824
  elif /usr/bin/time -f %M -o /dev/null true 2>/dev/null; then measure='-f %M' scale=1048576
  else exec "$real" "$@"
  fi
  t=$(mktemp "${TMPDIR:-/tmp}/cue-budget.XXXXXX") || exec "$real" "$@"
  # In the background, so a signal to this wrapper reaches cue (a foreground child would defer it);
  # its stdin kept, which a background command would lose.
  if { : <&0; } 2>/dev/null; then exec 3<&0; else exec 3</dev/null; fi
  # shellcheck disable=SC2086
  /usr/bin/time $measure -o "$t" "$real" "$@" <&3 &
  pid=$!
  trap 'pkill -TERM -P "$pid" 2>/dev/null; kill -TERM "$pid" 2>/dev/null' TERM INT HUP
  wait "$pid"; code=$?
  while kill -0 "$pid" 2>/dev/null; do wait "$pid"; code=$?; done
  [ "$learned" = /dev/null ] || { awk -v s="$scale" -v what="cue $*" '/maximum resident set size/ { v = $1 } /^[0-9]+$/ { v = $1 } END { if (v != "") printf "%.2f %s\n", v / s, what }' "$t" > "$learned.$$" &&
    [ -s "$learned.$$" ] && mv "$learned.$$" "$learned"; } 2>/dev/null
  rm -f "$t" "$learned.$$" 2>/dev/null
  exit "$code"
fi

# Linux's ceiling: the budget (RAM but STACK_MEM_RESERVE, as slot.ts counts it), held by the kernel;
# never below half again what was claimed, since a lone claim larger than the budget is let run.
run=$real
if [ "$(uname)" = Linux ] && systemd-run --user --scope --quiet true 2>/dev/null; then
  ceiling=$(awk -v r="${STACK_MEM_RESERVE:-32}" -v m="$mem" '/^MemTotal:/ { g = int($2 / 1048576) - r; c = int(m * 1.5 + 0.999); print (g > c ? g : c) }' /proc/meminfo)
  set -- --user --scope --quiet -p "MemoryMax=${ceiling}G" -- "$real" "$@"
  run=systemd-run
fi
folder=$(printf '%s\n' "$where" | sed -n 2p)
exec "$deno" run -A --no-config --no-lock "$slot" --mem "$mem" --mem-learn "$learned" --what "cue ${folder:-.}" -- "$run" "$@"
