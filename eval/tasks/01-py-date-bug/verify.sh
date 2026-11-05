#!/usr/bin/env bash
# Run from the workspace root after hidden/ has been copied in.
set -euo pipefail
export PYTHONDONTWRITEBYTECODE=1
python3 -m unittest discover -s tests
