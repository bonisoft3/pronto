#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
docker compose -f "$root/compose.yaml" down --volumes
docker compose -f "$root/compose.yaml" up -d --wait
python3 "$root/probe.py"
