#!/bin/sh
# The broker on Hydra as two of an app's own processes under launch@local, so
# a local test brings up everything sign-in needs:
#   local.sh hydra   Hydra in memory, its public and admin APIs on loopback
#   local.sh front   the front, at http://localhost:28443, the broker's issuer
# Run under the app's own toolchain (deno, mise). With the operator's broker env file
# (~/.config/pronto-identity/broker.env, or PRONTO_IDENTITY_ENV) it signs in
# through the operator's Google client; without it, through the stand-in for
# Google (fake.ts). Either way the issuer is the one identity.#Signin names by
# default, so the port is the operator's standalone broker's: run one or the other.
set -eu
here=$(cd "$(dirname "$0")/.." && pwd)
env_file=${PRONTO_IDENTITY_ENV:-$HOME/.config/pronto-identity/broker.env}
if [ -f "$env_file" ]; then
	set -a
	. "$env_file"
	set +a
fi
if [ -z "${GOOGLE_CLIENT_ID:-}" ]; then BROKER_FAKE_GOOGLE=1; fi
BROKER_ISSUER=http://localhost:28443
# A launch's own secrets: a subject it vouches for is a test's, and Hydra's
# keys live as long as the process.
BROKER_SECRET=${BROKER_SECRET:-pronto-identity-local-launch-secret-0000}
export BROKER_ISSUER BROKER_SECRET BROKER_FAKE_GOOGLE
HYDRA_PUBLIC=http://127.0.0.1:28453
HYDRA_ADMIN=http://127.0.0.1:28455
export HYDRA_PUBLIC HYDRA_ADMIN

case "${1:-}" in
hydra)
	# Hydra's release with SQLite, which its in-memory store is, for this machine.
	case "$(uname -s)-$(uname -m)" in
		Darwin-arm64) asset=macOS_sqlite_arm64 ;;
		Darwin-x86_64) asset=macOS_sqlite_64bit ;;
		Linux-aarch64 | Linux-arm64) asset=linux_sqlite_arm64 ;;
		Linux-x86_64) asset=linux_sqlite_64bit ;;
		*) echo "pronto-identity: no Hydra release for $(uname -sm)" >&2; exit 2 ;;
	esac
	DSN=memory SECRETS_SYSTEM=pronto-identity-local-launch-hydra-0000 LOG_LEVEL=warn \
		URLS_SELF_ISSUER=$BROKER_ISSUER URLS_LOGIN=$BROKER_ISSUER/login URLS_CONSENT=$BROKER_ISSUER/consent \
		SERVE_PUBLIC_HOST=127.0.0.1 SERVE_PUBLIC_PORT=28453 SERVE_ADMIN_HOST=127.0.0.1 SERVE_ADMIN_PORT=28455 \
		OAUTH2_PKCE_ENFORCED_FOR_PUBLIC_CLIENTS=true TTL_ID_TOKEN=5m \
		exec mise x "github:ory/hydra[asset_pattern=hydra_*-$asset.tar.gz]@26.2.0" -- hydra serve all --dev
	;;
front)
	exec deno run --no-config --allow-net --allow-env "$here/hydra/front.ts"
	;;
*)
	echo "usage: local.sh hydra|front" >&2
	exit 2
	;;
esac
