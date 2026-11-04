#!/bin/sh
set -eu
cd "$(dirname "$0")"
deno() { mise exec github:denoland/deno@v2.9.7 -- deno "$@"; }
case "${1:?gate required}" in
  build)
    (cd portability; deno task --frozen-lockfile build; deno check --frozen *.ts)
    (cd catalogue; deno check --frozen *.ts)
    (cd routing; deno check --no-config --no-lock test.ts)
    ;;
  lint)
    (cd portability; deno fmt --check *.ts *.js *.cjs deno.json package.json; deno lint *.ts)
    (cd catalogue; deno task --frozen-lockfile check)
    (cd routing; deno fmt --check test.ts; deno lint --no-config test.ts)
    ;;
  test)
    (cd portability; deno task --frozen-lockfile test; deno test --frozen --allow-read --allow-env package_test.js)
    mise exec github:cue-lang/cue@v0.16.1 -- ./declaration/test.sh
    ;;
  integrate)
    (cd catalogue; deno task --frozen-lockfile test; deno task --frozen-lockfile test:isolation)
    (cd routing; deno test --no-config --no-lock --allow-run=docker --allow-net --allow-read --allow-write test.ts)
    ;;
  *) printf 'unknown gate: %s\n' "$1" >&2; exit 1 ;;
esac
