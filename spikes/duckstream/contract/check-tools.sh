#!/usr/bin/env bash
set -euo pipefail
python3 --version
java -version
javac -version
node --version
npm --version
docker version --format '{{.Server.Version}}'
