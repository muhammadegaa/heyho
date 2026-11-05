#!/usr/bin/env bash
# Run from the workspace root after hidden/ has been copied in.
# Passes when the tests pass and the old name no longer appears as a whole word
# in any .py file (grep -w treats "_" as part of a word, so parse_qty_range is allowed).
set -euo pipefail
export PYTHONDONTWRITEBYTECODE=1
python3 -m unittest discover -s tests
if grep -rnw --include='*.py' 'parse_qty' .; then
    echo "verify: the old name parse_qty is still used (see above)" >&2
    exit 1
fi
