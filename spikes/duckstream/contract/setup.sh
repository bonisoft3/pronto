#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
bash check-tools.sh
if [[ ! -f ../compiler/.cache/feldera-0.367.0.jar ]]; then
  bash ../compiler/extract-jar.sh
fi
python3 -m venv .cache/venv
.cache/venv/bin/python -m pip install --disable-pip-version-check -r planner/requirements.txt
npm --prefix ../compiler ci
npm --prefix ../compiler exec -- playwright install chromium --only-shell
