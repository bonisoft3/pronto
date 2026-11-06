#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
python3 -m py_compile planner/*.py history/*.py
node --check browser.mjs
bash -n check-tools.sh setup.sh run.sh history/run.sh
