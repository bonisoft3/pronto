#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
.cache/venv/bin/python planner/test_planner.py
bash history/run.sh
node browser.mjs
