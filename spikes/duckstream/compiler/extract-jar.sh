#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
destination="${1:-$root/.cache/feldera-0.367.0.jar}"
image='images.feldera.com/feldera/pipeline-manager:0.367.0@sha256:42819714d16f7d5d37c17c87812ce98fb23efd2b1bfbf95b4889877f14693272'
mkdir -p "$(dirname "$destination")"
docker pull "$image"
container="$(docker create "$image")"
trap 'docker rm "$container" >/dev/null' EXIT
docker cp "$container:/home/ubuntu/feldera/build/sql2dbsp-jar-with-dependencies.jar" "$destination"
java -jar "$destination" --version
