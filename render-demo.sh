#!/usr/bin/env bash
# Montagent demo renderer — convenience wrapper around `montagent demo`.
# Renders the curated zero-key Remotion demos (no API keys required).
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "$DIR/bin/montagent" demo "$@"
