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
#
# A claimed evaluation weighs cores too (an evaluation keeps 1.5-6 of them busy, and on 2026-11-06
# 13.5 of 15 weight held went with a load average of 104-187): the cores it kept busy on average
# the last time, learned beside its peak (<id>.cores), 3 the first time (STACK_UNKNOWN_CORES), never
# above the budget. Inside a gate, a rehearsal or a stack (a holder above it) it is admitted at
# once, its weight added to the load; run by hand it waits for cores in line like any job.
#
# Every claimed vet and every export leaves one line in ~/.cache/pronto/cue-cache.log (rotated at 10 MB to
# cue-cache.log.1), tab-separated: epoch seconds, kind (vet|export), outcome (hit, partial, miss or
# unkeyed), the folder, the seconds the evaluation took (0 for a hit; the wait in the pool included) and
# the seconds a hit saved (what the entries it used took when they were stored). The dashboard reads it
# (tools/machine). Best effort: it never changes an exit code or what is printed.

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
# arguments. One evaluation keeps one id in any worktree, runner checkout or temporary copy: an id
# never seen claims CUE_UNKNOWN_GB and waits in the cue lock, so a name that changes with the
# checkout's path or a random temporary folder made thousands of small evaluations queue as large
# ones (PRONTO-683). So an argument that is a path in a git checkout (or where a file will be
# written in one) is named by its repository and its place in it; a CI runner's clone, a
# repository of its own whose path holds /actions-runners/<name>/_work/, is named by what follows
# _work/; a temporary folder's random name (a . or - and 6 or more letters and digits holding a
# digit or both cases, or 8 or more of them holding a digit and a letter, alone) is left out, so
# /tmp/tmp.gzTXAbh1M8/x is <tmp>/tmp/x and /tmp/pronto-plugins/x stays itself, as is the random middle
# of a file directly in it (mktemp's roles.XXXXXX.json); and pronto's derive, which runs in a
# scratch folder named for its run (.pronto-derive-<hash>), has one name for all of them.
# tmpnorm <path>: the path with its runner clone or temporary folder's name rewritten.
tmpnorm() {
  case $1 in
    */actions-runners/*/_work/*) printf '%s' "<runner>/${1#*/_work/}"; return ;;
  esac
  rest=
  case $1 in
    /private/var/folders/*/*/T/*|/var/folders/*/*/T/*) rest=${1#*/folders/*/*/T/} ;;
    /private/tmp/*) rest=${1#/private/tmp/} ;;
    /tmp/*) rest=${1#/tmp/} ;;
    *) t=${TMPDIR%/}; [ -n "$t" ] && case $1 in "$t"/*) rest=${1#"$t"/} ;; esac ;;
  esac
  [ -n "$rest" ] || { printf '%s' "$1"; return; }
  first=${rest%%/*}; tail=${rest#"$first"}; name=$first
  suffix=${first##*[.-]}
  if [ "$suffix" != "$first" ]; then
    case $suffix in
      *[!A-Za-z0-9]*|?|??|???|????|?????) ;;
      *[0-9]*) name=${first%?"$suffix"} ;;
      *[A-Z]*) case $suffix in *[a-z]*) name=${first%?"$suffix"} ;; esac ;;
    esac
  else
    case $first in
      *[!A-Za-z0-9]*|?|??|???|????|?????|??????|???????) ;;
      *[0-9]*) case $first in *[A-Za-z]*) name='<rand>' ;; esac ;;
    esac
  fi
  # A file of `mktemp -t <name>.XXXXXX.<ext>` (release.nu's roles and pushed lists) has its random
  # part in the middle: roles.c4qN0s.json is <tmp>/roles.json (PRONTO-736).
  if [ -z "$tail" ] && [ "$name" = "$first" ]; then
    case $first in
      *.*.*)
        mid=${first#*.}; mid=${mid%.*}
        case $mid in
          *[!A-Za-z0-9]*|?|??|???|????|?????) ;;
          *[0-9]*) name="${first%%.*}.${first##*.}" ;;
          *[A-Z]*) case $mid in *[a-z]*) name="${first%%.*}.${first##*.}" ;; esac ;;
        esac ;;
    esac
  fi
  printf '%s' "<tmp>/$name$tail"
}
where=$(git rev-parse --path-format=absolute --git-common-dir --show-prefix 2>/dev/null) || where=$(pwd)
where=$(printf '%s\n' "$where" | sed 's|\.pronto-derive-[0-9a-f]*|.pronto-derive|g')
first=${where%%
*}
key=$(tmpnorm "$first")${where#"$first"}
# pathnorm <absolute path>: prints it normalised; run in $(...) so its variables stay its own.
# A bare absolute argument is named so, and so is the value of an equals-form flag (--outfile=/abs/out.json).
pathnorm() {
  a=$1
  d=$a; [ -d "$a" ] || d=${a%/*}
  # git names the real path (/private/var/..), the argument may name a link to it.
  if [ -d "${d:-/}" ] && dp=$(cd "${d:-/}" 2>/dev/null && pwd -P); then
    a=${dp%/}${a#"$d"}; [ -n "$a" ] || a=/
    g=$(git -C "$dp" rev-parse --path-format=absolute --git-common-dir --show-toplevel 2>/dev/null) || g=
    if [ -n "$g" ]; then
      top=${g#*
}
      case "$a" in "$top"|"$top"/*) rel=${a#"$top"}; a="${g%%
*}:${rel#/}" ;; esac
    fi
  fi
  tmpnorm "$a"
}
for a in "$@"; do
  case "$a" in
    /*) a=$(pathnorm "$a") ;;
    # Only a flag whose whole value is a path: --inject=k=/x is CUE's value, not a file.
    -*=/*) flag=${a%%=*}; val=${a#*=}; case $val in /*) a="$flag=$(pathnorm "$val")" ;; esac ;;
  esac
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

folder=$(printf '%s\n' "$where" | sed -n 2p)

# cachelog <kind> <outcome> <seconds took> <seconds saved>: one line of the cache log, best effort.
cachelog() {
  { lf=${HOME:-${TMPDIR:-/tmp}}/.cache/pronto/cue-cache.log
    mkdir -p "${lf%/*}"
    sz=$(wc -c < "$lf" 2>/dev/null | tr -d ' ')
    [ "${sz:-0}" -gt 10485760 ] && mv -f "$lf" "$lf.1"
    printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$(date +%s)" "$1" "$2" "${folder:-.}" "$3" "$4" >> "$lf"
  } 2>/dev/null
  return 0
}
logkind=; outcome=unkeyed; saved=0
vetted=$self/cue-budget/vetted.ts
[ -f "$vetted" ] || vetted=$self/vetted.ts

# An export whose inputs are those of one that passed before, anywhere on this machine, prints what that
# one printed, without evaluating, whatever it holds (claimed or run at once): vetted.ts keys it the same
# way as a vet (with its tags, its expression and its format), and keeps what a passing export printed in
# ~/.cache/pronto/cue-exported. The output is always written here, from the cache or from cue: what a
# reader saves from it is this checkout's. One that writes a file (-o) or can't be keyed runs as asked;
# CUE_EXPORTED=off exports every time. A hit costs a deno start (0.1-0.2 s), so an export run at once that
# took less CPU than CUE_REPLAY_MIN_S (0.3 s) the last time (learned beside its peak, <id>.secs) is
# evaluated, never looked up.
exportpath=
replay=1
if [ "$mem" = 0 ]; then
  replay=$(awk -v s="$(cat "$learned.secs" 2>/dev/null)" -v min="${CUE_REPLAY_MIN_S:-0.3}" 'BEGIN { print (s == "" || s + 0 >= min + 0) ? 1 : 0 }')
fi
if [ "$1" = export ] && [ "$CUE_EXPORTED" != off ] && [ -f "$vetted" ] && [ "$replay" = 1 ]; then
  logkind='export'
  keyed=$("$deno" run -A --no-config --no-lock "$vetted" export-key "$real" "$@" 2>/dev/null); erc=$?
  exportpath=$(printf '%s\n' "$keyed" | sed -n 1p)
  if [ "$erc" = 0 ] && cat "$exportpath" 2>/dev/null; then
    echo "cue: export of ${folder:-.} ($*) printed from a passing export with these same inputs; not evaluated again" >&2
    saved=$(printf '%s\n' "$keyed" | sed -n 2p)
    cachelog export hit 0 "${saved:-0}"
    exit 0
  fi
  [ "$erc" = 1 ] || exportpath=
  [ -n "$exportpath" ] && outcome=miss
  [ -n "$exportpath" ] && exportargs=$(printf '%s\n' "$@")
fi

# exportstore <exit code> <seconds>: prints what the export at $out printed, keeps it when it passed, logs it.
exportstore() {
  cat "$out"
  if [ "$1" = 0 ]; then
    set -f; IFS='
'
    # shellcheck disable=SC2086
    CUE_RUN_SECS=$2 "$deno" run -A --no-config --no-lock "$vetted" export-store "$real" "$exportpath" "$out" $exportargs 2>/dev/null
    unset IFS; set +f
  fi
  rm -f "$out"
}

if [ "$mem" = 0 ]; then
  # Measured by time: BSD's -l (bytes) on macOS, GNU's %M (KB) elsewhere, with the seconds it took and
  # the CPU it used; unmeasured without one.
  if [ "$(uname)" = Darwin ]; then measure='-l' scale=1073741824
  elif /usr/bin/time -f '%M %e %U %S' -o /dev/null true 2>/dev/null; then measure='-f %M %e %U %S' scale=1048576
  elif [ -z "$exportpath" ]; then exec "$real" "$@"
  else measure=
  fi
  t=$(mktemp "${TMPDIR:-/tmp}/cue-budget.XXXXXX") || exec "$real" "$@"
  if [ -n "$exportpath" ]; then out=$(mktemp "${TMPDIR:-/tmp}/cue-export.XXXXXX") || exportpath=; fi
  # In the background, so a signal to this wrapper reaches cue (a foreground child would defer it);
  # its stdin kept, which a background command would lose.
  if { : <&0; } 2>/dev/null; then exec 3<&0; else exec 3</dev/null; fi
  started=$(date +%s)
  if [ -z "$measure" ]; then
    if [ -n "$exportpath" ]; then "$real" "$@" <&3 >"$out" & else "$real" "$@" <&3 & fi
  elif [ "$measure" = -l ]; then
    if [ -n "$exportpath" ]; then /usr/bin/time -l -o "$t" "$real" "$@" <&3 >"$out" & else /usr/bin/time -l -o "$t" "$real" "$@" <&3 & fi
  else
    if [ -n "$exportpath" ]; then /usr/bin/time -f '%M %e %U %S' -o "$t" "$real" "$@" <&3 >"$out" & else /usr/bin/time -f '%M %e %U %S' -o "$t" "$real" "$@" <&3 & fi
  fi
  pid=$!
  trap 'pkill -TERM -P "$pid" 2>/dev/null; kill -TERM "$pid" 2>/dev/null' TERM INT HUP
  wait "$pid"; code=$?
  while kill -0 "$pid" 2>/dev/null; do wait "$pid"; code=$?; done
  # Its peak (GB) into the learned file, its CPU seconds beside it (<id>.secs), its seconds for the store.
  measured=$(awk -v s="$scale" '/maximum resident set size/ { v = $1 } / real / { r = $1; c = $3 + $5 } /^[0-9]+ [0-9.]+ [0-9.]+ [0-9.]+$/ { v = $1; r = $2; c = $3 + $4 } END { if (v != "") printf "%.2f %.2f %.2f\n", v / s, r, c }' "$t" 2>/dev/null)
  if [ -n "$measured" ] && [ "$learned" != /dev/null ]; then
    { printf '%s cue %s\n' "${measured%% *}" "$*" > "$learned.$$" && mv "$learned.$$" "$learned"
      printf '%s\n' "${measured##* }" > "$learned.secs.$$" && mv "$learned.secs.$$" "$learned.secs"; } 2>/dev/null
  fi
  rm -f "$t" "$learned.$$" "$learned.secs.$$" 2>/dev/null
  if [ -n "$exportpath" ]; then
    took=$(printf '%s\n' "$measured" | awk '{ print $2 }')
    [ -n "$took" ] || took=$(( $(date +%s) - started ))
    exportstore "$code" "$took"
    cachelog export miss "$took" 0
  fi
  exit "$code"
fi


# A claimed vet re-vets only what changed: vetted.ts cuts it into its packages, each keyed by every
# file vetting it reads (its CUE, its parents', its imports', their embeds, cue.mod) and the cue that
# vets, and a package whose key passed before, anywhere on this machine (another worktree, a ci
# runner, main after the merge), is not evaluated again. What passes records its keys. A vet that
# can't be keyed runs as asked; CUE_VETTED=off vets every time.
plan=
if [ "$1" = vet ] && [ "$CUE_VETTED" != off ] && [ -f "$vetted" ]; then
  logkind=vet
  if plan=$("$deno" run -A --no-config --no-lock "$vetted" plan "$real" "$@" 2>/dev/null); then
    saved=$(printf '%s\n' "$plan" | sed -n 's/^saved //p'); saved=${saved:-0}
    if ! printf '%s\n' "$plan" | grep -q '^key '; then
      echo "cue: vet of ${folder:-.} passed before with these same inputs; not evaluated again" >&2
      cachelog vet hit 0 "$saved"
      exit 0
    fi
    outcome=miss
    keys=$(printf '%s\n' "$plan" | sed -n 's/^key //p')
    runargs=$(printf '%s\n' "$plan" | sed -n 's/^run //p')
    set -f; IFS='
'
    # shellcheck disable=SC2086
    set -- $runargs
    unset IFS; set +f
    skipped=$(printf '%s\n' "$plan" | sed -n 's/^skipped //p')
    if [ "${skipped:-0}" != 0 ]; then
      outcome=partial
      echo "cue: vet of ${folder:-.}: $skipped packages passed before with these same inputs; vetting only $*" >&2
      # A part of the vet: its peak is not what the whole vet holds, so it teaches the claim nothing.
      learned=/dev/null
    fi
  else
    plan=
  fi
fi
# Linux's ceiling: the budget (RAM but STACK_MEM_RESERVE, as slot.ts counts it), held by the kernel;
# never below half again what was claimed, since a lone claim larger than the budget is let run.
run=$real
if [ "$(uname)" = Linux ] && systemd-run --user --scope --quiet true 2>/dev/null; then
  ceiling=$(awk -v r="${STACK_MEM_RESERVE:-32}" -v m="$mem" '/^MemTotal:/ { g = int($2 / 1048576) - r; c = int(m * 1.5 + 0.999); print (g > c ? g : c) }' /proc/meminfo)
  set -- --user --scope --quiet -p "MemoryMax=${ceiling}G" -- "$real" "$@"
  run=systemd-run
fi

[ -z "$plan" ] && [ -z "$exportpath" ] && [ -z "$logkind" ] && exec "$deno" run -A --no-config --no-lock "$slot" --mem "$mem" --mem-learn "$learned" --cores-learn "$learned.cores" --what "cue ${folder:-.}" -- "$run" "$@"

# In the background, so a signal to this wrapper reaches the claim (as above), and its pass recorded.
if { : <&0; } 2>/dev/null; then exec 3<&0; else exec 3</dev/null; fi
cores=$learned.cores; [ "$learned" = /dev/null ] && cores=/dev/null
started=$(date +%s)
if [ -n "$exportpath" ]; then
  # What cue prints, kept to store once it passed, then printed.
  out=$(mktemp "${TMPDIR:-/tmp}/cue-export.XXXXXX") || exec "$deno" run -A --no-config --no-lock "$slot" --mem "$mem" --mem-learn "$learned" --cores-learn "$cores" --what "cue ${folder:-.}" -- "$run" "$@" <&3
  "$deno" run -A --no-config --no-lock "$slot" --mem "$mem" --mem-learn "$learned" --cores-learn "$cores" --what "cue ${folder:-.}" -- "$run" "$@" <&3 >"$out" &
else
  "$deno" run -A --no-config --no-lock "$slot" --mem "$mem" --mem-learn "$learned" --cores-learn "$cores" --what "cue ${folder:-.}" -- "$run" "$@" <&3 &
fi
pid=$!
trap 'kill -TERM "$pid" 2>/dev/null' TERM INT HUP
wait "$pid"; code=$?
while kill -0 "$pid" 2>/dev/null; do wait "$pid"; code=$?; done
took=$(( $(date +%s) - started ))
if [ -n "$exportpath" ]; then
  exportstore "$code" "$took"
elif [ "$code" = 0 ] && [ -n "$plan" ]; then
  set -f; IFS='
'
  # shellcheck disable=SC2086
  printf '%s\n' "$keys" | CUE_RUN_SECS=$took "$deno" run -A --no-config --no-lock "$vetted" record "$real" $runargs 2>/dev/null
  unset IFS; set +f
fi
# A partial vet saved what the packages it skipped took; a miss or an unkeyed one saved nothing.
[ "$outcome" = partial ] || saved=0
cachelog "$logkind" "$outcome" "$took" "$saved"
exit "$code"
