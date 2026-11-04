#!/bin/sh
set -eu
cd "$(dirname "$0")"
cue vet -c schema.cue example.cue
for fixture in valid/*.cue; do
 cue vet -c schema.cue "$fixture"
done
for fixture in invalid/*.cue; do
 if cue vet -c schema.cue "$fixture" >/dev/null 2>&1; then
  printf 'unexpectedly accepted %s\n' "$fixture" >&2
  exit 1
 fi
done
