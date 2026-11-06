#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
python3 -m venv .venv
.venv/bin/python -m pip install --disable-pip-version-check -r ../../compiler/requirements.txt
exec .venv/bin/python probe.py "$@"
