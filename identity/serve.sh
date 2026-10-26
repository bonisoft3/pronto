#!/bin/sh
# The identity broker an operator serves for every app that embeds
# identity.#Signin, run from a checkout of pronto:
#   identity/serve.sh [env-file]          on Ory Hydra (hydra/front.ts)
#   identity/serve.sh release --project P --domain D --google-client-id C
#                                         to Cloud Run (release.nu)
# The env file (default ~/.config/pronto-identity/broker.env, never committed)
# holds BROKER_ISSUER, BROKER_SECRET and each provider's client, e.g.
# GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET. HYDRA_SECRET there encrypts
# Hydra's keys, or is derived from BROKER_SECRET; Hydra keeps its state in
# ${XDG_STATE_HOME:-~/.local/state}/pronto-identity.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
if [ "${1:-}" = release ]; then
	shift
	exec mise x nushell@0.116.1 -- nu "$here/release.nu" "$@"
fi
env_file=${1:-$HOME/.config/pronto-identity/broker.env}
[ -f "$env_file" ] || { echo "identity/serve.sh: no $env_file" >&2; exit 2; }
set -a
. "$env_file"
set +a
: "${BROKER_ISSUER:?BROKER_ISSUER is required}" "${BROKER_SECRET:?BROKER_SECRET is required}"
SECRETS_SYSTEM=${HYDRA_SECRET:-$(printf 'hydra system secret' | openssl dgst -sha256 -hmac "$BROKER_SECRET" -r | cut -c1-64)}
state=${XDG_STATE_HOME:-$HOME/.local/state}/pronto-identity
mkdir -p "$state"
DSN="sqlite://$state/hydra.sqlite?_fk=true"
export SECRETS_SYSTEM DSN
# Hydra's release with SQLite, for this machine.
case "$(uname -s)-$(uname -m)" in
	Darwin-arm64) asset=macOS_sqlite_arm64 ;;
	Darwin-x86_64) asset=macOS_sqlite_64bit ;;
	Linux-aarch64 | Linux-arm64) asset=linux_sqlite_arm64 ;;
	Linux-x86_64) asset=linux_sqlite_64bit ;;
	*) echo "identity/serve.sh: no Hydra release for $(uname -sm)" >&2; exit 2 ;;
esac
cd "$here/hydra"
exec mise x "github:ory/hydra[asset_pattern=hydra_*-$asset.tar.gz]@26.2.0" deno@2.5.0 github:f1bonacc1/process-compose@1.122.0 -- \
	process-compose --no-server -t=false -f process-compose.yaml up
