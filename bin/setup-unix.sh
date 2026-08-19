#!/usr/bin/env sh
# macOS/Linux bootstrap wrapper. The Node CLI owns all path and venv logic.
set -eu
entry=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)/dsh-loom.mjs
exec node "$entry" setup "$@"
